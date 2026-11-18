# Release standard

The project's documented procedure defines delivery. Shared tooling does not replace it or
authorise owner-only steps.

| Delivery                      | Evidence                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| Versioned package or binary   | Published release, expected assets and registry version; a tag alone is insufficient |
| Skill installed from a branch | Verified installable commit SHA                                                      |
| Web service                   | Production deployment URL and source revision, checked live                          |
| Desktop app                   | Published build and update channel, through the owner's release procedure            |

## Web services

A merge or a green CI run is not delivery. A web change is delivered when a production
deployment built from a commit that contains it is live.

1. Use the hosting platform as the status source. GitHub deployment records can lag or be
   missing; their absence alone is not a failure.
2. Find the production deployment for the merge commit and wait for it with one blocking
   command, such as `vercel inspect <url> --wait --timeout 10m`, not a polling loop. Select only
   the fields you need from JSON output.
3. A build skipped by path filtering leaves an earlier commit live. Confirm that the change does
   not touch that service, or that the live commit contains it.
4. Check that the deployment is ready and serves the production domain. Then fetch the live
   page: expect HTTP 200 (or the documented redirect) and a marker of the change, such as the
   title or new text:

   ```sh
   curl -sS -o /dev/null -w '%{http_code}\n' https://example.com/
   curl -fsS https://example.com/ | grep -o '<title>[^<]*</title>'
   ```

5. Check the changed user flow in a browser, as the [product content standard](product-content.md)
   describes.

Record the deployment URL, source commit and time of the check. Each web service documents its
production integrations, its preview boundaries and how to roll back.

## Versions

- Versioned products use SemVer, with one source of truth per product. A web service may use
  its deployed commit without a version or release tag:
  - Bun/TS: `version` in `package.json` (read it at runtime; never hardcode it elsewhere).
  - Python: `version` in `pyproject.toml`; update any required manifests through the local procedure.
  - Go: the git tag.
- A repo with several versioned products tags each one `<product>/vX.Y.Z` and keeps its version
  in that product's own manifest.
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
   Paid offers also follow [paid product readiness](paid-readiness.md).

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
