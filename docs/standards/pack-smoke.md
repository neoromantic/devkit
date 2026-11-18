# Pack smoke test

`ci-bun.yml` can check the package users install, not just the checkout. With `pack: true` it:

1. Packs the package in `working-directory` with `bun pm pack`, after Install and Build and
   before Test. Pack lifecycle scripts (`prepack`, `prepare`, `postpack`) run as usual.
2. Installs the tarball with `bun install` into a new project under the runner temp dir,
   outside the checkout.
3. Runs every CLI from the installed `package.json` `bin` in an empty temp directory, once per
   argv in `pack-args`. Each run must exit 0 within 120 seconds, with stdin closed.

Nothing is published and no registry credentials are used.

```yaml
jobs:
  build:
    uses: neoromantic/devkit/.github/workflows/ci-bun.yml@v1
    permissions: { contents: read }
    with:
      pack: true
      pack-args: '[["--help"],["--version"]]'
```

| Input       | Default                          | Meaning                                                  |
| ----------- | -------------------------------- | -------------------------------------------------------- |
| `pack`      | `false`                          | Run the pack smoke test                                  |
| `pack-args` | `''`, which means `[["--help"]]` | JSON argv list, or list of argv lists, run for every bin |

Each argv list is passed to the CLI as separate arguments, without a shell. Spaces, quotes and
`$` reach the CLI unchanged.

## What fails

- `bun pm pack` or the tarball install fails.
- A `bin` target is missing from the installed package.
- A CLI exits non-zero or times out, for example when a module it imports was left out of
  `files` or the build output is missing.

`bun pm pack` always includes the `bin` files themselves, so `--help` alone may not load every
module. Add an argv that reaches the rest of the CLI, such as a subcommand's `--help`.

## Isolation

- The install and the CLI runs get an allowlisted environment: `PATH`, locale, basic OS variables
  on Windows, and a fresh `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, XDG dirs, temp dir and
  Bun install cache. Job secrets, tokens and `GITHUB_*` variables are not passed. Proxy and CA
  variables are passed to the install only.
- `PATH` is the installed `node_modules/.bin`, the directory of the Bun that runs the job, then
  the job's `PATH` without entries inside the checkout. `#!/usr/bin/env bun` CLIs run on the job's
  Bun; `#!/usr/bin/env node` CLIs use the runner's Node.
- The helper, `scripts/pack-smoke.ts`, comes from the exact devkit revision the workflow was
  called at (`job.workflow_repository` at `job.workflow_sha`). It is moved to the runner temp dir
  and its checkout is removed before packing, so it never ends up in the tarball.

## Constraints

- Dependencies install from the default registry with no credentials. Packages that need a
  private registry are not supported.
- Linux and macOS run the full test. On Windows the CLI runs through the `.exe` shim Bun creates
  in `node_modules/.bin`.
- Compiled single-file binaries are outside this check; test them in the project's own release
  workflow.

## Locally

```bash
DEVKIT_PACK_ARGS='[["--help"],["--version"]]' bunx github:neoromantic/devkit#v1 pack-smoke .
```
