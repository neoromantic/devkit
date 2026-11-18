# Code patterns standard

How code is written in repos that use devkit, beyond what the linter checks. Format and lint
are in [the lint and format standard](lint-format.md).

## Changes

- Make the smallest change that works, then make it smaller. No drive-by refactors.
- Inside the repo, change the callers instead of adding a compatibility layer, shim,
  re-export or fallback path, and delete the old path in the same change.
- Published interfaces (CLI flags and output, config files, package exports, workflow inputs)
  follow SemVer and keep working until the next major.
- No helper, option or abstraction for logic with one caller. Extract it when a second caller
  exists.

## TypeScript

- `strict` and `noUncheckedIndexedAccess` on. No `any`: take `unknown` at the boundary and
  narrow it.
- Validate input where it enters: CLI arguments, environment, files, network responses. Inside,
  trust the types: no `typeof` checks, `||` or `??` defaults or fallback branches for values the
  types already guarantee.
- Let return types be inferred. Pin a contract with `satisfies` or a typed variable.

## Workspaces

For repos with several packages:

- Internal dependencies use `workspace:*`.
- Internal packages export TypeScript source through explicit `exports` entrypoints
  (`".": "./src/index.ts"`, `"./client": "./src/client.ts"`), so other packages typecheck
  without a build. A `"./*": "./src/*.ts"` wildcard fails `landmines-structure/package-exports`;
  a wildcard over one folder of public modules (`"./*": "./src/components/*.tsx"`) passes.
- Apps depend on packages, never the reverse. A package needs a second caller.
- Lint and format run once from the root, over every workspace. Type checks, tests and builds
  may run per workspace through the task runner.
