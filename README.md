# devkit

Shared CI workflows, git hooks, templates and agent rules for
[neoromantic](https://github.com/neoromantic)'s public and private repos.

One place for the boring parts every repo needs: CI that runs each ecosystem's native commands,
secret and privacy scanning, a Renovate preset, community files and the shared block of
`AGENTS.md`. Repos stay independent: each one gets a thin stub or a synced file, never a
dependency on a local checkout.

JavaScript and TypeScript repos share one code style: [oxfmt](https://oxc.rs/docs/guide/usage/formatter)
with its defaults, and [oxlint](https://oxc.rs/docs/guide/usage/linter) with the
[landmines](https://github.com/interfere-inc/landmines) rules. devkit owns both configs; a repo
keeps only its own exceptions. See [the lint and format standard](docs/standards/lint-format.md).
Python and Go repos keep their native tools.

## What's inside

| Path                              | What it is                                                                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.github/workflows/ci-bun.yml`    | Reusable CI for Bun: install, `check` (or `lint` + `typecheck`), `build`, `test`, `test:e2e`; Node from `.node-version`, else 22.18+                                                                                                             |
| `.github/workflows/ci-python.yml` | Reusable CI for Python with uv: `uv sync`, `ruff check`, `pytest`                                                                                                                                                                                |
| `.github/workflows/hygiene.yml`   | Reusable checks: actionlint, zizmor, gitleaks, privacy scan of added lines                                                                                                                                                                       |
| `.github/workflows/self.yml`      | devkit's own CI, which runs the workflows above on devkit itself                                                                                                                                                                                 |
| `lefthook/lefthook.yml`           | Shared hooks: gitleaks, the privacy scan, and oxfmt and oxlint on staged files in repos on the shared standard; Knip before a push                                                                                                               |
| `lefthook/private.yml`            | Hooks for private repos: gitleaks and the oxfmt and oxlint check, without the privacy scan, and Knip before a push; pre-commit never reads paths in `.devkit-exclude`                                                                            |
| `scripts/init.ts`                 | `devkit init`: sets up the repo you are in, including Knip, oxfmt and oxlint for Bun                                                                                                                                                             |
| `scripts/oxc-staged.ts`           | The pre-commit check: oxfmt and oxlint on staged files, from each package that has the shared config                                                                                                                                             |
| `scripts/knip-push.ts`            | The pre-push check: the repo's own `bun run check:knip`, when the root `package.json` has that script                                                                                                                                            |
| `scripts/gitleaks-staged.ts`      | gitleaks on staged changes, outside the paths listed in `.devkit-exclude`                                                                                                                                                                        |
| `scripts/privacy-scan.ts`         | Finds phone numbers, home paths and your private markers; prints only `path:line`                                                                                                                                                                |
| `scripts/sync.ts`                 | Renders managed files and the AGENTS block into every repo; `--write` opens PRs                                                                                                                                                                  |
| `scripts/repo-settings.ts`        | Diffs GitHub repo settings (description, topics, wiki, secret scanning, private vulnerability reporting, the `main` ruleset…) against `repos.yml`; `--apply` fixes them                                                                          |
| `scripts/status.ts`               | On-demand default-branch SHA, checks for that SHA and latest published stable release                                                                                                                                                            |
| `repos.yml`                       | The repos devkit manages, their profile, description, topics and settings                                                                                                                                                                        |
| `agents/AGENTS.shared.md`         | The shared block for each repo's `AGENTS.md`                                                                                                                                                                                                     |
| `templates/`                      | Managed files: CI stubs, `renovate.json`, `SECURITY.md`, `CONTRIBUTING.md`, PR template, `.gitleaks.toml`, `.github/zizmor.yml`, `lefthook.yml` (public and private), `.oxfmtrc.jsonc`, `.oxlintrc.devkit.jsonc`, `.oxlintrc.devkit.react.jsonc` |
| `templates/telemetry/`            | Single-file usage telemetry clients for TypeScript, Go and Python, with no dependencies                                                                                                                                                          |
| `renovate/`                       | Renovate presets: `default` and `maintenance` (no majors)                                                                                                                                                                                        |
| `docs/standards/`                 | README, docs, product content, paid readiness, delivery, Homebrew, agent-instruction, security, usage telemetry, code patterns, testing, CI speed, and lint and format standards                                                                 |

## Use it in a repo

### Start with `devkit init`

Run it in the root of a Bun or Python repo, new or existing:

```sh
bunx github:neoromantic/devkit#v1 init        # writes; --dry-run only reports
bunx github:neoromantic/devkit#v1 init --dry-run --json
```

It also works from a clone (`bun scripts/cli.ts init --dir ../my-repo`) or from the installed
package (`bun add -d github:neoromantic/devkit#v1`, then `bunx devkit init`).

`init` reads only the repo itself: `package.json` or `pyproject.toml`, the lockfiles and the
`origin` remote. It never reads `repos.yml` and makes no GitHub API calls. It writes:

- the same managed files and `AGENTS.md` block as `sync` for the `bun` or `python` profile, so
  a later `sync` finds nothing to change;
- for Bun: `knip` pinned as a devDependency (the version devkit tests with), a `knip.json`
  baseline, a `check:knip` script, and `check` running it, so `ci-bun` runs Knip through
  `check`;
- for Bun: the [lint and format standard](docs/standards/lint-format.md): `oxlint`, `oxfmt` and
  `@interfere/landmines` pinned, the `format`, `format:check` and `lint` scripts, `check` running
  the format check and lint first, and a `.oxlintrc.json` that extends the managed
  `.oxlintrc.devkit.jsonc`. Then `bun install` updates `bun.lock` for
  `bun install --frozen-lockfile`;
- for Bun: a `test` script that runs `bun test --parallel`, so tests run in parallel workers
  from the start (see [the testing standard](docs/standards/testing.md#parallel-by-default)).
  `bun test` fails while the repo has no test file.

After `init`, run `bun run format` once and commit the result on its own, then fix what
`bun run lint` reports.

A Python repository that already calls the shared Python workflow can omit `pyproject.toml`.
Existing Renovate presets and project-specific options are preserved during setup.

The Knip baseline reports unused files, unused `dependencies` and `devDependencies`, unlisted
imports and unresolved imports. It leaves out unused exports and types, so a library's public
API is never flagged. A repo whose code has no outside callers, such as a private app or a
workspace of internal packages, can drop `include` to run Knip's full default set.

`init` keeps what the repo already has:

| Already there                                                      | What `init` does                                                                         |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| A file without the `managed by devkit` mark                        | Keeps it (`--adopt` replaces it)                                                         |
| A CI workflow (`ci`, `test`, `build`… or one that runs checks)     | Adds no `ci.yml` and prints the job to add                                               |
| Husky, pre-commit, simple-git-hooks or another lefthook file       | Adds no `lefthook.yml`                                                                   |
| Renovate config in another place, `.github/SECURITY.md`…           | Adds no second copy                                                                      |
| `check`, `lint`, `typecheck` scripts                               | `check` keeps them, runs `format:check` and an oxlint `lint` first and `check:knip` last |
| `lint` or `format` with another tool (Biome, ESLint, Prettier)     | Keeps the script, leaves it out of `check` and says what to switch                       |
| A `test` script                                                    | Keeps it; one that runs `bun test` without `--parallel` gets a note                      |
| `knip`, `oxlint`, `oxfmt` in dependencies, a Knip or oxlint config | Keeps the versions and the config                                                        |
| `AGENTS.md`                                                        | Adds the shared block and keeps the rest                                                 |
| `CLAUDE.md` with rules, no `AGENTS.md` (as `bun init` writes)      | Moves the rules to `AGENTS.md` `## Project`; `CLAUDE.md` becomes `@AGENTS.md`            |

A Bun package with `bin` gets `pack: true` on its `ci-bun` job, so CI smoke-tests the packed
CLI. `sync` adds it the same way, from the repo's own `package.json`. Libraries without `bin`
get no smoke test.

`init` refuses JS projects on npm, pnpm or yarn before it writes anything. Python projects on
Poetry, Pipenv or PDM get everything except the uv-based CI stub. With no GitHub remote,
`SECURITY.md` waits for `--repo owner/name`. Running `init` again changes nothing; after a
failed `bun install`, running it again finishes the install.

Options: `--dir`, `--dry-run`, `--json`, `--repo owner/name`, `--profile bun|python` (needed
when both `package.json` and `pyproject.toml` exist), `--adopt`, `--no-install`.

If CI is your own workflow, run `bun run check` in it or call the shared job:

```yaml
jobs:
  build:
    uses: neoromantic/devkit/.github/workflows/ci-bun.yml@v1
    permissions: { contents: read }
```

### CI

Copy `templates/ci.bun.yml` or `templates/ci.python.yml` to `.github/workflows/ci.yml` (or let
`sync.ts` do it). The stub calls the reusable workflows at `@v1` and ends with a gate job named
`ci`, the one check to require in the branch ruleset (`required_checks: [ci]` in `repos.yml`,
see [Maintain the fleet](#maintain-the-fleet)):

```yaml
jobs:
  build:
    uses: neoromantic/devkit/.github/workflows/ci-bun.yml@v1
    permissions: { contents: read }
    with: { e2e: true }
  hygiene:
    uses: neoromantic/devkit/.github/workflows/hygiene.yml@v1
    permissions: { contents: read }
  ci:
    needs: [build, hygiene]
    # …fails when any job failed or was cancelled
```

The gate needs `actions: read`: GitHub leaves a matrix leg that no runner picked up out of
`needs`, so the gate also reads the run's jobs from the API.

`ci-bun.yml` inputs: `os` (JSON list, default `["ubuntu-latest"]`), `working-directory`,
`bun-version` (default: `.bun-version`, then `packageManager` in `package.json`), `canary`, `e2e`.
Use `pack: true` to install and run the packed CLI. `pack-args` selects its arguments.
See [the pack smoke test](docs/standards/pack-smoke.md). Scripts that don't exist are skipped.
A repo that pins Node in `.node-version` or `.nvmrc` gets that Node; otherwise a repo on the
shared lint standard gets Node 24 when the runner's is older than 22.18.

Set the repository variable `CI_SELF_HOSTED` to `true` to run `main` Linux builds on
an isolated runner with the `oss-linux` label. PRs and other branches use GitHub-hosted runners, as do repositories
without the variable. The opt-in has a cost: a shared runner can be slower than a GitHub-hosted
one, and the caches it keeps never reach pull requests, which read only the Actions caches of
their own branch and the base branch (see
[the CI speed standard](docs/standards/ci-speed.md#caches)). Native macOS and Windows jobs keep their selected OS. An explicit
non-default `hygiene.runner` also stays unchanged. Draft PRs skip work; marking them ready
starts CI, and newer commits cancel superseded checks. Pushes to `main` are never cancelled:
each one keeps its run, so every pushed range gets its secret scan. The CI stubs also run
weekly, when `hygiene` scans the full history and the build is skipped.

`ci-bun` and `ci-python` point `TMPDIR` at the runner's temp dir, so test databases and other
temp files stay out of `/tmp`; on the `oss-linux` runners that dir is tmpfs and `/tmp` is on disk.
On `oss-linux`, `hygiene` also installs its Bun there, so it never replaces the shared
`~/.bun/bin/bun` that a `ci-bun` job may still be running.

Self-hosted Python jobs retain uv downloads in `runner.tool_cache/uv-cache`. GitHub-hosted jobs
download uv packages and Bun each run: an Actions cache of them cost more to save and restore
than the download it saved. With `persistent-venv: true`, a self-hosted Python job also
keeps its virtualenv in the tool cache between runs; `uv sync` still makes it match the lockfile. Repo-owned jobs keep their own cache settings.
Native macOS/Windows checks, Homebrew jobs and publishing workflows can remain
GitHub-hosted; the Linux opt-in does not move those jobs.

Validate changes with targeted local checks and builds. Do not wait for the full
GitHub CI run unless its result is needed for the task. Required checks still gate
merges; use auto-merge where available and report any pending checks.

`ci-python.yml` inputs: `python-version` (JSON list; `""` means `.python-version`), `os`,
`working-directory`, `ruff`, `test-command` (default `pytest -q`), `test-with` (extra packages),
`persistent-venv` (default off). Without a ruff of its own, a project gets ruff 0.17.5. The
Python stub runs one Python, from `.python-version`, and its tests in parallel workers:
`test-with: pytest-xdist` and `test-command: pytest -q -n auto`.

What a pull request runs, which jobs it skips and when a cache is worth it are in
[the CI speed standard](docs/standards/ci-speed.md): one runtime version per language on pull
requests, other versions and platforms after merge, on a schedule or on request.

`hygiene.yml` inputs: `actionlint`, `zizmor`, `gitleaks`, `boundary-scan` (all on), `devkit-ref`,
`runner` (JSON label array, default `["ubuntu-latest"]`), `zizmor-path` (default `.`), and
`gitleaks-log-opts` (extra git log options/pathspecs appended after the commit range).

### Git hooks

Install [lefthook](https://lefthook.dev) and [gitleaks](https://github.com/gitleaks/gitleaks)
(`brew install lefthook gitleaks`), plus [Bun](https://bun.sh) for the privacy scan and the
oxfmt and oxlint check of staged files. That check runs only from folders with the managed
`.oxfmtrc.jsonc` or `.oxlintrc.devkit.jsonc`, with the tools installed there; it does nothing
in other repos. Then add
the remote to the repo's `lefthook.yml` (the managed `templates/lefthook.yml` is exactly this):

```yaml
remotes:
  - git_url: https://github.com/neoromantic/devkit
    ref: v1
    refetch_frequency: 24h
    configs:
      - lefthook/lefthook.yml
```

and run `lefthook install` once per clone.

Before a push, the hooks run `bun run check:knip` when the root `package.json` has that script
(`devkit init` adds it), so Knip findings stop the push instead of failing CI. Clones from before
the hook run `lefthook install` once to add it.

Private repos select `lefthook/private.yml` (the managed `templates/lefthook.private.yml`):
gitleaks on staged changes and the oxfmt and oxlint check, without the public privacy scan.
Paths that must never be read go in `.devkit-exclude` at the repo root, one git pathspec per
line, `#` for comments. Both hooks drop them before any tool sees a file: gitleaks scans a
temporary index without them, and the oxfmt and oxlint check never receives them. A scanner
allowlist would only suppress findings. The pre-push Knip check runs the repo's own
`check:knip`, which reads what the repo's Knip config reads; `.devkit-exclude` does not apply.
Repos without Bun keep `lefthook/secrets.yml`. Remote
hook settings take precedence over local `run` overrides, so repo-specific hooks get their
own names. For CI use `gitleaks-log-opts` pathspecs, `zizmor-path: .github` and
`boundary-scan: false`; `hygiene` never reads `.devkit-exclude`, so the CI list stays a
reviewed workflow input.

### Privacy scan

```sh
# from a clone of devkit
bun scripts/privacy-scan.ts                 # staged changes (what the hook runs)
bun scripts/privacy-scan.ts --all           # every tracked file
bun scripts/privacy-scan.ts --diff main...HEAD
bun scripts/privacy-scan.ts docs README.md  # given files or folders

# without a clone
bunx github:neoromantic/devkit#v1 privacy-scan --all
```

Private markers live in `~/.config/devkit/private-markers` (mode `0600`, never in a repo):
one string or `/regex/flags` per line. A line that is fine on purpose takes a
`privacy-scan:allow` comment; generated fixtures that can't take one go in the repo's
`.privacy-scan-ignore` (path globs, optionally limited to some rule kinds). The scan prints
only `path:line` for each hit, never the matched text, and exits 0 when clean, 1 on hits and 2
on a usage or setup error. See [docs/standards/security.md](docs/standards/security.md).

### Usage telemetry

Products report which features run, how often and which errors they hit, through one
single-file client per language in `templates/telemetry/` (TypeScript for Bun and Node, Go,
Python 3.11+). Each client is plain HTTPS to PostHog through `usage.sergeybaus.com`, never
blocks or prints, swallows its own errors and is off with `DO_NOT_TRACK=1`,
`<PREFIX>_TELEMETRY=0`, in CI and in dev builds. A repo lists the client under its own `files`
in `repos.yml`, so `sync.ts` keeps the copy identical to the template:

```yaml
telegram-sync-cli:
  files:
    src/telemetry/client.ts: telemetry/telemetry.ts
```

A BB plugin passes the TypeScript client a `storage` adapter over its own SQLite database and
sends only after the user turns usage sharing on.

Events, properties, the notice and the off switches are in
[docs/standards/telemetry.md](docs/standards/telemetry.md). Libraries never send anything on
their own.

### Renovate

```json
{ "extends": ["github>neoromantic/devkit//renovate/default"] }
```

Weekly on Monday morning (UTC), 3-day minimum release age, non-major updates grouped, automerge
only for dev tooling, action digests, devkit itself and lockfile maintenance, and never for `0.x`. msw majors are held, because msw 3 does not intercept
`fetch` under Bun 1.4. Root `overrides` and `resolutions` update with the runtime group, 0.x dev
tools get their own PR (never automerged, so they can't hold back the dev group), and a new Node
major or Python minor waits for approval on the Dependency Dashboard.
`renovate/maintenance` is the same without major updates. `renovate/app` is for repos whose
default branch deploys to production: nothing that changes the build merges itself (no
automerge for dev tools or lockfile maintenance). A repo picks it with `renovate_preset: app` in
`repos.yml` or a private config.

## Maintain the fleet

```sh
bun install
bun scripts/sync.ts                         # dry run: diff per repo
bun scripts/sync.ts --only telegram-sync-cli
bun scripts/sync.ts --write                 # one PR per repo
bun scripts/repo-settings.ts                # settings diff
bun scripts/repo-settings.ts --apply --only devkit
bun scripts/sync.ts --check --json           # no PRs; exit 1 for drift or blocked/skipped work
bun scripts/repo-settings.ts --check --json  # no GitHub writes
bun scripts/status.ts --json                # on-demand technical observations
```

`sync.ts` clones each repo from `repos.yml` into a temp folder and renders its managed files.
Files with the `managed by devkit` mark are updated; existing files without it are left alone
unless you pass `--adopt`. It also inserts or refreshes the `<!-- devkit:agents v1 -->` block in
`AGENTS.md` and creates `CLAUDE.md` as `@AGENTS.md` when missing. Repos with `frozen_until` in
the future are skipped.

`repo-settings.ts` diffs the fields of `repos.yml`; a field that is left out is not managed.
For a repo with `required_checks: [ci]` it also keeps a branch ruleset named `main (devkit)`:
the default branch can't be deleted or force-pushed, and pull requests need `ci` to pass
(not necessarily against the latest `main`). Repository admins bypass it, so a maintainer can
still push to `main` directly. A second run after `--apply` prints `ok` for every repo.

All three commands accept `--config path` and `--only a,b`. The config has the same schema as
`repos.yml`; relative paths resolve from the current directory. Keep private inventories in the
private repo, with only the desired `files` and `settings`; use `agents: false` to preserve its
own instruction format. Public defaults are not merged into a supplied config. Do not publish
private repo names, paths or operations in devkit. A private repo keeps its native CI, hooks and
delivery procedure and opts into the shared pieces it needs.

A private repo checks its own config without a devkit clone:
`bunx github:neoromantic/devkit#v1 sync --config devkit.yml --check --json` (and `status`).
That renders the released `v1` templates, the ones consumers get.

`sync` and `repo-settings` print JSON arrays with per-repo status, individual changes/diffs and
errors. `--check` returns 0 only when everything inspected is in sync, 1 for drift, unmanaged,
blocked or frozen work, and 2 for errors. It cannot be combined with `--write` or `--apply`.
Without `--check`, dry-run differences remain informational. A PR opened or settings applied
are reported as such; they are not proof that the consuming default branch is up to date.

`status` reads the default branch live, then queries check runs and commit statuses for that
exact SHA (including pagination). CI uses configured `required_checks`, or all observed checks
when none are configured. Missing, pending and failed checks stay distinct. It also reports the
latest published stable release's tag and URL; drafts and prereleases are excluded. Exit codes:
0 for passed CI, 1 for missing, pending or failed CI, 2 for API errors. Release observations do
not change the exit code. An absent
GitHub Release does not mean a skill or web product is undelivered: its installable revision or
production deployment is verified through its own procedure. This command measures repository
facts, not installation, website freshness or publication results. It creates no schedules.

Follow [product content](docs/standards/product-content.md) when preparing documentation and
demos, and [release](docs/standards/release.md) for delivery evidence. Product-specific posting
policy and operations belong outside devkit.
Paid offers also follow [paid readiness](docs/standards/paid-readiness.md).

## Versions

- `v1` is a moving tag on the latest `v1.x.y` release. Consumers reference `@v1`; Renovate pins
  it to a digest. Breaking changes to workflow inputs, hook behaviour or template layout go
  to `v2`.
- `v1.0.0`, `v1.1.0`, … are fixed tags.
- Only a repo admin can move or delete a `v*` tag, and `main` can't be force-pushed or deleted
  (repository rulesets). The release steps are in
  [docs/standards/release.md](docs/standards/release.md#releasing-devkit-itself).

## Develop

```sh
bun install
bun run format  # oxfmt
bun run check   # oxfmt --check, oxlint, tsc --noEmit, then Knip
bun run test    # bun test --parallel, offline
bun run test:integration  # the Go telemetry client against the Go toolchain
actionlint && uvx zizmor --offline .
```

## License

[MIT](LICENSE)
