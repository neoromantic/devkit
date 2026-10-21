import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { ROOT, type Repo } from '../scripts/lib/repos'
import { syncCheckout } from '../scripts/sync'

const dir = await mkdtemp(join(tmpdir(), 'devkit-commands-'))
const source = join(dir, 'source')
const log = join(dir, 'calls.jsonl')
const sha = '1'.repeat(40)
const repo: Repo = {
  name: 'demo', owner: 'someone', fullName: 'someone/demo', profile: 'infra', agents: false,
  files: { 'SECURITY.md': 'SECURITY.md' }, settings: { has_wiki: false }, required_checks: ['ci'],
}

beforeAll(async () => {
  await mkdir(join(dir, 'bin'))
  await mkdir(source)
  await syncCheckout(repo, source, { adopt: false })
  for (const args of [
    ['init', '--quiet', '--initial-branch=main'], ['add', '.'],
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture'],
  ]) expect(Bun.spawnSync(['git', ...args], { cwd: source }).exitCode).toBe(0)
  const config = {
    owner: 'someone', profiles: { infra: { files: repo.files } },
    repos: { demo: repo, other: { profile: 'infra', agents: false } },
  }
  await Bun.write(join(dir, 'fleet.yml'), JSON.stringify(config))
  await Bun.write(join(dir, 'settings.yml'), JSON.stringify({ ...config, repos: {
    demo: { ...repo, required_checks: undefined },
  } }))
  await Bun.write(join(dir, 'frozen.yml'), JSON.stringify({ ...config, repos: { demo: { ...repo, frozen: true } } }))
  await Bun.write(join(dir, 'unmanaged.yml'), JSON.stringify({ ...config, profiles: { infra: {} }, repos: {
    demo: { profile: 'infra', agents: false },
  } }))
  await Bun.write(join(dir, 'bin', 'gh'), `#!/usr/bin/env bun
import { appendFileSync, unlinkSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
appendFileSync(process.env.DEVKIT_TEST_LOG, JSON.stringify(args) + '\\n')
const mode = process.env.DEVKIT_TEST_MODE
if (mode === 'error') { console.error('unavailable'); process.exit(1) }
if (args[0] === 'repo' && args[1] === 'clone') {
  const target = args[3]
  const clone = Bun.spawnSync(['git', 'clone', '--quiet', process.env.DEVKIT_TEST_SOURCE, target])
  if (clone.exitCode) process.exit(clone.exitCode)
  if (mode === 'drift') await Bun.write(join(target, 'SECURITY.md'), '# managed by devkit v1\\nold\\n')
  if (mode === 'unmanaged') await Bun.write(join(target, 'SECURITY.md'), 'hand written\\n')
  if (mode === 'symlink') {
    unlinkSync(join(target, 'SECURITY.md'))
    symlinkSync('missing', join(target, 'SECURITY.md'))
  }
  process.exit(0)
}
if (args[0] !== 'api' || args.includes('-X')) process.exit(2)
const path = args.at(-1)
const sha = '${sha}'
let body
if (path === 'repos/someone/demo') body = {
  default_branch: 'main', description: '', homepage: '', topics: [], has_wiki: mode === 'drift', has_projects: false,
}
else if (path.endsWith('/rulesets?includes_parents=false&per_page=100')) body = []
else if (path.endsWith('/commits/main')) body = { sha }
else if (path.includes('/check-runs?')) {
  let checks = [{ name: 'ci', head_sha: sha, status: 'completed', conclusion: 'success', details_url: 'https://example.com/ci' }]
  if (mode.startsWith('legacy') || mode === 'missing') checks = []
  if (mode === 'wrong-head') checks[0].head_sha = '2'.repeat(40)
  if (mode === 'missing-required') checks[0].name = 'other'
  if (mode === 'pending') { checks[0].status = 'in_progress'; checks[0].conclusion = null }
  body = [{ check_runs: [] }, { check_runs: checks }]
}
else if (path.includes('/statuses?')) {
  const statuses = []
  if (mode.startsWith('legacy')) {
    let state = 'success'
    if (mode === 'legacy-failed') state = 'failure'
    statuses.push({ context: 'ci', state, target_url: 'https://example.com/status' })
    statuses.push({ context: 'ci', state: 'failure', target_url: 'https://example.com/old' })
  }
  body = [statuses]
}
else if (path.includes('/releases?')) {
  const release = { tag_name: 'v1.0.0', html_url: 'https://example.com/release', draft: false, prerelease: false, published_at: '2026-01-01' }
  body = [[{ ...release, tag_name: 'v2.0.0', draft: true }, { ...release, tag_name: 'v2.0.0-rc', prerelease: true }], [release]]
  if (mode === 'no-release') body = [[]]
}
else process.exit(3)
console.log(JSON.stringify(body))
`)
  await chmod(join(dir, 'bin', 'gh'), 0o755)
})

afterAll(() => rm(dir, { recursive: true, force: true }))

describe('read-only CLI modes', () => {
  for (const scenario of [
    { command: 'sync', mode: 'ok', config: 'fleet.yml', code: 0, status: 'ok' },
    { command: 'sync', mode: 'drift', config: 'fleet.yml', code: 1, status: 'drift' },
    { command: 'sync', mode: 'unmanaged', config: 'fleet.yml', code: 1, status: 'blocked' },
    { command: 'sync', mode: 'symlink', config: 'fleet.yml', code: 1, status: 'blocked' },
    { command: 'sync', mode: 'ok', config: 'frozen.yml', code: 1, status: 'frozen' },
    { command: 'sync', mode: 'ok', config: 'unmanaged.yml', code: 1, status: 'unmanaged' },
    { command: 'sync', mode: 'error', config: 'fleet.yml', code: 2, status: 'error' },
    { command: 'repo-settings', mode: 'ok', config: 'fleet.yml', code: 1, status: 'drift' },
    { command: 'repo-settings', mode: 'ok', config: 'settings.yml', code: 0, status: 'ok' },
    { command: 'repo-settings', mode: 'drift', config: 'settings.yml', code: 1, status: 'drift' },
    { command: 'repo-settings', mode: 'drift', config: 'fleet.yml', code: 1, status: 'drift' },
    { command: 'repo-settings', mode: 'ok', config: 'frozen.yml', code: 1, status: 'frozen' },
    { command: 'repo-settings', mode: 'ok', config: 'unmanaged.yml', code: 1, status: 'unmanaged' },
    { command: 'repo-settings', mode: 'error', config: 'fleet.yml', code: 2, status: 'error' },
    { command: 'status', mode: 'ok', config: 'fleet.yml', code: 0, status: 'passed' },
    { command: 'status', mode: 'legacy', config: 'fleet.yml', code: 0, status: 'passed' },
    { command: 'status', mode: 'legacy-failed', config: 'fleet.yml', code: 1, status: 'failed' },
    { command: 'status', mode: 'wrong-head', config: 'fleet.yml', code: 1, status: 'missing' },
    { command: 'status', mode: 'missing', config: 'fleet.yml', code: 1, status: 'missing' },
    { command: 'status', mode: 'missing-required', config: 'fleet.yml', code: 1, status: 'missing' },
    { command: 'status', mode: 'pending', config: 'fleet.yml', code: 1, status: 'pending' },
    { command: 'status', mode: 'no-release', config: 'fleet.yml', code: 0, status: 'passed' },
    { command: 'status', mode: 'error', config: 'fleet.yml', code: 2, status: 'unknown' },
  ]) {
    test(`${scenario.command}: ${scenario.mode} (${scenario.config})`, async () => {
      await Bun.write(log, '')
      const args = [process.execPath, join(ROOT, 'scripts/cli.ts'), scenario.command,
        '--config', scenario.config, '--only=demo', '--json']
      if (scenario.command !== 'status') args.push('--check')
      const result = Bun.spawnSync(args, { cwd: dir, env: {
        ...process.env, PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}`,
        DEVKIT_TEST_LOG: log, DEVKIT_TEST_SOURCE: source, DEVKIT_TEST_MODE: scenario.mode,
      } })
      expect(result.stderr.toString()).toBe('')
      expect(result.exitCode).toBe(scenario.code)
      const rows = JSON.parse(result.stdout.toString())
      expect(rows).toHaveLength(1)
      expect(rows[0].repo).toBe('someone/demo')
      if (scenario.command === 'status') {
        expect(rows[0].ci).toBe(scenario.status)
        if (scenario.mode !== 'error') expect(rows[0].sha).toBe(sha)
        if (scenario.mode === 'no-release') expect(rows[0].release).toBeNull()
        else if (scenario.code === 0) expect(rows[0].release.tag).toBe('v1.0.0')
        if (scenario.mode === 'legacy') expect(rows[0].checks).toHaveLength(1)
        if (scenario.mode === 'missing-required') expect(rows[0].missing_checks).toEqual(['ci'])
      } else expect(rows[0].status).toBe(scenario.status)
      if (scenario.mode === 'unmanaged') expect(rows[0].changes[0].action).toBe('skip')
      if (scenario.mode === 'symlink') expect(rows[0].changes[0].action).toBe('warn')
      const calls = (await Bun.file(log).text()).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      expect(calls.every((args: string[]) => args[0] === 'api' && !args.includes('-X') || args[0] === 'repo' && args[1] === 'clone')).toBe(true)
      if (scenario.command === 'status' && scenario.mode !== 'error') {
        expect(calls.some((args: string[]) => args.at(-1)!.includes(`/commits/${sha}/check-runs`))).toBe(true)
        expect(calls.some((args: string[]) => args.at(-1)!.includes(`/commits/${sha}/statuses`))).toBe(true)
      }
    })
  }
  for (const args of [
    ['sync', '--check', '--write'], ['repo-settings', '--check', '--apply'],
    ['sync', '--config'], ['status', '--unknown'],
  ]) {
    test(`rejects invalid flags: ${args.join(' ')}`, () => {
      const result = Bun.spawnSync([process.execPath, join(ROOT, 'scripts/cli.ts'), ...args])
      expect(result.exitCode).toBe(2)
      expect(result.stdout.toString()).toBe('')
    })
  }
})
