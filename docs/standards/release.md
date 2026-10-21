# Release standard

The project's documented procedure defines delivery. Shared tooling does not replace it or
authorise owner-only steps.

| Delivery | Evidence |
|---|---|
| Versioned package or binary | Published release, expected assets and registry version; a tag alone is insufficient |
| Skill installed from a branch | Verified installable commit SHA |
| Web service | Production deployment URL and source revision, checked live |
| Desktop app | Published build and update channel, through the owner's release procedure |

## Versions

- SemVer. One source of truth per repo:
  - Bun/TS: `version` in `package.json` (read it at runtime; never hardcode it elsewhere).
  - Python: `version` in `pyproject.toml`; update any required manifests through the local procedure.
  - Go: the git tag.
- `0.x` means anything may change in a minor. Renovate never automerges `0.x` updates.

## Engine

Use the repo's existing release command, tag workflow or manual procedure. Do not add a release
engine just to conform to shared documentation.

- When adopting [release-please](https://github.com/googleapis/release-please), use manifest mode
  (`release-please-config.json` + `.release-please-manifest.json`). Merging the Release PR
  creates the tag and a **draft** release (`"draft": true`, `"force-tag-creation": true`).
- The repo's own `release.yml` then builds assets, uploads them to the draft, and publishes it.
  Upload assets before publishing: immutable releases lock assets at publish time.
- Repos with an existing tag-driven pipeline may keep it, as long as the result is the same:
  a published release with its assets and notes.
- A Release PR opened or updated with `GITHUB_TOKEN` needs a maintainer to approve its workflow
  runs before required `ci` can pass. For automatic runs, use a GitHub App token; see
  [GitHub's trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow).

## CHANGELOG

- Keep the project's existing notes format: a changelog, release notes or website entries.
  New changelogs use [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) shape.
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

1. Check the applicable delivery evidence above, distribution channels and a clean install or
   user flow. For npm, check the registry with `npm view <pkg> version`.
2. Update affected documentation and website content. Prepare verified facts and screenshots
   for the maintainer's separate publishing process.
3. Follow the [product content standard](product-content.md); record the verified revision and
   links. Posting accounts, queues and announcement policy stay outside product repositories.

## Releasing devkit itself

devkit is released by hand. Consumers pin `@v1`, so moving that tag is the release, and only a
repo admin can do it: a tag ruleset on `refs/tags/v*` blocks updating or deleting release tags
for everyone else, and a branch ruleset blocks force-pushing or deleting `main`. Automating the
move would need a ruleset bypass for GitHub Actions, which would let any workflow with
`contents: write` repoint every consumer, so there is no release workflow on purpose.

1. Check that `main` is green: `gh run list --workflow self.yml --branch main --limit 1`.
2. Bump `version` in `package.json` to `X.Y.Z` and update the README if inputs changed. Commit
   `chore(release): X.Y.Z` and push.
3. Tag and publish the release:

   ```sh
   git tag -a vX.Y.Z -m "devkit vX.Y.Z"
   git push origin vX.Y.Z
   gh release create vX.Y.Z --verify-tag --generate-notes --title "devkit vX.Y.Z"
   ```

4. Move the major tag (admin only; the push reports a bypassed rule, which is expected):

   ```sh
   git tag -f v1 'vX.Y.Z^{commit}'
   git push --force origin refs/tags/v1
   ```

5. Verify: `git ls-remote origin 'refs/tags/v1*'` shows `v1` on the new commit. Renovate updates
   pinned digests in consuming repos, and lefthook remotes refetch within 24 hours.

Breaking changes to workflow inputs, hook behaviour or template layout start `v2` instead of
moving `v1`. Never delete a published `vX.Y.Z` tag.
