# Testing standard

How repos that use devkit test. The lint rules that enforce part of it are in
[the lint and format standard](lint-format.md).

## What a test proves

- The behaviour callers depend on, where a regression would show: the requests a client sends,
  output formats, stored data, route and CLI contracts, errors returned.
- Each test names the behaviour it protects, and a believable bug in that behaviour makes it
  fail. A test that stays green when the behaviour breaks, or fails on a harmless refactor,
  proves nothing.
- One test owns each contract: the strongest one. Before adding a test for a fix, find the owner
  and strengthen it; write a new test only when nothing owns the contract.
- No assertion that another assertion already implies, no second test of the same contract, and
  no test that restates the implementation: the same constants, the same branches, the internal
  calls it makes.
- Removing and consolidating tests is a normal part of a change, not a risk to avoid. The only
  test of a contract goes only together with its replacement.
- No tests that only check that a module imports, a name is exported or a type compiles. The
  same goes for Python.
- Tests run offline and use made-up data. Live tests are opt-in, selected by a file suffix, and
  read their credentials from the environment.

## Layout

- JS and TS tests sit beside their code as `<subject>.test.ts`. Scripts select
  `.e2e.test.ts` and `.integration.test.ts` by suffix.
- Test data is `<subject>.fixture.ts`, shared helpers are `<subject>.test-utils.ts`, and a
  package-wide harness lives in `test/` (not `tests/` or `__tests__/`).
- Python tests follow the project's pytest or unittest layout.

## Real implementations first

Use the first of these that works:

1. The real module.
2. A local real substitute: SQLite or libsql in memory or in a temp file at the latest
   migration, a `mkdtemp` directory, an in-process handler called with `new Request(...)`, or a
   local `Bun.serve({ port: 0 })` for a configurable endpoint.
3. [MSW](https://mswjs.io) 2.x for third-party HTTP, with `onUnhandledRequest: "error"`. A
   request the test did not expect then fails it, so "no call was made" needs no spy. msw 3
   does not intercept `fetch` under Bun 1.4.
4. A fake, only at a true external boundary with no offline server and no HTTP seam: a binary
   protocol client, a native module the runtime can't load, a framework compile-time
   transform. List it in `.oxlintrc.json` and in the pull request that adds it.

A fake follows only the provider's documented contract (statuses, headers, limits), is
deterministic for its inputs and clock, gets its behaviour when it is built, and is passed in
through parameters, never by patching globals. Library clients take `baseUrl`, `fetch`,
credentials and a clock as parameters and read no environment; code that touches storage takes
the database as a parameter.

## Doubles

- Spies only observe: `spyOn(console, "error")` with no implementation still records calls.
  Never replace a method to silence output.
- `landmines-testing/no-test-doubles` sees Vitest and Jest doubles and any `.mockImplementation`
  chain. It does not see `bun:test`'s `mock(impl)`, or `jest` and `vi` imported from
  `bun:test`; those follow the same rule in review. `mock.module` is linted separately.
- `mock.module` replaces a module for the whole test process, and `mock.restore()` does not
  undo it. A listed `mock.module` exception runs with `bun test --isolate` (`--parallel` implies
  it), spreads the real exports into the factory and replaces only what the boundary needs.

## Time and waiting

- Control time with `setSystemTime()` or fake timers and reset them after the test. Never assign
  `Date.now` or `setTimeout`.
- Await the operation itself, or a deferred from `Promise.withResolvers()`. Latency inside a
  fake or a local test server is also a deferred the test resolves, never a sleep.
- No fixed sleeps, retries or raised timeouts, and no `setDefaultTimeout`. Split CPU-bound
  sweeps with `test.each`, and run slow shared setup once in `beforeAll`. `--retry` and
  `--rerun-each` never go in scripts; a suite-wide `--timeout` is allowed only in a dedicated
  e2e script.

## State

- Tests never read or write real user state: config directories, keychains, licence or
  account files, real databases. A test preload (`bunfig.toml` `[test] preload`, or a pytest
  conftest) points every state directory at a temp dir, turns telemetry off and refuses to run
  when production database or API variables are set.
- In CI, `TMPDIR` is the runner's temp dir (`ci-bun` and `ci-python` set it).

## Parallel by default

- Suites run in parallel workers: `bun test --parallel`, `pytest -n auto` with pytest-xdist
  (`uv run --with pytest-xdist pytest -q -n auto`, or `test-with: pytest-xdist` in `ci-python`),
  `go test ./...` as it is. The `test` script or documented test command is the parallel one, so
  local runs and CI match. Tests pass in any order and on any worker.
- Other files run at the same time, so every test owns its state: a temp dir from `mkdtemp`
  (`tmp_path` in pytest, `t.TempDir()` in Go), a server on port 0 that the test asks for its real
  port (`Bun.serve({ port: 0 })`, `httptest.NewServer`), its own database file and its own
  environment. No fixed paths, fixed ports or output files that two tests share. A preload or
  conftest that moves state to a temp dir makes a new one with `mkdtemp` each time it runs and
  removes it afterwards: in the system temp dir, never a fixed folder or one in the checkout.
- `bun test --parallel` implies `--isolate`: each file gets fresh globals and modules, and runs
  its preload again. Files share only what is outside the process, such as files, ports and
  databases.
- When a few files are much slower than the rest, `--timings=test-timings.json` in the script
  makes `--parallel` start them first. Commit the file and refresh it with `--update-timings`
  after big test changes; a stale entry only costs speed.
- pytest-xdist workers are separate processes: a session-scoped fixture runs once per worker.
  Work that must happen once per run, such as a build, runs before pytest. Debug one test
  serially with `-n 0`.
- A test that relies on a warm-up an earlier test did in the same process, such as a loaded
  model or a filled cache, fails when it is a worker's first test. Load it in a session-scoped
  fixture or `beforeAll` that the test uses; never raise the test's timeout.
- Go runs packages in parallel processes. Tests inside a package run one at a time unless they
  call `t.Parallel()`, which `t.Setenv` and `t.Chdir` refuse; CPU-bound tests, such as sweeps
  over many inputs, call it. Under `-race`, set `GORACE=atexit_sleep_ms=0`: otherwise every test
  binary, and every copy of it a test runs as a fake command, sleeps a second as it exits.
- Workers share the CPU, so a test that runs a heavy tool in its body, such as a compiler or a
  linter, slows down under them and can hit the test timeout. Run the tool once in `beforeAll`
  with its time budget and assert the result in the tests.
- A test that fails only in parallel shares state with another test. Make it own its state;
  never exclude it, mark it serial or rerun it.
- A shared resource that can't be per test, such as a server that is slow to start, is one per
  worker, named after `BUN_TEST_WORKER_ID` or `PYTEST_XDIST_WORKER`.

## Cleanup campaign

A repo-wide test cleanup, one subsystem at a time. Hand this section to whoever runs it.

1. Record the starting point from real CI runs: the test step's time, the number of tests and
   the lines of test code.
2. Pick one subsystem. Read its production code first, then its tests, and name its contracts:
   what callers, users and stored data depend on.
3. Keep a ledger outside the repo, one line per test: the contract it protects, a believable bug
   it catches, and a verdict. The verdict is keep (the owner), merge into the owner, fix, or
   delete as a duplicate, implied, a restatement of the code or proof of nothing.
4. Keep the strongest test as each contract's owner and move what the others add into it. A
   contract without a test gets one; a weak owner is strengthened before anything else goes.
5. Prove each owner: break the behaviour in the production code, watch the owner fail, restore
   the code. A test that stays green is fixed or deleted.
6. Never delete the only guard of a contract, and never choose tests by their runtime. A flaky
   test shares state or waits on time: fix the cause.
7. Run the suite in parallel workers as you go and fix the shared state you meet.
8. One narrow pull request per subsystem. Its description summarises the ledger: contracts,
   owners, what went and why.
9. At the end, report the test step's time, the number of tests and the lines of test code
   before and after, with run links.

## Running checks

- Validate a change with the targeted checks, tests and builds it affects. Wait for the full CI
  run only when the task needs its result; required checks still gate merges.
- `bun test --changed=main` runs only the test files that import a file changed since `main`: a
  quick local pass before the full suite. CI runs the full suite.
- Checks are read-only. Lint, the format check and dependency checks report drift and never fix
  it in CI or hooks. `bun run format` is the one command that rewrites files.
