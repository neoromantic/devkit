import { describe, expect, test } from 'bun:test'
import { mkdtemp, readlink, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Repo } from '../scripts/lib/repos'
import { syncCheckout } from '../scripts/sync'

const repo: Repo = {
  name: 'demo',
  owner: 'someone',
  fullName: 'someone/demo',
  profile: 'bun',
  files: { 'SECURITY.md': 'SECURITY.md', 'renovate.json': 'renovate.json' },
  settings: {},
}

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'devkit-sync-test-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('syncCheckout', () => {
  test('creates managed files, AGENTS.md and CLAUDE.md in an empty repo, then is idempotent', () =>
    withDir(async (dir) => {
      const first = await syncCheckout(repo, dir, { adopt: false })
      expect(first.map((c) => `${c.action} ${c.path}`)).toEqual([
        'create SECURITY.md',
        'create renovate.json',
        'create AGENTS.md',
        'create CLAUDE.md',
      ])
      expect(await Bun.file(join(dir, 'SECURITY.md')).text()).toContain('someone/demo/security/advisories/new')
      expect(await Bun.file(join(dir, 'CLAUDE.md')).text()).toBe('@AGENTS.md\n')
      const second = await syncCheckout(repo, dir, { adopt: false })
      expect(second.every((c) => c.action === 'ok')).toBe(true)
    }))

  test('leaves unmanaged files alone unless adopting', () =>
    withDir(async (dir) => {
      await Bun.write(join(dir, 'SECURITY.md'), 'hand written\n')
      const skip = await syncCheckout(repo, dir, { adopt: false })
      expect(skip.find((c) => c.path === 'SECURITY.md')?.action).toBe('skip')
      expect(await Bun.file(join(dir, 'SECURITY.md')).text()).toBe('hand written\n')
      const adopt = await syncCheckout(repo, dir, { adopt: true })
      expect(adopt.find((c) => c.path === 'SECURITY.md')?.action).toBe('adopt')
    }))

  test('never writes through a symlinked AGENTS.md', () =>
    withDir(async (dir) => {
      await Bun.write(join(dir, 'CLAUDE.md'), '# rules\n')
      await symlink('CLAUDE.md', join(dir, 'AGENTS.md'))
      const changes = await syncCheckout(repo, dir, { adopt: false })
      expect(changes.find((c) => c.path === 'AGENTS.md')?.action).toBe('warn')
      expect(await Bun.file(join(dir, 'CLAUDE.md')).text()).toBe('# rules\n')
      expect(await readlink(join(dir, 'AGENTS.md'))).toBe('CLAUDE.md')
    }))
})
