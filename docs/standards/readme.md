# README standard

A README answers "what is this, how do I install it, how do I use it" in the first screen.
Soft limit: about 250 lines. Move release internals to `docs/releasing.md` and long reference
material to `docs/`.

## Order

1. **Title and tagline.** One line, the same text as the GitHub description in `repos.yml`.
2. **Hero image.** 16:10, at least 1500px wide, made-up data only. Store it in `docs/images/`.
   For CLIs a short terminal recording (vhs, under 2 MB) or an SVG also works.
3. **Badges.** At most four: CI, version (npm or release), license, and one more if it earns
   its place. No badge walls.
4. **Install.** Real channels only, in this order:
   1. Homebrew, see [homebrew.md](homebrew.md):
      ```sh
      brew install neoromantic/tap/<name>
      ```
   2. Bun or npm (`bun add -g …` / `npm i -g …`), when the package is published.
   3. Install script, when there is one.
   4. Manual: download a release asset or build from source.
5. **Quickstart.** The shortest path from install to the first useful result.
6. **Features.** Short bullets. Only what ships today; no roadmap items.
7. **Usage.** Commands and options people actually use. Link the full reference.
8. **For AI agents.** How an agent should call the tool (JSON output, exit codes, skills).
9. **Contributing, Security, License.** One line each, linking `CONTRIBUTING.md`, `SECURITY.md`
   and `LICENSE`.

## Rules

- Everything in the README must be true for the latest release, not for `main` only.
- Change the README in the same commit as the behaviour it describes.
- Examples, screenshots and fixtures use invented names, numbers and paths.
- Experimental or unofficial integrations say so in one sentence near the top.
- No "coming soon" sections. Known gaps go in issues; a `ROADMAP.md`, if any, only links them.
