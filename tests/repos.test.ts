import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { isManaged, render, templateVars } from '../scripts/lib/managed'
import { AGENTS_BLOCK_PATH, isFrozen, loadReposFile, resolveRepos, TEMPLATES_DIR } from '../scripts/lib/repos'
import {
  applyPlan,
  desiredRuleset,
  desiredState,
  diffRuleset,
  diffSettings,
  formatDiff,
  formatRulesetDiff,
  RULESET_NAME,
  type RepoState,
  rulesetFromApi,
  stateFromApi,
} from '../scripts/repo-settings'

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

  test('topics diff lists only added and removed topics', () => {
    const [d] = diffSettings(current, { topics: ['a', 'c', 'b'] })
    expect(d && formatDiff(d)).toBe('topics: +[c]')
    const [r] = diffSettings(current, { topics: ['a', 'd'] })
    expect(r && formatDiff(r)).toBe('topics: +[d] -[b]')
    const [s] = diffSettings(current, { description: 'new' })
    expect(s && formatDiff(s)).toBe('description: "old" -> "new"')
  })

  test('desired state merges defaults with repo fields', () => {
    const devkit = repos.find((r) => r.name === 'devkit')
    expect(devkit && desiredState(devkit)).toMatchObject({ has_wiki: false, delete_branch_on_merge: true })
  })
})

describe('main ruleset', () => {
  const want = desiredRuleset(['ci'])

  // The shape GET /repos/{owner}/{repo}/rulesets/{id} returns after --apply created it.
  const applied = {
    id: 1,
    name: RULESET_NAME,
    target: 'branch',
    source_type: 'Repository',
    enforcement: 'active',
    conditions: { ref_name: { exclude: [], include: ['~DEFAULT_BRANCH'] } },
    rules: [
      { type: 'non_fast_forward' },
      { type: 'deletion' },
      {
        type: 'required_status_checks',
        parameters: {
          do_not_enforce_on_create: false,
          strict_required_status_checks_policy: false,
          required_status_checks: [{ context: 'ci' }],
        },
      },
    ],
    bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
  }

  test('requires the checks on the default branch, admins bypass', () => {
    expect(want).toEqual({
      name: 'main (devkit)',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [
        { type: 'deletion' },
        { type: 'non_fast_forward' },
        {
          type: 'required_status_checks',
          parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'ci' }] },
        },
      ],
      bypass_actors: [{ actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'always' }],
    })
    expect(desiredRuleset([]).rules.map((r) => r.type)).toEqual(['deletion', 'non_fast_forward'])
  })

  test('a missing ruleset reads as one line that lists what --apply creates', () => {
    const diffs = diffRuleset(null, want)
    expect(diffs).toHaveLength(1)
    const [d] = diffs
    expect(d && formatRulesetDiff(d, want)).toBe(
      'ruleset "main (devkit)": missing -> rules [deletion, non_fast_forward, required_status_checks], required checks [ci], bypass [RepositoryRole:5:always]',
    )
  })

  test('the ruleset GitHub returns after apply is ok, whatever the order of rules', () => {
    expect(diffRuleset(rulesetFromApi(applied), want)).toEqual([])
  })

  test('a changed check, strict mode or bypass shows up', () => {
    const drifted = rulesetFromApi({
      ...applied,
      rules: [
        { type: 'deletion' },
        {
          type: 'required_status_checks',
          parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'build' }] },
        },
      ],
      bypass_actors: [],
    })
    const lines = diffRuleset(drifted, want).map((d) => formatRulesetDiff(d, want))
    expect(lines).toEqual([
      'ruleset.rules: +[non_fast_forward]',
      'ruleset.required_checks: +[ci] -[build]',
      'ruleset.strict: "true" -> "false"',
      'ruleset.bypass: +[RepositoryRole:5:always]',
    ])
  })

  test('the tap never gets required checks', () => {
    expect(repos.find((r) => r.name === 'homebrew-tap')?.required_checks).toBeUndefined()
    expect(repos.find((r) => r.name === 'homebrew-tap')?.files['renovate.json']).toBeUndefined()
  })
})
