# Security standard

## What must never be public

Secrets (tokens, keys, session files, `.env`), personal data (real names in fixtures, phone
numbers, chats), local paths such as home directories, and names or details of private systems.
Git history is public too: a leak needs a fix commit, and a leaked secret needs rotation.

## Secrets in development

- Secret values live in a password manager or in the hosting platform's environment settings.
  The platform is the source of truth for deployed values.
- `.env.example` lists every variable with an empty value. Real `.env` files are git-ignored.
- A repo may commit a file of password-manager references, never values. With 1Password,
  `.env.op` holds `KEY=op://<vault>/<item>/<field>` lines; prefer vault and item IDs to names
  with spaces or non-ASCII characters. Run `op run --env-file=.env.op -- <command>`, or
  `op inject -i .env.op -o .env.local` for a tool that needs a file; `.env.local` stays
  git-ignored.
- Docs may list each secret's name, what uses it and where its value lives, never the value.
- Variables bundled into client code (`NEXT_PUBLIC_*`, `VITE_*`) hold only values meant to be
  public.
- Preview and demo deployments get no production secrets or real user data.
- Never print, list or copy a secret value into a file, log, commit, issue or message. This
  applies to agents too.

## Layers

| Layer                 | Tool                                                                                         | Where                                              |
| --------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Before commit         | `gitleaks git --pre-commit --staged`                                                         | shared lefthook config                             |
| Before commit         | devkit privacy scan with private markers                                                     | shared lefthook config                             |
| Before commit         | private repos: gitleaks and the format and lint check, never reading `.devkit-exclude` paths | `lefthook/private.yml`                             |
| Pull request and push | gitleaks on the new commits, privacy scan (generic patterns) on added lines                  | `hygiene.yml`                                      |
| Weekly / manual       | gitleaks on the full history                                                                 | `hygiene.yml` on `schedule` or `workflow_dispatch` |
| GitHub                | secret scanning and push protection                                                          | `repo-settings.ts`                                 |
| GitHub                | `main (devkit)` ruleset: no deletion or force-push of `main`, `ci` required, admins bypass   | `repo-settings.ts` (`required_checks`)             |
| Reports               | private vulnerability reporting                                                              | `SECURITY.md`                                      |

## Privacy scan

`scripts/privacy-scan.ts` checks lines for:

- generic patterns, always on: phone numbers in international format, and home directory
  paths (`/Users/<name>/`, `/home/<name>/`, `C:\Users\<name>\`);
- private markers from `~/.config/devkit/private-markers`: one plain string
  (case-insensitive) or `/regex/flags` per line, `#` for comments. The file stays on your
  machine with mode `0600` and is never committed. `DEVKIT_PRIVATE_MARKERS` points elsewhere.

It prints only `path:line`, never the matched text, and exits 1 on a hit. Add
`privacy-scan:allow` to a line that is fine on purpose.

Files that can't carry that comment, such as generated fixtures, JSON or golden files compared
byte for byte, go in `.privacy-scan-ignore` at the repo root. Each line is a path glob relative
to the root, optionally followed by the rule kinds it silences (`marker`, `phone`, `home-path`,
comma separated); without kinds it silences all of them. Name the narrowest kinds that fit, so
the other rules still guard those files:

```text
# made-up demo reports and golden files
docs/demo/*.json         home-path
internal/view/testdata/** home-path,marker
```

## gitleaks

- Shared config: `.gitleaks.toml` (managed), which extends the default rules.
- Repo-specific false positives go in `.gitleaksignore`, one fingerprint per line, so the shared
  config stays identical everywhere. `gitleaks git --verbose` prints fingerprints.

## Dependency audits

Renovate keeps dependencies current. For an advisory or a toolchain upgrade:

- Run the ecosystem's audit and the unused-dependency check first (for Bun: `bun audit`,
  `bun outdated` and Knip).
- Upgrade direct dependencies first. Add an override (`overrides` in `package.json`) only when
  the patched transitive version satisfies the range its parent declares; never force an
  incompatible major to make the count reach zero. Pin an override exactly and remove it once
  the parent ships the fix.
- Report each finding that stays open with its dependency path and practical exposure.
- Keep dependency, CI, behaviour and docs changes in separate commits.

## Workflows

- `permissions: {}` at the top of every workflow; each job asks for what it needs.
- Actions are pinned by full commit SHA with a version comment. Renovate keeps the pins fresh.
  devkit's own reusable workflows are referenced by `@v1`, which `.github/zizmor.yml` allows.
- `actions/checkout` always has `persist-credentials: false`.
- Untrusted input (`github.event.*`, inputs) reaches shell steps only through `env:`.
- No `pull_request_target`, and no `secrets: inherit`: prefer OIDC.
- actionlint and zizmor run on every pull request through `hygiene.yml`.
