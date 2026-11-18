# Lint and format standard

Every JavaScript and TypeScript repo that uses devkit is formatted with
[oxfmt](https://oxc.rs/docs/guide/usage/formatter) and linted with
[oxlint](https://oxc.rs/docs/guide/usage/linter) plus the
[landmines](https://github.com/interfere-inc/landmines) rules. Python and Go repos keep their
own tools.

## What runs

- **oxfmt** with its defaults: 100 columns, double quotes, semicolons, sorted `package.json`
  keys. It formats every file type it supports: JS, TS, JSON, Markdown, YAML, TOML, CSS, HTML.
- **oxlint**: the `correctness` category of the `typescript`, `unicorn`, `oxc` and `import`
  plugins, as errors.
- **landmines**: the full `recommended` set as errors: the `landmines-testing` rules,
  `landmines-style/no-comments`, `landmines-structure/*` and
  `landmines-types/no-explicit-return-types`.

Warnings fail too (`oxlint --deny-warnings`), so the output is either empty or a list of
things to fix.

The landmines rules run as oxlint JS plugins and need Node 22.18 or later on `PATH`. When there
is no `node` at all, `bun run` stands in for it. `ci-bun` installs Node 24 on runners with
an older one.

## Where it runs

- `bun run format` runs `oxfmt` and formats the repo in place.
- `bun run check` runs `bun run format:check` (`oxfmt --check`) and `bun run lint`
  (`oxlint --deny-warnings`) first, then the type check and Knip. `ci-bun` runs `check`.
- Pre-commit: the shared lefthook config checks staged files with oxfmt and oxlint, from the
  folder that holds `.oxfmtrc.jsonc` or `.oxlintrc.devkit.jsonc`. In a repo without them it
  does nothing.

## Where the config lives

| File                     | Owner                                                                           |
| ------------------------ | ------------------------------------------------------------------------------- |
| `.oxfmtrc.jsonc`         | devkit (managed): the shared oxfmt config.                                      |
| `.oxlintrc.devkit.jsonc` | devkit (managed): the shared oxlint config.                                     |
| `.oxlintrc.json`         | The repo: `extends` the shared config and holds this repo's exceptions.         |
| `.prettierignore`        | The repo, if needed: paths oxfmt must leave alone, such as byte-exact fixtures. |

`devkit init` sets all of this up in a Bun repo: the pinned `oxlint`, `oxfmt` and
`@interfere/landmines` devDependencies, the `format`, `format:check` and `lint` scripts,
`check` running them, and `.oxlintrc.json`. Then run `bun run format` once, commit the
result on its own, and fix what `bun run lint` reports.

## Exceptions

Fix the code, not the config. An exception is for a case where meeting a rule would change
what the product does, or needs a rewrite out of all proportion to the change at hand, such as
a protocol client that the HTTP mocking library can't serve.

1. Use the narrowest form. The `no-fixed-sleep`, `strict-msw` and `no-flake-masking` rules take
   a per-file allowlist with an exact count. A count that is too high is an error too, so the
   list only shrinks:

   ```json
   {
     "$schema": "./node_modules/oxlint/configuration_schema.json",
     "extends": ["./.oxlintrc.devkit.jsonc"],
     "rules": {
       "landmines-testing/no-fixed-sleep": [
         "error",
         { "allow": { "src/daemon/reconnect.test.ts": 1 } }
       ]
     }
   }
   ```

   Other rules get an `overrides` entry for the files in question, not a repo-wide switch.

2. A published library sets `publicApi` on `landmines-style/no-comments` to its entrypoints,
   so TSDoc on its public API stays:
   `"landmines-style/no-comments": ["error", { "publicApi": ["/src/index\\.ts$"] }]`.
3. List every exception in the pull request that adds it: rule, file, count and why.

## Comments

The `no-comments` rule keeps functional directives (`oxlint-disable`, `@ts-expect-error`,
`/* @__PURE__ */`), licence headers, single-line `// WARNING:` comments for real recurring
footguns, and TSDoc on exported public API. Rationale goes in the pull request, the commit
message or the docs. Files synced from devkit carry their mark as a `// WARNING:` line.
