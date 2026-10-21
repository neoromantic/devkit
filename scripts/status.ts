#!/usr/bin/env bun
/** Read-only technical status for the current default-branch SHA. */
import { parseArgs } from 'node:util'
import { gh, loadReposFile, parseOnly, resolveRepos, selectRepos } from './lib/repos'

export async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: status [--json] [--config path] [--only a,b]')
    return 0
  }
  const { values } = parseArgs({ args: argv, options: {
    config: { type: 'string' }, only: { type: 'string', multiple: true }, json: { type: 'boolean' },
  } })
  const repos = selectRepos(resolveRepos(await loadReposFile(values.config)), parseOnly(argv))
  const results: {
    repo: string; profile: string; branch: string | null; sha: string | null; ci: string
    checks: { name: string; status: string; url: string | null }[]; missing_checks: string[]
    release: { tag: string; url: string } | null; error?: string
  }[] = []
  let failed = 0
  let incomplete = 0

  for (const repo of repos) {
    const result: (typeof results)[number] = {
      repo: repo.fullName, profile: repo.profile, branch: null, sha: null, ci: 'unknown',
      checks: [], missing_checks: [], release: null,
    }
    results.push(result)
    try {
      const info = JSON.parse(gh(['api', `repos/${repo.fullName}`])) as { default_branch: string }
      result.branch = info.default_branch
      const { sha } = JSON.parse(gh(['api', `repos/${repo.fullName}/commits/${encodeURIComponent(info.default_branch)}`])) as { sha: string }
      result.sha = sha
      const pages = JSON.parse(gh(['api', '--paginate', '--slurp',
        `repos/${repo.fullName}/commits/${sha}/check-runs?filter=latest&per_page=100`])) as {
        check_runs: { name: string; head_sha: string; status: string; conclusion: string | null; details_url: string | null }[]
      }[]
      for (const check of pages.flatMap((page) => page.check_runs)) {
        if (check.head_sha !== sha) continue
        let status = check.status
        if (check.status === 'completed' && check.conclusion !== null) status = check.conclusion
        result.checks.push({ name: check.name, status, url: check.details_url })
      }
      const statuses = JSON.parse(gh(['api', '--paginate', '--slurp',
        `repos/${repo.fullName}/commits/${sha}/statuses?per_page=100`])) as {
        context: string; state: string; target_url: string | null
      }[][]
      const seen = new Set<string>()
      for (const status of statuses.flat()) {
        if (seen.has(status.context)) continue
        seen.add(status.context)
        result.checks.push({ name: status.context, status: status.state, url: status.target_url })
      }
      let checks = result.checks
      if (repo.required_checks?.length) {
        result.missing_checks = repo.required_checks.filter((name) => !checks.some((check) => check.name === name))
        checks = checks.filter((check) => repo.required_checks?.includes(check.name))
      }
      result.ci = 'passed'
      if (checks.length === 0 || result.missing_checks.length) result.ci = 'missing'
      else if (checks.some((check) => ['failure', 'error', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(check.status))) result.ci = 'failed'
      else if (checks.some((check) => !['success', 'neutral', 'skipped'].includes(check.status))) result.ci = 'pending'
      else if (!checks.some((check) => check.status === 'success')) result.ci = 'missing'

      const releases = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo.fullName}/releases?per_page=100`])) as {
        tag_name: string; html_url: string; draft: boolean; prerelease: boolean; published_at: string
      }[][]
      const published = releases.flat().filter((release) => !release.draft && !release.prerelease)
        .sort((a, b) => b.published_at.localeCompare(a.published_at))
      const release = published[0]
      if (release) result.release = { tag: release.tag_name, url: release.html_url }
      if (result.ci !== 'passed') incomplete++
    } catch (err) {
      result.error = (err as Error).message
      failed++
    }
    if (!values.json) {
      console.log(`${result.repo} (${result.profile})`)
      if (result.sha) console.log(`  ${result.branch}: ${result.sha}`)
      console.log(`  ci: ${result.ci}`)
      for (const check of result.checks) console.log(`    ${check.name}: ${check.status}`)
      for (const name of result.missing_checks) console.log(`    ${name}: missing`)
      if (result.release) console.log(`  release: ${result.release.tag} ${result.release.url}`)
      else console.log('  release: none observed')
      if (result.error) console.error(`  error: ${result.error}`)
    }
  }
  if (values.json) console.log(JSON.stringify(results))
  if (failed) return 2
  if (incomplete) return 1
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
