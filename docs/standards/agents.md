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

## What doesn't

- Personal preferences of one maintainer or one machine.
- Planning notes, progress logs, roadmaps (use issues).
- Anything private: names of private repos or hosts, local paths, internal processes.
