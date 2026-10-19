#!/usr/bin/env bun
/**
 * repo-settings: compare GitHub repo settings with repos.yml.
 *
 *   bun scripts/repo-settings.ts                 print the diff (default)
 *   bun scripts/repo-settings.ts --apply         apply it
 *   options: --only a,b   --include-frozen (also apply to frozen repos)
 *
 * Managed: description, homepage, topics, has_wiki, has_projects,
 * delete_branch_on_merge, secret scanning and push protection, and private
 * vulnerability reporting (SECURITY.md points reporters there).
 */
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

export async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: repo-settings [--apply] [--only a,b] [--include-frozen]')
    return 0
  }
  const apply = argv.includes('--apply')
  const includeFrozen = argv.includes('--include-frozen')
  const repos = selectRepos(resolveRepos(await loadReposFile()), parseOnly(argv))
  let pending = 0
  let failed = 0

  for (const repo of repos) {
    let current: RepoState
    try {
      const pvr = JSON.parse(gh(['api', `repos/${repo.fullName}/private-vulnerability-reporting`])) as { enabled: boolean }
      current = stateFromApi(JSON.parse(gh(['api', `repos/${repo.fullName}`])) as GitHubRepo, pvr.enabled)
    } catch (err) {
      console.error(`${repo.fullName}: ${(err as Error).message}`)
      failed++
      continue
    }
    const diffs = diffSettings(current, desiredState(repo))
    const frozen = isFrozen(repo)
    if (diffs.length === 0) {
      console.log(`${repo.fullName}: ok`)
      continue
    }
    console.log(`${repo.fullName}:${frozen ? ' (frozen)' : ''}`)
    for (const d of diffs) console.log(`  ${d.field}: ${show(d.current)} -> ${show(d.desired)}`)
    if (!apply) {
      pending++
      continue
    }
    if (frozen && !includeFrozen) {
      console.log('  skipped: frozen (pass --include-frozen to apply anyway)')
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
      console.log('  applied')
    } catch (err) {
      console.error(`  error: ${(err as Error).message}`)
      failed++
    }
  }
  if (!apply && pending) console.log(`\n${pending} repo(s) differ. Run with --apply to change them.`)
  return failed ? 1 : 0
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)))
}
