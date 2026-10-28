import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CaptureOptions,
  capture,
  createTelemetry,
  type Env,
  type Mode,
  type Reason,
  type Telemetry,
  type TelemetryOptions,
} from '../templates/telemetry/telemetry'

const ID = '8b0e6c1a-3f0d-4a51-9a7e-2f1c5d9e4b77'
const KEY = 'phc_np7sxHvzFH1HDTlQdMaqRDrpOVZ0xytnSDxyCMBwNO9' // the public, write-only key. gitleaks:allow
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/
const TODAY = new Date().toISOString().slice(0, 10)

interface Body {
  api_key: string
  event: string
  distinct_id: string
  timestamp: string
  properties: Record<string, unknown>
}
interface Received {
  ua: string | null
  type: string | null
  body: Body
}

const received: Received[] = []
let server: ReturnType<typeof Bun.serve>
let endpoint = ''
let root = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'devkit-telemetry-ts-'))
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (new URL(req.url).pathname.startsWith('/slow/')) {
        await Bun.sleep(2000)
        return new Response('late')
      }
      const body = (await req.json()) as Body
      received.push({ ua: req.headers.get('user-agent'), type: req.headers.get('content-type'), body })
      return new Response('ok')
    },
  })
  endpoint = `${server.url}i/v0/e/`
})

afterAll(() => {
  server.stop(true)
  rmSync(root, { recursive: true, force: true })
})

const newDir = () => mkdtempSync(join(root, 'state-'))
const stateFile = (dir: string) => join(dir, 'telemetry.json')
const readState = (dir: string) => JSON.parse(readFileSync(stateFile(dir), 'utf8'))

/** A state dir where the notice was already seen on an earlier run. */
function seeded(extra: Record<string, unknown> = {}): string {
  const dir = newDir()
  const state = { id: ID, enabled: null, notice: 1, installed: true, daily: {}, ...extra }
  writeFileSync(stateFile(dir), JSON.stringify(state))
  return dir
}

function make(overrides: Partial<TelemetryOptions> = {}): Telemetry {
  return createTelemetry({
    product: 'demo-cli',
    version: '1.2.3',
    envPrefix: 'DEMO_CLI',
    stateDir: overrides.stateDir ?? newDir(),
    channel: 'homebrew',
    features: ['chats list', 'sync'],
    endpoint,
    env: {},
    tty: false,
    ...overrides,
  })
}

/** Everything the server got from this client, once its requests are done. */
async function sent(t: Telemetry): Promise<Received[]> {
  await t.flush(2500)
  return received.splice(0)
}

const keyOf = (r: Received) => {
  const p = r.body.properties
  return [r.body.event, p.feature ?? p.error_type].filter(Boolean).join(':')
}

function captureStderr() {
  const spy = spyOn(process.stderr, 'write').mockImplementation(() => true)
  let lines: string[] = []
  return {
    lines: () => lines,
    restore: () => {
      lines = spy.mock.calls.map((c) => String(c[0]))
      spy.mockRestore()
    },
  }
}

describe('turning it off: the first matching rule decides', () => {
  const cases: [string, Partial<TelemetryOptions>, Record<string, unknown> | null, Reason, boolean, boolean?][] = [
    ['default', {}, null, 'default', true],
    ['no endpoint beats everything', { endpoint: '', env: { DEMO_CLI_TELEMETRY: '1' } }, null, 'no-endpoint', false],
    ['DO_NOT_TRACK=1', { env: { DO_NOT_TRACK: '1', DEMO_CLI_TELEMETRY: 'on' } }, null, 'do-not-track', false],
    ['DO_NOT_TRACK=true', { env: { DO_NOT_TRACK: 'true' } }, null, 'do-not-track', false],
    ['DO_NOT_TRACK empty', { env: { DO_NOT_TRACK: '' } }, null, 'default', true],
    ['DO_NOT_TRACK=0', { env: { DO_NOT_TRACK: '0' } }, null, 'default', true],
    ['DO_NOT_TRACK=false', { env: { DO_NOT_TRACK: 'FALSE' } }, null, 'default', true],
    ['PREFIX=0 beats enabled in state', { env: { DEMO_CLI_TELEMETRY: '0' } }, { enabled: true }, 'env', false],
    ['PREFIX=off', { env: { DEMO_CLI_TELEMETRY: 'off' } }, null, 'env', false],
    ['PREFIX=false', { env: { DEMO_CLI_TELEMETRY: 'false' } }, null, 'env', false],
    ['PREFIX=1 in CI', { env: { DEMO_CLI_TELEMETRY: '1', CI: 'true' } }, null, 'env', true],
    ['PREFIX=on with a dev version', { version: 'dev', env: { DEMO_CLI_TELEMETRY: 'on' } }, null, 'env', true],
    ['PREFIX=true beats disabled in state', { env: { DEMO_CLI_TELEMETRY: 'true' } }, { enabled: false }, 'env', true],
    ['PREFIX=debug in CI', { env: { DEMO_CLI_TELEMETRY: 'debug', GITHUB_ACTIONS: 'true' } }, null, 'env', true, true],
    ['unknown PREFIX value is ignored', { env: { DEMO_CLI_TELEMETRY: 'maybe' } }, null, 'default', true],
    ['another product prefix is ignored', { env: { OTHER_TELEMETRY: '0' } }, null, 'default', true],
    ['CI=true', { env: { CI: 'true' } }, null, 'ci', false],
    ['CI=1 beats enabled in state', { env: { CI: '1' } }, { enabled: true }, 'ci', false],
    ['CI=false', { env: { CI: 'false' } }, null, 'default', true],
    ['blank values count as unset', { env: { CI: ' ', GITHUB_ACTIONS: ' ', DO_NOT_TRACK: ' ' } }, null, 'default', true],
    ['values are trimmed', { env: { DEMO_CLI_TELEMETRY: ' Off ' } }, null, 'env', false],
    ['NODE_ENV=test', { env: { NODE_ENV: 'test' } }, null, 'test', false],
    ['VITEST', { env: { VITEST: 'true' } }, null, 'test', false],
    ['JEST_WORKER_ID', { env: { JEST_WORKER_ID: '1' } }, null, 'test', false],
    ['empty version', { version: '' }, null, 'dev-version', false],
    ['version dev', { version: 'dev' }, null, 'dev-version', false],
    ['version 0.0.0', { version: '0.0.0' }, null, 'dev-version', false],
    ['version with -dev', { version: '1.3.0-dev.4' }, null, 'dev-version', false],
    ['version devel', { version: 'devel' }, null, 'dev-version', false],
    ['version (devel)', { version: '(devel)' }, null, 'dev-version', false],
    ['version v0.0.0', { version: 'v0.0.0' }, null, 'dev-version', false],
    ['a tagged version', { version: 'v1.2.3' }, null, 'default', true],
    ['a prerelease is not a dev build', { version: '1.3.0-beta.1' }, null, 'default', true],
    ['disabled in telemetry.json', {}, { enabled: false }, 'state', false],
    ['enabled in telemetry.json', {}, { enabled: true }, 'state', true],
  ]
  for (const [name, options, state, reason, enabled, debug = false] of cases) {
    test(name, () => {
      const stateDir = state ? seeded(state) : newDir()
      expect(make({ ...options, stateDir }).status()).toEqual({
        enabled,
        debug,
        reason,
        id: state ? ID : null,
        stateFile: stateFile(stateDir),
        endpoint: options.endpoint ?? endpoint,
      })
    })
  }

  test('envPrefix defaults to the product upper-cased', () => {
    const t = make({ envPrefix: undefined, env: { DEMO_CLI_TELEMETRY: 'off' } })
    expect(t.status().reason).toBe('env')
  })

  const ciVars = ['GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'TF_BUILD', 'JENKINS_URL']
  for (const name of [...ciVars, 'TEAMCITY_VERSION', 'CODEBUILD_BUILD_ID']) {
    test(`CI variable ${name}`, () => {
      expect(make({ env: { [name]: 'x' } }).status().reason).toBe('ci')
    })
  }

  test('when off it writes nothing, prints nothing and sends nothing', async () => {
    const stateDir = join(newDir(), 'not-created')
    const t = make({ stateDir, tty: true, env: { DO_NOT_TRACK: '1', CLAUDECODE: '1' } })
    const err = captureStderr()
    expect(t.showNotice()).toBe(false)
    t.markNoticeSeen()
    t.started()
    t.feature('sync')
    t.error(new Error('boom'))
    err.restore()
    expect(await sent(t)).toEqual([])
    expect(err.lines()).toEqual([])
    expect(existsSync(stateDir)).toBe(false)
  })

  test('debug prints each event to stderr and sends nothing', async () => {
    const t = make({ stateDir: seeded(), env: { DEMO_CLI_TELEMETRY: 'debug' } })
    const err = captureStderr()
    t.feature('sync')
    err.restore()
    expect(await sent(t)).toEqual([])
    const lines = err.lines()
    expect(lines).toHaveLength(1)
    expect(lines[0]?.startsWith('[telemetry] {')).toBe(true)
    const body = JSON.parse(lines[0]?.slice('[telemetry] '.length) ?? '') as Body
    expect(body.event).toBe('feature_used')
    expect(body.properties.feature).toBe('sync')
  })
})

describe('notice', () => {
  test('nothing is sent before the notice, nor in the run that shows it', async () => {
    const dir = newDir()
    const t = make({ stateDir: dir, tty: true, offCommand: 'demo telemetry off' })
    t.started()
    expect(existsSync(stateFile(dir))).toBe(false)

    const err = captureStderr()
    expect(t.showNotice()).toBe(true)
    expect(t.showNotice()).toBe(false)
    err.restore()
    const lines = err.lines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith('demo-cli shares usage stats with its author:')
    expect(lines[0]).toContain('Nothing has been sent yet.')
    expect(lines[0]).toContain('Turn it off with `demo telemetry off` or `DO_NOT_TRACK=1`.')
    expect(lines[0]).toEndWith('Details: https://usage.sergeybaus.com\n')

    t.started()
    t.feature('sync')
    expect(await sent(t)).toEqual([])
    const state = readState(dir)
    expect(state.notice).toBe(1)
    expect(state.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(state.installed).toBe(false)

    const next = make({ stateDir: dir, tty: true })
    expect(next.showNotice()).toBe(false)
    next.started()
    const got = await sent(next)
    expect(got.map(keyOf).sort()).toEqual(['app_installed', 'app_started'])
    expect(got.every((r) => r.body.distinct_id === state.id)).toBe(true)
  })

  test('noticeText is the notice while it is due, for apps and plugins', () => {
    const dir = newDir()
    const t = make({ stateDir: dir, mode: 'plugin' })
    expect(t.noticeText()).toBe(
      'demo-cli shares usage stats with its author: how often it runs, which features are used, errors, version and OS, tied to a random install ID. It never sends your files, arguments or account names. Nothing has been sent yet. Turn it off with `demo-cli telemetry off` or `DO_NOT_TRACK=1`. Details: https://usage.sergeybaus.com',
    )
    expect(existsSync(stateFile(dir))).toBe(false)
    t.markNoticeSeen()
    expect(t.noticeText()).toBeNull()
    expect(make({ env: { DO_NOT_TRACK: '1' } }).noticeText()).toBeNull()
  })

  test('only in a terminal or under an agent', () => {
    const dir = newDir()
    expect(make({ stateDir: dir, tty: false }).showNotice()).toBe(false)
    expect(existsSync(stateFile(dir))).toBe(false)

    const err = captureStderr()
    const shown = make({ stateDir: dir, tty: false, env: { CODEX_THREAD_ID: 't' } }).showNotice()
    err.restore()
    expect(shown).toBe(true)
    expect(err.lines()[0]).toContain('`demo-cli telemetry off`')
  })

  test('markNoticeSeen records it without printing; that run sends nothing', async () => {
    const dir = newDir()
    const t = make({ stateDir: dir, mode: 'app' })
    const err = captureStderr()
    t.markNoticeSeen()
    t.started()
    err.restore()
    expect(err.lines()).toEqual([])
    expect(await sent(t)).toEqual([])
    expect(readState(dir).notice).toBe(1)

    const next = make({ stateDir: dir, mode: 'app' })
    next.started()
    expect((await sent(next)).map(keyOf).sort()).toEqual(['app_installed', 'app_started'])
  })
})

describe('events', () => {
  test('the exact request', async () => {
    const t = make({ stateDir: seeded(), env: { CLAUDECODE: '1' } })
    t.feature('chats list')
    const [r, ...rest] = await sent(t)
    expect(rest).toEqual([])
    expect(r?.ua).toBe('devkit-telemetry/1 (demo-cli/1.2.3)')
    expect(r?.type).toBe('application/json')
    const names: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }
    expect(r?.body).toEqual({
      api_key: KEY,
      event: 'feature_used',
      distinct_id: ID,
      timestamp: expect.stringMatching(ISO),
      properties: {
        $process_person_profile: false,
        $lib: 'devkit-telemetry',
        $lib_version: '1',
        product: 'demo-cli',
        $app_version: '1.2.3',
        $os: names[process.platform] ?? process.platform,
        $os_version: expect.stringMatching(/^\d+(\.\d+)*/),
        arch: process.arch,
        runtime: `bun ${Bun.version}`,
        channel: 'homebrew',
        mode: 'agent',
        agent: 'claude-code',
        feature: 'chats list',
      },
    })
    expect(Object.keys(r?.body ?? {})).toEqual(['api_key', 'event', 'distinct_id', 'timestamp', 'properties'])
    expect(Object.keys(r?.body.properties ?? {})).toEqual([
      '$process_person_profile',
      '$lib',
      '$lib_version',
      'product',
      '$app_version',
      '$os',
      '$os_version',
      'arch',
      'runtime',
      'channel',
      'mode',
      'agent',
      'feature',
    ])
  })

  test('app_installed goes out once, with the first event of the install', async () => {
    const dir = seeded({ installed: false })
    const t = make({ stateDir: dir })
    t.feature('sync')
    t.started()
    const got = await sent(t)
    expect(got.map(keyOf).sort()).toEqual(['app_installed', 'app_started', 'feature_used:sync'])
    expect(got.find((r) => r.body.event === 'app_installed')?.body.properties.feature).toBeUndefined()
    expect(readState(dir).installed).toBe(true)

    const next = make({ stateDir: dir })
    next.started()
    expect((await sent(next)).map(keyOf)).toEqual(['app_started'])
  })

  test('features outside the list are sent as "other"', async () => {
    const t = make({ stateDir: seeded() })
    t.feature('sync')
    t.feature('chats list')
    t.feature('chats list --limit 5')
    t.feature('Sync')
    const got = await sent(t)
    expect(got.map(keyOf).sort()).toEqual([
      'feature_used:chats list',
      'feature_used:other',
      'feature_used:other',
      'feature_used:sync',
    ])

    const none = make({ stateDir: seeded(), features: undefined })
    none.feature('sync')
    expect((await sent(none)).map(keyOf)).toEqual(['feature_used:other'])
  })

  test('errors: type from code or class, message scrubbed and cut to 300 characters', async () => {
    const home = '/home/annexample'
    const user = 'annexample'
    const errors: Record<string, unknown> = {
      fs: Object.assign(new Error(`open '${home}/notes/a.txt' failed for ${user} today\n`), { code: 'ENOENT' }),
      cls: new (class FloodWait extends Error {})('wait 30 seconds'),
      named: Object.assign(new Error('bad value'), { name: 'ValueError' }),
      builtin: new TypeError('x is not a function'),
      long: new RangeError('y'.repeat(1000)),
      plain: new Error(''),
    }
    const t = make({ stateDir: seeded(), env: { HOME: home, USER: user } })
    for (const err of Object.values(errors)) t.error(err)
    t.error('Unauthorized')
    t.error(42)
    const got = new Map((await sent(t)).map((r) => [r.body.properties.error_type, r.body.properties]))
    expect(got.get('ENOENT')?.error_message).toBe(`open '~/notes/a.txt' failed for <user> today`)
    expect(got.get('FloodWait')?.error_message).toBe('wait 30 seconds')
    expect(got.get('ValueError')?.error_message).toBe('bad value')
    expect(got.get('TypeError')?.error_message).toBe('x is not a function')
    expect(got.get('RangeError')?.error_message).toBe('y'.repeat(300))
    expect(got.get('Error')).toBeDefined()
    expect(got.get('Error')).not.toHaveProperty('error_message')
    expect(got.get('Unauthorized')).not.toHaveProperty('error_message')
    expect(got.size).toBe(7)
  })

  test('scrubbing: one pass, any case, whole words only, both slash forms', async () => {
    const cases: [Env, string, string][] = [
      [{ HOME: '/Users/Ann', USER: 'ann' }, 'read /users/ann/x and /Users/annabel/y as ANN', 'read ~/x and /Users/annabel/y as <user>'],
      [{ HOME: 'C:\\Users\\ann', USERNAME: 'ann' }, 'C:\\Users\\Ann\\a and C:/Users/ann/b', '~\\a and ~/b'],
      [{ HOME: '/home/user', USER: 'user', LOGNAME: 'user' }, 'user wrote to /home/user/z', '<user> wrote to ~/z'],
      [{ HOME: '/home/annexample', LOGNAME: 'ann' }, 'ann and annexample annotate', '<user> and <user> annotate'],
      [{ HOME: '/', USER: 'a' }, ' a / b ', 'a / b'],
    ]
    for (const [env, message, want] of cases) {
      const t = make({ stateDir: seeded(), env })
      t.error(Object.assign(new Error(message), { code: 'E' }))
      const [r] = await sent(t)
      expect(r?.body.properties.error_message).toBe(want)
    }
  })

  for (const mode of ['scheduled', 'daemon', 'plugin'] as const) {
    test(`${mode}: at most once per UTC day per event and feature or error type`, async () => {
      const dir = seeded({ daily: { 'feature_used:sync': '2000-01-01' } })
      const t = make({ stateDir: dir, mode })
      for (let i = 0; i < 3; i++) {
        t.started()
        t.feature('sync')
        t.feature('chats list')
        t.error('ENOENT')
      }
      t.error('EACCES')
      expect((await sent(t)).map(keyOf).sort()).toEqual([
        'app_started',
        'error_occurred:EACCES',
        'error_occurred:ENOENT',
        'feature_used:chats list',
        'feature_used:sync',
      ])
      expect(readState(dir).daily).toEqual({
        app_started: TODAY,
        'feature_used:sync': TODAY,
        'feature_used:chats list': TODAY,
        'error_occurred:ENOENT': TODAY,
        'error_occurred:EACCES': TODAY,
      })

      const sameDay = make({ stateDir: dir, mode })
      sameDay.started()
      expect(await sent(sameDay)).toEqual([])

      const state = readState(dir)
      writeFileSync(stateFile(dir), JSON.stringify({ ...state, daily: { app_started: '2000-01-01' } }))
      const nextDay = make({ stateDir: dir, mode })
      nextDay.started()
      nextDay.started()
      expect((await sent(nextDay)).map(keyOf)).toEqual(['app_started'])
    })
  }

  test('other modes send every event', async () => {
    for (const mode of ['interactive', 'script', 'agent', 'app', 'server'] as const) {
      const dir = seeded()
      const t = make({ stateDir: dir, mode })
      t.started()
      t.started()
      expect((await sent(t)).map(keyOf)).toEqual(['app_started', 'app_started'])
      expect(readState(dir).daily).toEqual({})
    }
  })
})

describe('agent and mode detection', () => {
  const cases: [Env, boolean, Mode | undefined, string, string | undefined][] = [
    [{}, false, undefined, 'script', undefined],
    [{}, true, undefined, 'interactive', undefined],
    [{ AI_AGENT: 'OpenCode_1.2' }, true, undefined, 'agent', 'opencode'],
    [{ AI_AGENT: 'amp', CLAUDECODE: '1' }, false, undefined, 'agent', 'amp'],
    [{ CLAUDECODE: '1', CODEX_THREAD_ID: 't' }, false, undefined, 'agent', 'claude-code'],
    [{ CODEX_SANDBOX: 'seatbelt' }, false, undefined, 'agent', 'codex'],
    [{ CODEX_THREAD_ID: 't' }, false, undefined, 'agent', 'codex'],
    [{ CURSOR_AGENT: '1' }, false, undefined, 'agent', 'cursor'],
    [{ GEMINI_CLI: '1' }, false, undefined, 'agent', 'gemini'],
    [{ CLAUDECODE: '' }, false, undefined, 'script', undefined],
    [{ CLAUDECODE: '1' }, true, 'daemon', 'daemon', 'claude-code'],
    [{}, true, 'server', 'server', undefined],
  ]
  for (const [env, tty, mode, wantMode, wantAgent] of cases) {
    test(`${JSON.stringify(env)} tty=${tty} mode=${mode} -> ${wantMode} ${wantAgent}`, async () => {
      const t = make({ stateDir: seeded(), env, tty, mode })
      t.started()
      const [r] = await sent(t)
      expect(r?.body.properties.mode).toBe(wantMode)
      expect(r?.body.properties.agent).toBe(wantAgent)
      expect(Object.hasOwn(r?.body.properties ?? {}, 'agent')).toBe(wantAgent !== undefined)
    })
  }
})

describe('state file', () => {
  test('is written through a temp file and has the documented shape', async () => {
    const dir = seeded({ installed: false })
    const t = make({ stateDir: dir })
    t.started()
    expect(await sent(t)).toHaveLength(2)
    expect(readdirSync(dir)).toEqual(['telemetry.json'])
    const state = readState(dir)
    expect(Object.keys(state)).toEqual(['id', 'enabled', 'notice', 'installed', 'daily'])
    expect(state).toEqual({ id: ID, enabled: null, notice: 1, installed: true, daily: {} })
    // The same bytes the Go and Python clients write.
    expect(readFileSync(stateFile(dir), 'utf8')).toBe(`{"id":"${ID}","enabled":null,"notice":1,"installed":true,"daily":{}}\n`)
  })

  test('a broken file counts as a fresh install', () => {
    const dir = newDir()
    writeFileSync(stateFile(dir), '{not json')
    const err = captureStderr()
    const shown = make({ stateDir: dir, tty: true }).showNotice()
    err.restore()
    expect(shown).toBe(true)
    expect(readState(dir).notice).toBe(1)
  })

  test('a state directory that cannot be written means nothing is sent', async () => {
    const file = join(newDir(), 'a-file')
    writeFileSync(file, '')
    const t = make({ stateDir: file, tty: true })
    const err = captureStderr()
    expect(t.showNotice()).toBe(false)
    t.markNoticeSeen()
    err.restore()
    expect(err.lines()).toEqual([])
    expect(t.setEnabled(true)).toBe(false)

    if (process.getuid?.() === 0) return // root ignores file modes
    const dir = seeded({ installed: false })
    chmodSync(dir, 0o500)
    try {
      const ro = make({ stateDir: dir })
      ro.started()
      expect(await sent(ro)).toEqual([])
    } finally {
      chmodSync(dir, 0o700)
    }
  })

  test('off deletes the id and the counters; on marks the notice seen with a new id', async () => {
    const dir = seeded({ daily: { app_started: TODAY } })
    const t = make({ stateDir: dir })
    expect(t.setEnabled(false)).toBe(true)
    expect(readState(dir)).toEqual({ id: null, enabled: false, notice: 1, installed: false, daily: {} })
    expect(t.status()).toMatchObject({ enabled: false, reason: 'state', id: null })
    t.started()
    expect(await sent(t)).toEqual([])

    const fresh = newDir()
    const on = make({ stateDir: fresh })
    expect(on.setEnabled(true)).toBe(true)
    const state = readState(fresh)
    expect(state).toMatchObject({ enabled: true, notice: 1, installed: false })
    expect(state.id).not.toBe(ID)
    expect(on.status()).toMatchObject({ enabled: true, reason: 'state', id: state.id })
    on.started() // an explicit opt-in is not a notice run
    expect((await sent(on)).map(keyOf).sort()).toEqual(['app_installed', 'app_started'])

    // After off, an env override sends again under a new id.
    expect(on.setEnabled(false)).toBe(true)
    const forced = make({ stateDir: fresh, env: { DEMO_CLI_TELEMETRY: '1' } })
    expect(forced.showNotice()).toBe(false) // the notice was already seen
    forced.started()
    const again = await sent(forced)
    expect(again.map(keyOf).sort()).toEqual(['app_installed', 'app_started'])
    expect(again[0]?.body.distinct_id).not.toBe(state.id)
    expect(readState(fresh).id).toBe(again[0]?.body.distinct_id)
  })
})

describe('capture', () => {
  const web = { product: 'demo-web', version: '2.0.0', channel: 'web', mode: 'server', endpoint, env: {} } as const

  test('sends one event with the given id, the common properties and no state', async () => {
    await capture('feature_used', { feature: 'redact' }, 'k-1', { ...web, endpoint })
    const [r, ...rest] = received.splice(0)
    expect(rest).toEqual([])
    expect(r?.ua).toBe('devkit-telemetry/1 (demo-web/2.0.0)')
    expect(r?.body).toEqual({
      api_key: KEY,
      event: 'feature_used',
      distinct_id: 'k-1',
      timestamp: expect.stringMatching(ISO),
      properties: {
        $process_person_profile: false,
        $lib: 'devkit-telemetry',
        $lib_version: '1',
        product: 'demo-web',
        $app_version: '2.0.0',
        $os: expect.any(String),
        $os_version: expect.any(String),
        arch: process.arch,
        runtime: `bun ${Bun.version}`,
        channel: 'web',
        mode: 'server',
        feature: 'redact',
      },
    })

    await capture('app_started', {}, '', { ...web, endpoint, channel: undefined })
    const [anon] = received.splice(0)
    expect(anon?.body.distinct_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(anon?.body.properties).not.toHaveProperty('channel')
  })

  test('follows the environment rules', async () => {
    const off: [Env, string?][] = [
      [{ DO_NOT_TRACK: '1' }],
      [{ CI: 'true' }],
      [{ NODE_ENV: 'test' }],
      [{ DEMO_WEB_TELEMETRY: 'off' }],
      [{}, ''],
      [{}, 'dev'],
    ]
    for (const [env, version = '2.0.0'] of off) {
      await capture('app_started', {}, 'k-2', { ...web, endpoint, env, version })
    }
    await capture('app_started', {}, 'k-2', { ...web, endpoint: '' })
    await capture('', {}, 'k-2', { ...web, endpoint })
    expect(received.splice(0)).toEqual([])

    await capture('app_started', {}, 'k-3', { ...web, endpoint, env: { CI: '1', DEMO_WEB_TELEMETRY: '1' } })
    expect(received.splice(0).map((r) => r.body.distinct_id)).toEqual(['k-3'])
  })
})

describe('never blocks, never throws', () => {
  test('flush returns at once when nothing is in flight', async () => {
    const start = performance.now()
    await make().flush(5000)
    expect(performance.now() - start).toBeLessThan(100)
  })

  test('flush waits only up to its limit', async () => {
    const t = make({ stateDir: seeded(), endpoint: `${server.url}slow/` })
    t.started()
    const start = performance.now()
    await t.flush(100)
    const took = performance.now() - start
    expect(took).toBeGreaterThanOrEqual(90)
    expect(took).toBeLessThan(1000)
  })

  test('bad input and an unreachable endpoint are swallowed', async () => {
    const t = make({ stateDir: seeded(), endpoint: 'http://127.0.0.1:9/i/v0/e/' })
    t.started()
    t.error(null)
    t.error(undefined)
    t.error(Object.create(null))
    t.feature(undefined as unknown as string)
    await t.flush(3500)
    const web = { product: 'demo-web', version: '2.0.0', env: {} }
    await expect(capture('x', null as unknown as Record<string, unknown>, 'id', { ...web, endpoint })).resolves.toBeUndefined()
    await expect(capture('x', {}, 'id', { ...web, endpoint: 'not a url' })).resolves.toBeUndefined()
    await expect(capture('x', {}, 'id', undefined as unknown as CaptureOptions)).resolves.toBeUndefined()
    expect(received.splice(0).map((r) => r.body.event)).toEqual(['x']) // null properties are just empty
  })
})
