# Docs standard

How `docs/` is organised in repos that use devkit. The README follows
[the README standard](readme.md), `AGENTS.md` follows [the agent instructions standard](agents.md).

## Layout

- Topic docs sit directly in `docs/`, one topic per file, named after the topic
  (`docs/auth.md`, `docs/releasing.md`).
- Subfolders hold assets or one set of same-kind files: `docs/images/`, `docs/demo/`,
  `docs/releases/<tag>.md`.
- No `archive/`, `deprecated/` or `plans/` folders, and no ADR, RFC, PRD or SPEC series. A
  normative format spec is a topic doc like any other.
- With more than about five docs, `docs/README.md` lists each file and when to read it.

## Content

- Describe the code as it is now. History lives in git and pull requests; plans live in issues.
- Update the existing topic before adding a file. Delete a doc when what it describes is gone.
- Link to source files, commands and other docs instead of copying their details. Each fact has
  one home.
- A lesson that cost someone an hour goes in the topic doc it concerns, or in `AGENTS.md` as a
  gotcha, with the reason. No dated logs.
- Relative links keep the `.md` extension.

## What goes where

| Adding                     | Put it                                                            |
| -------------------------- | ----------------------------------------------------------------- |
| Rule for people and agents | `AGENTS.md` `## Project`, or a nested `AGENTS.md` for one package |
| How a part works           | `docs/<topic>.md`                                                 |
| Release procedure          | `AGENTS.md` or `docs/releasing.md`                                |
| Plan, idea, progress       | An issue                                                          |
| Implementation history     | Commits and pull requests                                         |

## Frontmatter

Optional. Repos whose docs are read mostly by agents can start each `docs/*.md` with YAML, so
an agent picks the right file without opening every one:

```yaml
---
summary: One line on what this doc covers.
read_when:
  - "Changing the sync engine"
applies_to:
  - src/sync/**
last_verified: 2026-01-31
---
```

Change `last_verified` only after checking the doc against the code it describes. GitHub shows
frontmatter as a table above the text, so public product docs usually skip it.
