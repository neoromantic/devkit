# Agent instructions standard

## Files

- `AGENTS.md` at the repo root is the one canonical instruction file, for people and for every
  coding agent.
- `CLAUDE.md` contains exactly one line, `@AGENTS.md`. Claude Code reads `CLAUDE.md`; when any
  parent directory has a `CLAUDE.md`, it does not fall back to `AGENTS.md` by itself, so the
  import is required.
- No symlinks between the two: editors refuse to write through them and Windows checks them out
  as text files.
- Everything needed to build, test and release lives in the repo. A clone on a fresh machine,
  a contributor or a cloud agent must not depend on files outside it.

## Nested instructions

- A folder with rules of its own (a workspace package, an app, `docs/`) gets its own
  `AGENTS.md`, and a `CLAUDE.md` beside it that contains only `@AGENTS.md`.
- The root `AGENTS.md` says that nested files apply when editing files below them: not every
  agent loads them on its own.

## Layout

```md
# <repo>

<!-- devkit:agents v1 -->

…shared rules, synced from devkit/agents/AGENTS.shared.md…
<!-- /devkit:agents -->

## Project

…project rules: architecture, commands, gotchas…
```

- The block between the markers is managed: `scripts/sync.ts` replaces it. Edit it in devkit.
- Project rules go below the block, under `## Project`. When they conflict, the project wins.
- Keep the whole file under 32 KiB (Codex stops reading there) and aim for under 300 lines.
  Link to `docs/` instead of pasting long reference material.

## What belongs in `## Project`

- What the project is, in two sentences.
- Native commands for checks, offline tests and builds, including opt-in live verification.
- The release procedure and any steps only the owner may perform.
- Architecture rules that a change could break, with the reason.
- Gotchas that cost someone an hour.
- Paths that agents and tools must never read or list, and how commands exclude them (git
  pathspecs, `.gitignore`-aware search, `.prettierignore` and oxlint `ignorePatterns`).

## Agent tooling

Only for repos that ship it:

- Repo skills live in `.agents/skills/<name>/SKILL.md`. `.claude/skills/<name>` is a relative
  symlink to the same folder, so every agent loads one copy. Windows checkouts without symlink
  support see text files there.
- Skills installed from other repos are pinned in `skills-lock.json`. Update them by
  reinstalling, never by hand, and list them in `.prettierignore` so formatting leaves them
  byte-identical. Add a local skill only once its workflow has repeated.
- A project MCP server is declared for each supported agent with the same command:
  `.mcp.json` for Claude Code, `.codex/config.toml` for Codex. Pin the package version
  (`pkg@1.2.3`, not `@latest`) and keep both files free of secrets.
- Custom agent definitions (`.codex/agents/*.toml`) leave out `model`, so they inherit the
  session's model instead of a pinned name that goes stale.

## What doesn't

- Personal preferences of one maintainer or one machine.
- Planning notes, progress logs, roadmaps (use issues).
- Anything private: names of private repos or hosts, local paths, internal processes.
