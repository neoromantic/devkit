# devkit

<!-- devkit:agents v1 -->
<!-- managed by devkit v1: edit in https://github.com/neoromantic/devkit/blob/main/agents/AGENTS.shared.md -->
## Shared rules (devkit)

These rules apply to people and coding agents in every repo that uses
[devkit](https://github.com/neoromantic/devkit). Project rules follow in `## Project` below.
Where they conflict, the project section wins.

### Data

- Use only made-up data in tests, fixtures, examples, docs and screenshots. No real people, chats,
  phone numbers, tokens, session files or local paths such as home directories.
- Never commit `.env` files or credentials. Tests run offline by default; live API tests are
  opt-in and read their credentials from the environment.

### Commands

Every repo exposes the same script names, so CI and agents need no per-repo knowledge:

| Script | What it does |
|---|---|
| `check` | lint and typecheck (or `lint` and `typecheck` separately) |
| `test` | offline unit tests |
| `test:e2e` | end-to-end tests, still offline |
| `build` | produce the shipped artifact, if any |

- Bun repos: `bun run <script>`. Python repos: `uv run …` (never bare `pip` or `python`).
  Go repos: `go` tooling from `go.mod`.
- Use Bun, uv or Go modules for installs. Use npm only for `npm publish` and `npm view`.

### Definition of done

- The change works end to end, tests cover it, and `check` and `test` pass locally.
- README and docs change in the same commit as the behaviour they describe.
- No new warnings, no commented-out code, no stray debug output.

### Commits and releases

- Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`.
  A breaking change adds `!` (`feat!:`) and a `BREAKING CHANGE:` footer.
- One logical change per commit. Never rewrite published history or force-push `main`.
- Releases happen only through the repo's Release PR or release workflow. Don't bump versions,
  edit `CHANGELOG.md` or push tags by hand.

### Files

- Don't add planning or progress files (`progress.md`, `docs/plans/`). Plans live in issues.
  `ROADMAP.md`, if present, is a short "Known gaps" list that links issues.
- Don't add agent hooks that rewrite tracked files.
- `AGENTS.md` is the canonical instruction file. `CLAUDE.md` contains only `@AGENTS.md`.
- Files marked "managed by devkit" (this block, `SECURITY.md`, `CONTRIBUTING.md`, the PR
  template, `.gitleaks.toml`, `.github/zizmor.yml`, `renovate.json`, `lefthook.yml` and the
  CI stub) are synced from devkit. Change them there, not here.
<!-- /devkit:agents -->

## Project

devkit holds the shared CI workflows, hooks, templates and agent rules for the repos in
`repos.yml`. It is infrastructure: no release announcements, no code style presets.

### Commands

- `bun run check` runs `tsc --noEmit`; `bun run test` runs `bun test`, offline.
- `actionlint` and `uvx zizmor --offline .` after any workflow change.
- `bun scripts/sync.ts` (dry run) before any `--write`; `bun scripts/repo-settings.ts` before `--apply`.

### Rules

- A change to a template, the AGENTS block or a reusable workflow reaches every consuming repo.
  Keep `@v1` backward compatible: new inputs get defaults, nothing is renamed or removed.
  Breaking changes go to `v2`.
- Pin every third-party action by full commit SHA with a `# vX.Y.Z` comment. Tool binaries
  downloaded in workflows are pinned by version and sha256.
- Workflows start with `permissions: {}`; each job asks only for what it needs.
- Templates, `repos.yml` and tests are public. Build privacy-scan test fixtures at runtime so
  the repo itself scans clean.
- Every template carries the `managed by devkit vN` mark, and devkit's own managed files
  (`SECURITY.md`, `.gitleaks.toml`, `.github/zizmor.yml`, `renovate.json`) equal the
  rendered templates. Tests check both.
- Releasing: tag `v1.x.y` on `main`, push it, then move the `v1` tag to the same commit.
  Moving `v1` is the only tag that is ever re-pointed.
