# Usage telemetry standard

How products report usage: which ones run, how often, which features people use, and which
errors they hit. One client per language, a single file with no dependencies, synced from
`templates/telemetry/`. Events go to PostHog through `https://usage.sergeybaus.com`, which also
shows what is collected and the public numbers.

Telemetry is on by default and easy to turn off. It must never slow a product down, print
anything, or fail it: every error inside the client is swallowed.

## Clients

| Language | Template | Used by |
|---|---|---|
| TypeScript (Bun and Node) | `templates/telemetry/telemetry.ts` | CLIs, server code |
| Go | `templates/telemetry/telemetry.go` | CLIs, daemons |
| Python 3.11+ | `templates/telemetry/telemetry.py` | plugins, desktop apps |

A repo lists the file under its own `files` in `repos.yml` (target path → template), and
`scripts/sync.ts` keeps it identical to the template. Do not edit the copy in a product; change
the template here and sync. A native app that runs its own CLI records events through that CLI
(`<tool> telemetry record …`) instead of carrying a second client.

Libraries never send anything on their own: not on import, not from `postinstall`, not from
code that a host application calls. Only a product's own entry point (a CLI, an app, a plugin,
a server) may create a client.

## Wire format

One HTTPS request per event, PostHog's capture API, sent to the proxy:

```
POST https://usage.sergeybaus.com/i/v0/e/
Content-Type: application/json
User-Agent: devkit-telemetry/1 (<product>/<version>)

{
  "api_key": "<public phc_ project key>",
  "event": "feature_used",
  "distinct_id": "8b0e6c1a-3f0d-4a51-9a7e-2f1c5d9e4b77",
  "timestamp": "2026-10-28T09:12:03.123Z",
  "properties": {
    "$process_person_profile": false,
    "$lib": "devkit-telemetry",
    "$lib_version": "1",
    "product": "telegram-sync-cli",
    "$app_version": "0.4.0",
    "$os": "macOS",
    "$os_version": "15.1",
    "arch": "arm64",
    "runtime": "bun 1.4.2",
    "channel": "homebrew",
    "mode": "agent",
    "agent": "claude-code",
    "feature": "chats list"
  }
}
```

- The project key is PostHog's public, write-only key; it is a constant in each client.
- `usage.sergeybaus.com/i/*` is a plain Vercel rewrite to `us.i.posthog.com/i/*`. PostHog sees
  the client's IP address and derives the country from it, as it does for the websites.
- `$process_person_profile: false` keeps events anonymous in PostHog (no person profiles).
- Timeout 3 seconds for the whole request, one attempt, no retries, no queue on disk. The
  response is ignored. Proxy settings come from the environment (`HTTPS_PROXY`). Python's
  `urllib` applies the timeout per socket operation; its send thread never holds the process.
  Node's `fetch` reads the proxy variables only with `NODE_USE_ENV_PROXY=1`.
- The body is compact JSON. Debug mode prints the same JSON.

## Events

| Event | When | Extra properties |
|---|---|---|
| `app_installed` | The first time this install sends anything | — |
| `app_started` | Each start of the product | — |
| `feature_used` | A feature runs: a CLI subcommand path without arguments (`chats list`), an action in an app (`redact`), a plugin handler | `feature` |
| `error_occurred` | A command or action fails | `error_type`, `error_message` |

`feature` values come from a fixed list in the product's code. Anything not on the list is sent
as `other`. Feature names are lowercase words separated by spaces, dots or underscores.

`error_type` is the error's class or code (`ENOENT`, `FloodWait`, `ValueError`), at most 100
characters. `error_message` is the error text after the client has replaced the home directory
with `~` and the user name with `<user>`, trimmed and cut to 300 characters; an empty message is
left out. The replacement is one pass, ignores case, and only touches a match that is not part
of a longer word (no letter or digit right before or after it). The home directory is matched
with `\` and with `/`; the user names are `USER`, `LOGNAME`, `USERNAME` and the last part of
the home path, two characters or longer. Never pass a message that embeds user content (message
text, chat or contact names, document names, health values); pass the error type alone in those
code paths.

### Common properties

| Property | Values |
|---|---|
| `product` | the product slug, the same as in `products.json` (`ai-usage`, `telegram-sync-cli`, `telesec`, `nothing-personal`, `amisleeping`) |
| `$app_version` | the product's version |
| `$os`, `$os_version` | `macOS`, `Windows` or `Linux` (other systems in lowercase), and the OS version: the product version on macOS, `VERSION_ID` from `/etc/os-release` on Linux (else the kernel release), `10.0.<build>` on Windows |
| `arch` | `arm64`, `x64` (also for `x86_64`, `amd64`) or what the runtime reports |
| `runtime` | `go 1.25.3`, `bun 1.4.2`, `node 24.1.0`, `python 3.12.7` |
| `channel` | how it was installed, set by the product: `homebrew`, `npm`, `binary`, `install-script`, `plugin`, `app`, `web`, `source` |
| `mode` | how it runs: `interactive`, `agent`, `script`, `scheduled`, `daemon`, `app`, `plugin`, `server` |
| `agent` | the AI agent running it, or absent: `claude-code`, `codex`, `cursor`, `gemini`, or the name in `AI_AGENT` |

`$os_version`, `channel` and `agent` are left out when empty (Go cannot read the Windows
version without a subprocess, so it leaves `$os_version` out there).

`mode` is set by the product when it knows (`scheduled` for a run started by launchd, `daemon`,
`app`, `plugin`, `server`). Otherwise the client picks `agent` when an agent is detected,
`interactive` when stdin or stderr is a terminal, and `script` otherwise.

Agent detection, first match: `AI_AGENT` (its value up to the first `_`, lowercased, at most
40 characters), `CLAUDECODE` → `claude-code`, `CODEX_SANDBOX` or `CODEX_THREAD_ID` → `codex`,
`CURSOR_AGENT` → `cursor`, `GEMINI_CLI` → `gemini`.

### Volume

In the `scheduled`, `daemon` and `plugin` modes each event is sent at most once per UTC day for
the same event name and `feature` (or `error_type`). A collector that runs every 15 minutes
then sends one `app_started` a day, not 96. Other modes send every event. The keys in `daily`
are `app_started`, `feature_used:<feature>` and `error_occurred:<error_type>`; writing a new
key drops the keys of earlier days.

Never sent: argument values, file and folder names, paths (beyond the scrubbed error text),
host names, user names, environment values, message or document contents, account names,
chat or user ids, licence keys, hardware ids.

## Identity and state

Each product keeps `telemetry.json` in its own state directory:

```json
{"id":"8b0e6c1a-3f0d-4a51-9a7e-2f1c5d9e4b77","enabled":null,"notice":1,"installed":true,"daily":{"app_started":"2026-10-28"}}
```

All three clients write this exact shape: compact JSON on one line ending in a newline, every
key present, in this order.

- `id` is a random UUID v4 (`null` until there is one) created when the notice is first seen or
  telemetry is turned on, or at the next event if `off` deleted it and the environment turned
  telemetry back on. It is never derived from hardware, the user or another product's id.
- `enabled` is `true` or `false` after `<tool> telemetry on|off`, otherwise `null`.
- `notice` is the version of the notice the user has seen (currently `1`).
- `installed` records that `app_installed` was sent.
- `daily` holds the last UTC day each throttled key was sent.

Writes go to a temp file and are renamed into place. A lost update between two processes is
acceptable. A state directory that cannot be written means nothing is sent and no notice is
printed. The client reads the file again for every event, so `telemetry off` in another process
stops a running daemon or plugin at its next event.

## Turning it off

The first rule that matches decides. Variable values are trimmed and compared ignoring case; an
empty value counts as unset.

1. The product built without an endpoint (packagers): off.
2. `DO_NOT_TRACK` is set to anything but empty, `0` or `false`: off.
3. `<PREFIX>_TELEMETRY` (for example `AI_USAGE_TELEMETRY`):
   - `0`, `off`, `false`: off;
   - `debug`: on, but each event is printed to stderr as `[telemetry] {json}` and not sent (the
     notice, the state file and the daily limit work as when on);
   - `1`, `on`, `true`: on, even in CI.
4. CI (`CI` set to anything but `false`, `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`,
   `CIRCLECI`, `TF_BUILD`, `JENKINS_URL`, `TEAMCITY_VERSION`, `CODEBUILD_BUILD_ID`), a test run
   (`NODE_ENV=test`, `VITEST` or `JEST_WORKER_ID`; `go test`; `PYTEST_CURRENT_TEST` or
   `PYTEST_VERSION`), or a development build (version empty or `0.0.0`, or containing `dev` such
   as `dev`, `devel`, `(devel)` or `1.2.0-dev.1`; a leading `v` is ignored): off.
5. `enabled` in `telemetry.json`.
6. Otherwise on.

When it is off, the client writes nothing to disk and opens no connection.

Every product with a CLI has `<tool> telemetry status|on|off`. `status` prints whether it is on,
which rule decided, the install id and the state file (`--json` for machines). `off` deletes the
id and the counters and sets `enabled: false`. `on` sets `enabled: true` and marks the notice as
seen. Apps put the same switch in their settings.

## Notice

Nothing is sent until the user has seen the notice. The client keeps that state; the product
decides where the notice appears:

- a CLI prints it once to stderr when stderr is a terminal or an AI agent runs it;
- an install script prints it and marks it seen;
- an app or plugin shows it once in its own UI (a banner, the settings panel, a message to the
  owner) and marks it seen;
- Homebrew `caveats` and the README repeat it.

Nothing is due while telemetry is off, and the notice gate holds even when
`<PREFIX>_TELEMETRY=1` turned it on. The process that shows the notice or marks it seen sends
nothing; `telemetry on` is an explicit opt-in and does not count. Text, on one line, with the
product's name and off command (default `<product> telemetry off`):

> ai-usage shares usage stats with its author: how often it runs, which features are used,
> errors, version and OS, tied to a random install ID. It never sends your files, arguments or
> account names. Nothing has been sent yet. Turn it off with `ai-usage telemetry off` or
> `DO_NOT_TRACK=1`. Details: https://usage.sergeybaus.com

A new notice version is needed only when the set of events or properties grows; sending stops
until the new notice is seen.

## Client API

The three clients expose the same calls (shown in TypeScript; Go and Python use their own
naming conventions). `envPrefix` defaults to the product upper-cased with every other character
as `_` (`ai-usage` → `AI_USAGE`).

```ts
const t = createTelemetry({
  product: 'telegram-sync-cli',
  version: '0.4.0',
  envPrefix: 'TELEGRAM_SYNC_CLI',   // reads TELEGRAM_SYNC_CLI_TELEMETRY
  stateDir: join(homedir(), '.telegram-sync-cli'),
  channel: 'homebrew',
  mode: undefined,                   // or 'scheduled' | 'daemon' | 'app' | 'plugin' | 'server' …
  features: ['chats list', 'sync'],  // anything else becomes "other"
  offCommand: 'tg telemetry off',
})
t.noticeText()          // the notice while it is due, else null: for an app or plugin that shows it in its own UI
t.showNotice()          // prints the notice once if it is due and stderr is a terminal or an agent runs it; returns whether it printed
t.markNoticeSeen()      // for apps, plugins and install scripts that showed it themselves
t.started()             // app_started (+ app_installed the first time)
t.feature('chats list') // feature_used
t.error(err)            // error_occurred
await t.flush(500)      // before exit: waits up to 500 ms for requests already in flight
t.status()              // { enabled, debug, reason, id, stateFile, endpoint }; id is null until there is one
t.setEnabled(false)     // telemetry off / on; returns whether the state file was written
```

`reason` names the rule that decided: `no-endpoint`, `do-not-track`, `env`, `ci`, `test`,
`dev-version`, `state` or `default`. The `status()` keys are the same in all three clients.

`capture(event, properties, distinctId, options)` sends one event with no state, notice or
throttling; `options` are the product fields of `createTelemetry` (`product`, `version`,
`channel`, `mode`, `envPrefix`). It adds the common properties and applies rules 1–4 of
"Turning it off". Server code with its own identifiers (a web service) uses it directly, with a
random or keyed id that is never an email or an account id; an empty id becomes a random one.

## Changing a product

Turning telemetry on in a product is a privacy change: say so first in its release notes, add a
"Usage stats" section to its README or privacy page (what is sent, the off switches, PostHog as
the processor, a link to https://usage.sergeybaus.com), and replace any "no telemetry" promise
in the same release.
