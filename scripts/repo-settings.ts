#!/usr/bin/env bun
/**
 * repo-settings: compare GitHub repo settings with repos.yml.
 *
 *   bun scripts/repo-settings.ts                 print the diff (default)
 *   bun scripts/repo-settings.ts --apply         apply it
 *   options: --only a,b   --include-frozen (also apply to frozen repos)
 *
 * Managed: description, homepage, topics, has_wiki, has_projects,
 * delete_branch_on_merge, secret scanning and push protection, private
 * vulnerability reporting (SECURITY.md points reporters there), and the
 * `main (devkit)` branch ruleset for repos with `required_checks`.
 */
import { parseArgs } from 'node:util'
import { gh, isFrozen, loadReposFile, parseOnly, type Repo, resolveRepos, selectRepos } from './lib/repos'

export interface RepoState {
  description: string
  homepage: string
  topics: string[]
  has_wiki: boolean
  has_projects: boolean
  delete_branch_on_merge: boolean
  secret_scanning: boolean
  secret_scanning_push_protection: boolean
  private_vulnerability_reporting: boolean
}

export interface SettingDiff {
  field: keyof RepoState
  current: RepoState[keyof RepoState]
  desired: RepoState[keyof RepoState]
}

/** The branch ruleset devkit owns in a repo, found by this name. */
export const RULESET_NAME = 'main (devkit)'

export interface Ruleset {
  name: string
  target: string
  enforcement: string
  conditions: { ref_name: { include: string[]; exclude: string[] } }
  rules: { type: string; parameters?: Record<string, unknown> }[]
  bypass_actors: { actor_type: string; actor_id: number | null; bypass_mode: string }[]
}

export interface RulesetDiff {
  field: string
  current: unknown
  desired: unknown
}

interface StatusChecks {
  strict_required_status_checks_policy?: boolean
  required_status_checks?: { context: string; integration_id?: number }[]
}

interface GitHubRepo {
  description: string | null
  homepage: string | null
  topics?: string[]
  has_wiki: boolean
  has_projects: boolean
  delete_branch_on_merge?: boolean
  security_and_analysis?: {
    secret_scanning?: { status: string }
    secret_scanning_push_protection?: { status: string }
  } | null
}

export function stateFromApi(api: GitHubRepo, privateVulnerabilityReporting = false): RepoState {
  return {
    description: api.description ?? '',
    homepage: api.homepage ?? '',
    topics: api.topics ?? [],
    has_wiki: api.has_wiki,
    has_projects: api.has_projects,
    delete_branch_on_merge: api.delete_branch_on_merge ?? false,
    secret_scanning: api.security_and_analysis?.secret_scanning?.status === 'enabled',
    secret_scanning_push_protection: api.security_and_analysis?.secret_scanning_push_protection?.status === 'enabled',
    private_vulnerability_reporting: privateVulnerabilityReporting,
  }
}

export function desiredState(repo: Repo): Partial<RepoState> {
  const want: Partial<RepoState> = { ...repo.settings }
  if (repo.description !== undefined) want.description = repo.description
  if (repo.homepage !== undefined) want.homepage = repo.homepage
  if (repo.topics !== undefined) want.topics = repo.topics
  return want
}

/**
 * The ruleset for `required_checks`: the default branch can't be deleted or
 * force-pushed, and needs the checks to pass (not necessarily on the latest
 * main). Repository admins bypass it, so maintainers can still push directly.
 */
export function desiredRuleset(checks: string[]): Ruleset {
  const rules: Ruleset['rules'] = [{ type: 'deletion' }, { type: 'non_fast_forward' }]
  if (checks.length) {
    rules.push({
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: checks.map((context) => ({ context })),
      },
    })
  }
  return {
    name: RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules,
    bypass_actors: [{ actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'always' }],
  }
}

interface GitHubRuleset {
  name: string
  target?: string
  enforcement: string
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } } | null
  rules?: { type: string; parameters?: Record<string, unknown> }[]
  bypass_actors?: { actor_type: string; actor_id: number | null; bypass_mode: string }[]
}

export function rulesetFromApi(api: GitHubRuleset): Ruleset {
  return {
    name: api.name,
    target: api.target ?? 'branch',
    enforcement: api.enforcement,
    conditions: {
      ref_name: { include: api.conditions?.ref_name?.include ?? [], exclude: api.conditions?.ref_name?.exclude ?? [] },
    },
    rules: api.rules ?? [],
    bypass_actors: api.bypass_actors ?? [],
  }
}

/** The parts of a ruleset devkit compares, as plain values. */
function rulesetView(r: Ruleset): Record<string, string | string[]> {
  const checks = r.rules.find((x) => x.type === 'required_status_checks')?.parameters as StatusChecks | undefined
  return {
    target: r.target,
    enforcement: r.enforcement,
    branches: [...r.conditions.ref_name.include, ...r.conditions.ref_name.exclude.map((b) => `!${b}`)],
    rules: r.rules.map((x) => x.type),
    required_checks: (checks?.required_status_checks ?? []).map((c) =>
      c.integration_id ? `${c.context}@${c.integration_id}` : c.context,
    ),
    strict: String(checks?.strict_required_status_checks_policy ?? false),
    bypass: r.bypass_actors.map((a) => `${a.actor_type}:${a.actor_id ?? ''}:${a.bypass_mode}`),
  }
}

/** Differences between the current ruleset (null when missing) and the desired one. */
export function diffRuleset(current: Ruleset | null, desired: Ruleset): RulesetDiff[] {
  if (!current) return [{ field: 'ruleset', current: null, desired: desired.name }]
  const now = rulesetView(current)
  const want = rulesetView(desired)
  return Object.keys(want)
    .filter((field) => !same(now[field], want[field]))
    .map((field) => ({ field: `ruleset.${field}`, current: now[field], desired: want[field] }))
}

/** One ruleset diff line; a missing ruleset lists what will be created. */
export function formatRulesetDiff(d: RulesetDiff, desired: Ruleset): string {
  if (d.field !== 'ruleset') return formatDiff(d)
  const view = rulesetView(desired)
  const checks = view.required_checks?.length ? `, required checks ${show(view.required_checks)}` : ''
  return `ruleset "${desired.name}": missing -> rules ${show(view.rules)}${checks}, bypass ${show(view.bypass)}`
}

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i])
  }
  return a === b
}

export function diffSettings(current: RepoState, desired: Partial<RepoState>): SettingDiff[] {
  const out: SettingDiff[] = []
  for (const [field, want] of Object.entries(desired) as [keyof RepoState, RepoState[keyof RepoState]][]) {
    if (want === undefined) continue
    if (!same(current[field], want)) out.push({ field, current: current[field], desired: want })
  }
  return out
}

/** Split a diff into the REST calls that apply it. */
export function applyPlan(diffs: SettingDiff[]): {
  patch: Record<string, unknown>
  topics: string[] | null
  privateVulnerabilityReporting: boolean | null
} {
  const patch: Record<string, unknown> = {}
  const security: Record<string, { status: string }> = {}
  let topics: string[] | null = null
  let privateVulnerabilityReporting: boolean | null = null
  for (const d of diffs) {
    if (d.field === 'topics') topics = d.desired as string[]
    else if (d.field === 'private_vulnerability_reporting') privateVulnerabilityReporting = d.desired as boolean
    else if (d.field === 'secret_scanning' || d.field === 'secret_scanning_push_protection') {
      security[d.field] = { status: d.desired ? 'enabled' : 'disabled' }
    } else patch[d.field] = d.desired
  }
  if (Object.keys(security).length) patch.security_and_analysis = security
  return { patch, topics, privateVulnerabilityReporting }
}

function show(v: unknown): string {
  return Array.isArray(v) ? `[${v.join(', ')}]` : JSON.stringify(v)
}

/**
 * One diff line. Lists (topics) show only what is added and removed, so a
 * different order on GitHub never reads as a change.
 */
export function formatDiff(d: SettingDiff | RulesetDiff): string {
  if (Array.isArray(d.current) && Array.isArray(d.desired)) {
    const now = d.current as string[]
    const want = d.desired as string[]
    const added = want.filter((v) => !now.includes(v))
    const removed = now.filter((v) => !want.includes(v))
    const parts = [added.length ? `+${show(added)}` : '', removed.length ? `-${show(removed)}` : '']
    return `${d.field}: ${parts.filter(Boolean).join(' ')}`
  }
  return `${d.field}: ${show(d.current)} -> ${show(d.desired)}`
}

/** The repo's own ruleset named RULESET_NAME, or null. Rulesets inherited from an org are ignored. */
function fetchRuleset(fullName: string): { id: number; body: Ruleset } | null {
  const list = JSON.parse(gh(['api', `repos/${fullName}/rulesets?includes_parents=false&per_page=100`])) as {
    id: number
    name: string
  }[]
  const hit = list.find((r) => r.name === RULESET_NAME)
  if (!hit) return null
  return { id: hit.id, body: rulesetFromApi(JSON.parse(gh(['api', `repos/${fullName}/rulesets/${hit.id}`])) as GitHubRuleset) }
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: repo-settings [--apply | --check] [--json] [--config path] [--only a,b] [--include-frozen]')
    return 0
  }
  const { values } = parseArgs({ args: argv, options: {
    config: { type: 'string' }, only: { type: 'string', multiple: true },
    check: { type: 'boolean' }, json: { type: 'boolean' },
    apply: { type: 'boolean' }, 'include-frozen': { type: 'boolean' },
  } })
  const apply = values.apply === true
  const includeFrozen = values['include-frozen'] === true
  if (apply && values.check) throw new Error('--apply cannot be combined with --check')
  const repos = selectRepos(resolveRepos(await loadReposFile(values.config)), parseOnly(argv))
  const results: {
    repo: string; status: string; frozen: boolean; diffs: (SettingDiff | RulesetDiff)[]; error?: string
  }[] = []
  let pending = 0
  let failed = 0

  for (const repo of repos) {
    const frozen = isFrozen(repo)
    const result: (typeof results)[number] = { repo: repo.fullName, status: 'ok', frozen, diffs: [] }
    results.push(result)
    const desired = desiredState(repo)
    if (Object.keys(desired).length === 0 && repo.required_checks === undefined) {
      result.status = 'unmanaged'
      pending++
      if (!values.json) console.log(`${repo.fullName}: unmanaged`)
      continue
    }
    let current: RepoState
    let ruleset: { id: number; body: Ruleset } | null = null
    try {
      let pvr = false
      if (desired.private_vulnerability_reporting !== undefined) {
        pvr = (JSON.parse(gh(['api', `repos/${repo.fullName}/private-vulnerability-reporting`])) as { enabled: boolean }).enabled
      }
      current = stateFromApi(JSON.parse(gh(['api', `repos/${repo.fullName}`])) as GitHubRepo, pvr)
      if (repo.required_checks !== undefined) ruleset = fetchRuleset(repo.fullName)
    } catch (err) {
      result.status = 'error'
      result.error = (err as Error).message
      if (!values.json) console.error(`${repo.fullName}: ${result.error}`)
      failed++
      continue
    }
    const diffs = diffSettings(current, desired)
    const wantRuleset = repo.required_checks === undefined ? null : desiredRuleset(repo.required_checks)
    const rulesetDiffs = wantRuleset ? diffRuleset(ruleset?.body ?? null, wantRuleset) : []
    result.diffs = [...diffs, ...rulesetDiffs]
    if (frozen) result.status = 'frozen'
    if (diffs.length === 0 && rulesetDiffs.length === 0) {
      if (frozen) pending++
      if (!values.json) console.log(`${repo.fullName}: ${result.status}`)
      continue
    }
    if (!frozen) result.status = 'drift'
    if (!values.json) {
      console.log(`${repo.fullName}: ${result.status}`)
      for (const d of diffs) console.log(`  ${formatDiff(d)}`)
      if (wantRuleset) for (const d of rulesetDiffs) console.log(`  ${formatRulesetDiff(d, wantRuleset)}`)
    }
    if (!apply) {
      pending++
      continue
    }
    if (frozen && !includeFrozen) {
      if (!values.json) console.log('  skipped: frozen (pass --include-frozen to apply anyway)')
      continue
    }
    const { patch, topics, privateVulnerabilityReporting } = applyPlan(diffs)
    try {
      if (Object.keys(patch).length) {
        gh(['api', '-X', 'PATCH', `repos/${repo.fullName}`, '--input', '-'], JSON.stringify(patch))
      }
      if (topics) gh(['api', '-X', 'PUT', `repos/${repo.fullName}/topics`, '--input', '-'], JSON.stringify({ names: topics }))
      if (privateVulnerabilityReporting !== null) {
        gh(['api', '-X', privateVulnerabilityReporting ? 'PUT' : 'DELETE', `repos/${repo.fullName}/private-vulnerability-reporting`])
      }
      if (wantRuleset && rulesetDiffs.length) {
        const path = ruleset ? `repos/${repo.fullName}/rulesets/${ruleset.id}` : `repos/${repo.fullName}/rulesets`
        gh(['api', '-X', ruleset ? 'PUT' : 'POST', path, '--input', '-'], JSON.stringify(wantRuleset))
      }
      result.status = 'applied'
      if (!values.json) console.log('  applied')
    } catch (err) {
      result.status = 'error'
      result.error = (err as Error).message
      if (!values.json) console.error(`  error: ${result.error}`)
      failed++
    }
  }
  if (values.json) console.log(JSON.stringify(results))
  else if (!apply && pending) console.log(`\n${pending} repo(s) need attention; inspect the status and diffs above.`)
  if (failed) return 2
  if (values.check && pending) return 1
  return 0
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)))
  } catch (err) {
    console.error((err as Error).message)
    process.exit(2)
  }
}
