# devkit

Shared CI workflows, git hooks, templates and agent rules for
[neoromantic](https://github.com/neoromantic)'s public and private repos.

One place for the boring parts every repo needs: CI that runs each ecosystem's native commands,
secret and privacy scanning, a Renovate preset, community files and the shared block of
`AGENTS.md`. Repos stay independent: each one gets a thin stub or a synced file, never a
dependency on a local checkout.

devkit sets no code style. There are no shared Biome, ESLint, ruff-format or tsconfig presets,
and nothing here reformats a repo.

## What's inside

| Path | What it is |
|---|---|
| `.github/workflows/ci-bun.yml` | Reusable CI for Bun: install, `check` (or `lint` + `typecheck`), `build`, `test`, `test:e2e` |
| `.github/workflows/ci-python.yml` | Reusable CI for Python with uv: `uv sync`, `ruff check`, `pytest` |
| `.github/workflows/hygiene.yml` | Reusable checks: actionlint, zizmor, gitleaks, privacy scan of added lines |
| `.github/workflows/self.yml` | devkit's own CI, which runs the workflows above on devkit itself |
| `lefthook/lefthook.yml` | Shared pre-commit hooks: gitleaks and the privacy scan |
| `scripts/privacy-scan.ts` | Finds phone numbers, home paths and your private markers; prints only `path:line` |
| `scripts/sync.ts` | Renders managed files and the AGENTS block into every repo; `--write` opens PRs |
| `scripts/repo-settings.ts` | Diffs GitHub repo settings (description, topics, wiki, secret scanning, private vulnerability reporting, the `main` ruleset…) against `repos.yml`; `--apply` fixes them |
| `scripts/status.ts` | On-demand default-branch SHA, checks for that SHA and latest published stable release |
| `repos.yml` | The repos devkit manages, their profile, description, topics and settings |
| `agents/AGENTS.shared.md` | The shared block for each repo's `AGENTS.md` |
| `templates/` | Managed files: CI stubs, `renovate.json`, `SECURITY.md`, `CONTRIBUTING.md`, PR template, `.gitleaks.toml`, `.github/zizmor.yml`, `lefthook.yml` |
| `renovate/` | Renovate presets: `default` and `maintenance` (no majors) |
| `docs/standards/` | README, product content, paid readiness, delivery, Homebrew, agent-instruction and security standards |

## Use it in a repo

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

`ci-bun.yml` inputs: `os` (JSON list, default `["ubuntu-latest"]`), `working-directory`,
`bun-version` (default: `.bun-version`, then `packageManager` in `package.json`), `canary`, `e2e`.
Scripts that don't exist are skipped.

Set the repository variable `CI_SELF_HOSTED` to `true` to run `main` Linux builds on
an isolated runner with the `oss-linux` label. PRs and other branches use GitHub-hosted runners, as do repositories
without the variable. Native macOS and Windows jobs keep their selected OS. An explicit
non-default `hygiene.runner` also stays unchanged. Draft PRs skip work; marking them ready
starts CI, and newer commits cancel superseded checks.

`ci-python.yml` inputs: `python-version` (JSON list; `""` means `.python-version`), `os`,
`working-directory`, `ruff`, `test-command` (default `pytest -q`), `test-with` (extra packages).

`hygiene.yml` inputs: `actionlint`, `zizmor`, `gitleaks`, `boundary-scan` (all on), `devkit-ref`,
`runner` (JSON label array, default `["ubuntu-latest"]`), `zizmor-path` (default `.`), and
`gitleaks-log-opts` (extra git log options/pathspecs appended after the commit range).

### Git hooks

Install [lefthook](https://lefthook.dev) and [gitleaks](https://github.com/gitleaks/gitleaks)
(`brew install lefthook gitleaks`), plus [Bun](https://bun.sh) for the privacy scan. Then add
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

Private repos can select `lefthook/secrets.yml` instead to reuse gitleaks without the public
privacy scan. Keep repo-specific hooks alongside it. If some paths must never be read, exclude
them in git pathspecs before piping a bounded patch to the scanner; a scanner allowlist only
suppresses findings. For that case set `gitleaks: { skip: true }` locally and add a separately
named bounded command; remote hook settings take precedence over local `run` overrides.
For CI use `gitleaks-log-opts` pathspecs, `zizmor-path: .github` and `boundary-scan: false`.

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
`.privacy-scan-ignore` (path globs, optionally limited to some rule kinds). See
[docs/standards/security.md](docs/standards/security.md).

### Renovate

```json
{ "extends": ["github>neoromantic/devkit//renovate/default"] }
```

Weekly on Monday morning (UTC), 3-day minimum release age, non-major updates grouped, automerge
only for dev tooling, action digests, devkit itself and lockfile maintenance, and never for `0.x`.
`renovate/maintenance` is the same without major updates.

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
bun run check   # tsc --noEmit
bun run test    # bun test, offline
actionlint && uvx zizmor --offline .
```

## License

[MIT](LICENSE)
