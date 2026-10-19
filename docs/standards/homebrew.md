# Homebrew standard

Every CLI ships through one tap: [`neoromantic/homebrew-tap`](https://github.com/neoromantic/homebrew-tap),
tapped as `neoromantic/tap`.

**Never rename the tap repo.** Installed formulae, user instructions and release pipelines all
point at `neoromantic/homebrew-tap`; a rename breaks `brew upgrade` for everyone.

## Install instructions (Homebrew 6+)

Homebrew 6.0 (June 2026) refuses to load formulae from third-party taps until they are trusted.
Write install steps in this order:

```sh
brew tap neoromantic/tap
brew trust --tap neoromantic/tap
brew install <name>
```

Checked on Homebrew 7.0.10 (2026-10-19), with an empty trust store:

| Command | Result |
|---|---|
| `brew install <name>` after `brew tap`, without trust | refused: "Refusing to load formula neoromantic/tap/<name> from untrusted tap neoromantic/tap" |
| `brew install neoromantic/tap/<name>` (fully qualified) | works: Homebrew trusts that one formula and installs it |
| `brew trust --tap neoromantic/tap`, then `brew install <name>` | works |

So the one-liner `brew install neoromantic/tap/<name>` is also fine for READMEs. The trust step
matters when people later install other formulae from the tap by short name. Trust lives in
`~/.homebrew/trust.json` (or `$XDG_CONFIG_HOME/homebrew/trust.json`), and a Brewfile can declare
it.

## Formula checklist

- One formula per CLI, in `Formula/<name>.rb`, named like the binary.
- `desc` is the repo tagline (`repos.yml`), under 80 characters, no leading article.
- `homepage` is the landing page if there is one, otherwise the GitHub repo.
- `license "MIT"`.
- Prebuilt binaries per platform through `on_macos`/`on_linux` and `on_arm`/`on_intel`, from
  the published GitHub Release assets, each with its `sha256`.
- A `test do` block that runs the binary (`--version` at least).
- `caveats` only for steps a user must take after install.
- The release pipeline updates the formula only after the GitHub Release is published, never for
  prereleases, and never to a lower version.
- Before pushing: `brew style`, `brew audit --strict --online <name>`, and a clean
  `brew install` + `brew test` on macOS and Linux (`brew trust --tap neoromantic/tap` first).

## Tap repo

- Ruleset: block force-pushes and deletion of `main`. No required status checks, so release
  pipelines can push formula updates with their deploy key.
- One deploy key per product that writes to the tap. Bot commits use a noreply author.
- The tap README lists every formula with the three install lines above.
