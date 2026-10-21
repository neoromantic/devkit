#!/usr/bin/env bun
/**
 * sync: render devkit's managed files and AGENTS block into each repo in repos.yml.
 *
 *   bun scripts/sync.ts [--dry-run]            show the diff per repo (default)
 *   bun scripts/sync.ts --write                open one PR per repo with the changes
 *   options: --only a,b   --adopt (overwrite existing files that are not managed yet)
 *            --keep (leave the temp clones on disk)
 *
 * Frozen repos (see repos.yml) are skipped. Existing files without the
 * "managed by devkit" mark are left alone unless --adopt is given.
 */
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { applyAgentsBlock, type FileAction, planFile, render, templateVars } from './lib/managed'
import {
  AGENTS_BLOCK_PATH,
  isFrozen,
  loadReposFile,
  parseOnly,
  type Repo,
  ROOT,
  resolveRepos,
  selectRepos,
  TEMPLATES_DIR,
} from './lib/repos'

interface Change {
  path: string
  action: FileAction | 'warn'
  note?: string
}

function run(cmd: string[], cwd?: string): string {
  const proc = Bun.spawnSync(cmd, { cwd, stderr: 'pipe' })
  if (proc.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed: ${proc.stderr.toString().trim()}`)
  return proc.stdout.toString()
}

async function readOrNull(path: string): Promise<string | null> {
  const f = Bun.file(path)
  return (await f.exists()) ? f.text() : null
}

async function isSymlink(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null))?.isSymbolicLink() ?? false
}

const SYMLINK_NOTE = 'is a symlink; devkit never writes through one. Replace it with a regular file by hand'

async function writeFile(path: string, content: string): Promise<void> {
  await Bun.$`mkdir -p ${dirname(path)}`.quiet()
  await Bun.write(path, content)
}

/** Compute and write the desired state into a checkout. Returns what changed. */
export async function syncCheckout(repo: Repo, dir: string, opts: { adopt: boolean }): Promise<Change[]> {
  const changes: Change[] = []
  const vars = templateVars(repo)
  for (const [target, template] of Object.entries(repo.files)) {
    if (await isSymlink(join(dir, target))) {
      changes.push({ path: target, action: 'warn', note: SYMLINK_NOTE })
      continue
    }
    const desired = render(await Bun.file(join(TEMPLATES_DIR, template)).text(), vars)
    const existing = await readOrNull(join(dir, target))
    const action = planFile(existing, desired, opts.adopt)
    if (action === 'create' || action === 'update' || action === 'adopt') await writeFile(join(dir, target), desired)
    changes.push({
      path: target,
      action,
      note: action === 'skip' ? 'exists and is not managed by devkit (use --adopt to take it over)' : undefined,
    })
  }

  if (repo.agents !== false) {
    const block = await Bun.file(AGENTS_BLOCK_PATH).text()
    const agentsPath = join(dir, 'AGENTS.md')
    const claudePath = join(dir, 'CLAUDE.md')
    if ((await isSymlink(agentsPath)) || (await isSymlink(claudePath))) {
      changes.push({
        path: 'AGENTS.md',
        action: 'warn',
        note: `AGENTS.md or CLAUDE.md ${SYMLINK_NOTE}: AGENTS.md holds the rules, CLAUDE.md is "@AGENTS.md"`,
      })
      return changes
    }
    const existing = await readOrNull(agentsPath)
    const desired = applyAgentsBlock(existing, block, repo.name)
    const action: FileAction = existing === desired ? 'ok' : existing === null ? 'create' : 'update'
    if (action !== 'ok') await writeFile(agentsPath, desired)
    changes.push({ path: 'AGENTS.md', action, note: 'devkit:agents block' })

    const claude = await readOrNull(claudePath)
    if (claude === null) {
      await writeFile(claudePath, '@AGENTS.md\n')
      changes.push({ path: 'CLAUDE.md', action: 'create' })
    } else if (claude.trim() !== '@AGENTS.md') {
      changes.push({
        path: 'CLAUDE.md',
        action: 'warn',
        note: 'should contain only "@AGENTS.md"; move its rules into AGENTS.md by hand',
      })
    } else {
      changes.push({ path: 'CLAUDE.md', action: 'ok' })
    }
  }
  return changes
}

function printChanges(repo: Repo, changes: Change[]): void {
  console.log(`\n=== ${repo.fullName} (${repo.profile})`)
  for (const c of changes) {
    console.log(`  ${c.action.padEnd(6)} ${c.path}${c.note ? `  — ${c.note}` : ''}`)
  }
}

const WRITE_ACTIONS = new Set(['create', 'update', 'adopt'])

export async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: sync [--dry-run | --write | --check] [--json] [--config path] [--only a,b] [--adopt] [--keep]')
    return 0
  }
  const { values } = parseArgs({ args: argv, options: {
    config: { type: 'string' }, only: { type: 'string', multiple: true },
    check: { type: 'boolean' }, json: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    write: { type: 'boolean' }, adopt: { type: 'boolean' }, keep: { type: 'boolean' },
  } })
  const write = values.write === true
  const adopt = values.adopt === true
  const keep = values.keep === true
  if (write && (values.check || values['dry-run'])) throw new Error('--write cannot be combined with --check or --dry-run')
  const repos = selectRepos(resolveRepos(await loadReposFile(values.config)), parseOnly(argv))
  const version = (await Bun.file(join(ROOT, 'package.json')).json()).version as string
  const results: { repo: string; status: string; changes: Change[]; error?: string; url?: string }[] = []
  let failed = 0
  let pending = 0

  for (const repo of repos) {
    const result: (typeof results)[number] = { repo: repo.fullName, status: 'ok', changes: [] }
    results.push(result)
    if (isFrozen(repo)) {
      result.status = 'frozen'
      pending++
      if (!values.json) console.log(`\n=== ${repo.fullName}: frozen, skipped`)
      continue
    }
    const dir = await mkdtemp(join(tmpdir(), `devkit-sync-${repo.name}-`))
    try {
      run(['gh', 'repo', 'clone', repo.fullName, dir, '--', '--depth', '1', '--quiet'])
      const changes = await syncCheckout(repo, dir, { adopt })
      result.changes = changes
      if (!values.json) printChanges(repo, changes)
      if (changes.some((c) => c.action !== 'ok')) result.status = 'drift'
      if (changes.some((c) => c.action === 'skip' || c.action === 'warn')) result.status = 'blocked'
      if (changes.length === 0) result.status = 'unmanaged'
      if (result.status !== 'ok') pending++
      if (!changes.some((c) => WRITE_ACTIONS.has(c.action))) {
        if (!values.json) console.log(`  ${result.status}`)
        continue
      }
      run(['git', 'add', '-A'], dir)
      if (!write) {
        if (!values.json && !values.check) {
          console.log(run(['git', '--no-pager', 'diff', '--cached', '--no-color', '--stat'], dir))
          console.log(run(['git', '--no-pager', 'diff', '--cached', '--no-color'], dir))
        }
        continue
      }
      const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
      const branch = `devkit/sync-${stamp}`
      run(['git', 'switch', '-c', branch], dir)
      run(['git', 'commit', '-m', `chore: sync devkit managed files (v${version})`], dir)
      run(['git', 'push', '-u', 'origin', branch], dir)
      const body = [
        `Sync from [neoromantic/devkit](https://github.com/neoromantic/devkit) v${version}.`,
        '',
        ...changes.filter((c) => c.action !== 'ok').map((c) => `- ${c.action}: \`${c.path}\`${c.note ? ` (${c.note})` : ''}`),
        '',
        'Managed files carry a "managed by devkit" mark. Change them in devkit, not here.',
      ].join('\n')
      const url = run(
        ['gh', 'pr', 'create', '--repo', repo.fullName, '--head', branch, '--title', `chore: sync devkit v${version}`, '--body', body],
        dir,
      ).trim()
      result.url = url
      if (result.status === 'drift') result.status = 'pr-opened'
      if (!values.json) console.log(`  PR: ${url}`)
    } catch (err) {
      failed++
      result.status = 'error'
      result.error = (err as Error).message
      if (!values.json) console.error(`  error: ${result.error}`)
    } finally {
      if (keep) {
        if (!values.json) console.log(`  kept clone at ${dir}`)
      } else await rm(dir, { recursive: true, force: true })
    }
  }
  if (values.json) console.log(JSON.stringify(results))
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
