# Release standard

"Released" means a published, immutable GitHub Release. A tag alone is not a release.

## Versions

- SemVer. One source of truth per repo:
  - Bun/TS: `version` in `package.json` (read it at runtime; never hardcode it elsewhere).
  - Python: `version` in `pyproject.toml`; other files (such as a plugin manifest) are updated by
    the release tool, not by hand.
  - Go: the git tag.
- `0.x` means anything may change in a minor. Renovate never automerges `0.x` updates.

## Engine

- Default: [release-please](https://github.com/googleapis/release-please) in manifest mode
  (`release-please-config.json` + `.release-please-manifest.json`). Merging the Release PR
  creates the tag and a **draft** release (`"draft": true`, `"force-tag-creation": true`).
- The repo's own `release.yml` then builds assets, uploads them to the draft, and publishes it.
  Upload assets before publishing: immutable releases lock assets at publish time.
- Repos with an existing tag-driven pipeline may keep it, as long as the result is the same:
  a published release with its assets and notes.

## CHANGELOG

- `CHANGELOG.md` in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) shape, generated
  from Conventional Commits by the release tool. Entries from before the tool sit under a
  "Before release-please" heading.
- Don't edit generated sections by hand. Fix the commit message or the Release PR body instead.

## Registries

- **Publishing never runs inside a reusable workflow.** npm and PyPI trusted publishing bind to
  the calling repo's workflow file and environment, so publish from the repo's own
  `release.yml`, in a GitHub environment named `release`.
- npm: trusted publishing (OIDC), `permissions: id-token: write`, Node 24 (older Node fails
  with 404). Bun can't publish with OIDC yet, so: `bun pm pack`, then `npm publish ./<pkg>.tgz`.
  Provenance is automatic for public repos.
- No `postinstall` scripts: Bun and npm skip lifecycle scripts of untrusted packages. Ship a
  plain JS/TS bin, or prebuilt binaries through GitHub Releases and Homebrew.
- Binaries: build every target in CI, publish `checksums.txt`, and attest with
  `actions/attest-build-provenance`.
- Homebrew: update the formula in `neoromantic/homebrew-tap` after the release is published,
  see [homebrew.md](homebrew.md).

## After a release

1. Check the release page, the registry (`npm view <pkg> version`) and a clean install.
2. The maintainer updates the website and announcements for minor and major releases. Patch
   releases are not announced.
