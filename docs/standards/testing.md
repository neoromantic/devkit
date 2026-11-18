# Testing standard

How repos that use devkit test. The lint rules that enforce part of it are in
[the lint and format standard](lint-format.md).

## What a test proves

- The behaviour callers depend on, where a regression would show: the requests a client sends,
  output formats, stored data, route and CLI contracts, errors returned.
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
  undo it. A listed `mock.module` exception runs with `bun test --isolate`, spreads the real
  exports into the factory and replaces only what the boundary needs.

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

## Running checks

- Validate a change with the targeted checks, tests and builds it affects. Wait for the full CI
  run only when the task needs its result; required checks still gate merges.
- Checks are read-only. Lint, the format check and dependency checks report drift and never fix
  it in CI or hooks. `bun run format` is the one command that rewrites files.
