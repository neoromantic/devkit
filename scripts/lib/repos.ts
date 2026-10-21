import { join } from 'node:path'

export const ROOT = join(import.meta.dir, '..', '..')
export const TEMPLATES_DIR = join(ROOT, 'templates')
export const AGENTS_BLOCK_PATH = join(ROOT, 'agents', 'AGENTS.shared.md')

export interface Settings {
  has_wiki?: boolean
  has_projects?: boolean
  delete_branch_on_merge?: boolean
  secret_scanning?: boolean
  secret_scanning_push_protection?: boolean
  private_vulnerability_reporting?: boolean
}

export interface RepoEntry {
  profile: string
  description?: string
  homepage?: string
  topics?: string[]
  maintenance?: boolean
  frozen?: boolean
  frozen_until?: string
  agents?: boolean
  exclude?: string[]
  settings?: Settings
  /** Status checks the `main (devkit)` branch ruleset requires. Left out: no ruleset is managed. */
  required_checks?: string[]
}

export interface ReposFile {
  owner: string
  settings?: Settings
  files?: Record<string, string>
  profiles: Record<string, { files?: Record<string, string> }>
  repos: Record<string, RepoEntry>
}

export interface Repo extends RepoEntry {
  name: string
  owner: string
  fullName: string
  /** Target path in the repo -> template file name in templates/. */
  files: Record<string, string>
  settings: Settings
}

export async function loadReposFile(path = join(ROOT, 'repos.yml')): Promise<ReposFile> {
  return Bun.YAML.parse(await Bun.file(path).text()) as ReposFile
}

export function resolveRepos(file: ReposFile): Repo[] {
  return Object.entries(file.repos).map(([name, entry]) => {
    const profile = file.profiles[entry.profile]
    if (!profile) throw new Error(`repos.yml: ${name} uses unknown profile "${entry.profile}"`)
    const files: Record<string, string> = { ...(file.files ?? {}), ...(profile.files ?? {}) }
    for (const path of entry.exclude ?? []) delete files[path]
    return {
      ...entry,
      name,
      owner: file.owner,
      fullName: `${file.owner}/${name}`,
      files,
      settings: { ...(file.settings ?? {}), ...(entry.settings ?? {}) },
    }
  })
}

/** Frozen repos are skipped by sync and by repo-settings --apply. */
export function isFrozen(repo: RepoEntry, today = new Date()): boolean {
  if (repo.frozen) return true
  if (!repo.frozen_until) return false
  return today.toISOString().slice(0, 10) <= repo.frozen_until
}

export function selectRepos(repos: Repo[], only: string[]): Repo[] {
  if (only.length === 0) return repos
  const unknown = only.filter((n) => !repos.some((r) => r.name === n))
  if (unknown.length) throw new Error(`unknown repo(s): ${unknown.join(', ')}`)
  return repos.filter((r) => only.includes(r.name))
}

export function parseOnly(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') out.push(...(argv[++i] ?? '').split(',').filter(Boolean))
    else if (argv[i]?.startsWith('--only=')) out.push(...(argv[i] ?? '').slice(7).split(',').filter(Boolean))
  }
  return out
}

export function gh(args: string[], input?: string): string {
  const proc = Bun.spawnSync(['gh', ...args], {
    stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input),
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0) {
    throw new Error(`gh ${args.join(' ')} failed: ${proc.stderr.toString().trim()}`)
  }
  return proc.stdout.toString()
}
