import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { isManaged, render, templateVars } from '../scripts/lib/managed'
import { AGENTS_BLOCK_PATH, isFrozen, loadReposFile, resolveRepos, TEMPLATES_DIR } from '../scripts/lib/repos'
import { applyPlan, desiredState, diffSettings, type RepoState, stateFromApi } from '../scripts/repo-settings'

const repos = resolveRepos(await loadReposFile())

describe('repos.yml', () => {
  test('every repo resolves and every template exists, renders and carries the mark', async () => {
    expect(repos.length).toBeGreaterThan(0)
    for (const repo of repos) {
      for (const template of Object.values(repo.files)) {
        const file = Bun.file(join(TEMPLATES_DIR, template))
        expect(await file.exists()).toBe(true)
        const out = render(await file.text(), templateVars(repo))
        expect(isManaged(out)).toBe(true)
      }
    }
  })

  test('evals gets the maintenance Renovate preset', async () => {
    const evals = repos.find((r) => r.name === 'evals')
    expect(evals).toBeDefined()
    if (!evals) return
    const out = render(await Bun.file(join(TEMPLATES_DIR, 'renovate.json')).text(), templateVars(evals))
    expect(JSON.parse(out).extends).toEqual(['github>neoromantic/devkit//renovate/maintenance'])
  })

  test('devkit itself matches its own templates', async () => {
    const devkit = repos.find((r) => r.name === 'devkit')
    expect(devkit).toBeDefined()
    if (!devkit) return
    for (const [target, template] of Object.entries(devkit.files)) {
      const want = render(await Bun.file(join(TEMPLATES_DIR, template)).text(), templateVars(devkit))
      expect(await Bun.file(join(TEMPLATES_DIR, '..', target)).text()).toBe(want)
    }
  })

  test('the shared AGENTS block has markers and stays short', async () => {
    const block = await Bun.file(AGENTS_BLOCK_PATH).text()
    expect(block.startsWith('<!-- devkit:agents v1 -->')).toBe(true)
    expect(block.trim().endsWith('<!-- /devkit:agents -->')).toBe(true)
    expect(block.trim().split('\n').length).toBeLessThanOrEqual(80)
  })
})

describe('isFrozen', () => {
  test('frozen until the date, inclusive', () => {
    const repo = { profile: 'go', frozen_until: '2026-10-27' }
    expect(isFrozen(repo, new Date('2026-10-27T23:00:00Z'))).toBe(true)
    expect(isFrozen(repo, new Date('2026-10-28T00:00:00Z'))).toBe(false)
    expect(isFrozen({ profile: 'go', frozen: true })).toBe(true)
    expect(isFrozen({ profile: 'go' })).toBe(false)
  })
})

describe('repo-settings', () => {
  const current: RepoState = stateFromApi({
    description: 'old',
    homepage: null,
    topics: ['b', 'a'],
    has_wiki: true,
    has_projects: false,
    delete_branch_on_merge: false,
    security_and_analysis: {
      secret_scanning: { status: 'enabled' },
      secret_scanning_push_protection: { status: 'disabled' },
    },
  })

  test('diff ignores order of topics and unmanaged fields', () => {
    const diffs = diffSettings(current, {
      description: 'new',
      topics: ['a', 'b'],
      has_wiki: false,
      has_projects: false,
      secret_scanning: true,
      secret_scanning_push_protection: true,
    })
    expect(diffs.map((d) => d.field)).toEqual(['description', 'has_wiki', 'secret_scanning_push_protection'])
  })

  test('apply plan splits topics and security settings', () => {
    const plan = applyPlan(
      diffSettings(current, { description: 'new', topics: ['c'], secret_scanning_push_protection: true }),
    )
    expect(plan).toEqual({
      patch: { description: 'new', security_and_analysis: { secret_scanning_push_protection: { status: 'enabled' } } },
      topics: ['c'],
      privateVulnerabilityReporting: null,
    })
    expect(applyPlan(diffSettings(current, { private_vulnerability_reporting: true })).privateVulnerabilityReporting).toBe(
      true,
    )
  })

  test('desired state merges defaults with repo fields', () => {
    const devkit = repos.find((r) => r.name === 'devkit')
    expect(devkit && desiredState(devkit)).toMatchObject({ has_wiki: false, delete_branch_on_merge: true })
  })
})
