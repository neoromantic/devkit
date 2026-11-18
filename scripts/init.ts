#!/usr/bin/env bun
/**
 * init: onboard the repo in the current directory (or --dir) to devkit, offline.
 *
 *   devkit init [--dir path] [--dry-run] [--json] [--repo owner/name] [--profile bun|python]
 *               [--adopt] [--no-install]
 *
 * Writes by default; --dry-run only reports. Detects a Bun or Python project from its own files
 * and git remote: no repos.yml lookup and no GitHub API calls. Writes the same managed files and
 * AGENTS block as sync, so a later sync keeps them. Bun projects also get Knip: a pinned
 * devDependency, a knip.json baseline, a `check:knip` script wired into `check`, and bun.lock
 * from `bun install`. They also get the shared lint and format standard: oxlint, oxfmt and
 * landmines pinned, `format`, `format:check` and `lint` scripts run by `check`, and a `.oxlintrc.json`
 * that extends the managed `.oxlintrc.devkit.jsonc`. Existing CI, hooks, Knip settings, scripts and
 * unmanaged files are kept. JS projects on npm, pnpm or yarn are refused before anything is written.
 */
import { lstat, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isManaged } from './lib/managed'
import { type Repo, ROOT } from './lib/repos'
import { type Change, declaresBin, syncCheckout } from './sync'

export type Profile = 'bun' | 'python'

const COMMON_FILES: Record<string, string> = {
  'SECURITY.md': 'SECURITY.md',
  '.gitleaks.toml': '.gitleaks.toml',
  '.github/zizmor.yml': 'zizmor.yml',
  'renovate.json': 'renovate.json',
  'lefthook.yml': 'lefthook.yml',
}

/** Same files as the `bun` and `python` profiles in repos.yml (a test keeps them equal). */
export const INIT_FILES: Record<Profile, Record<string, string>> = {
  bun: {
    ...COMMON_FILES,
    '.github/workflows/ci.yml': 'ci.bun.yml',
    'CONTRIBUTING.md': 'CONTRIBUTING.md',
    '.github/PULL_REQUEST_TEMPLATE.md': 'PULL_REQUEST_TEMPLATE.md',
    '.oxfmtrc.jsonc': '.oxfmtrc.jsonc',
    '.oxlintrc.devkit.jsonc': '.oxlintrc.devkit.jsonc',
  },
  python: {
    ...COMMON_FILES,
    '.github/workflows/ci.yml': 'ci.python.yml',
    'CONTRIBUTING.md': 'CONTRIBUTING.md',
    '.github/PULL_REQUEST_TEMPLATE.md': 'PULL_REQUEST_TEMPLATE.md',
  },
}

/** Paths that already do a managed file's job. When one exists, init leaves that file out. */
const EQUIVALENTS: Record<string, string[]> = {
  'SECURITY.md': ['.github/SECURITY.md', 'docs/SECURITY.md'],
  'CONTRIBUTING.md': ['.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md'],
  '.github/PULL_REQUEST_TEMPLATE.md': [
    '.github/pull_request_template.md',
    '.github/PULL_REQUEST_TEMPLATE',
    'PULL_REQUEST_TEMPLATE.md',
    'docs/pull_request_template.md',
  ],
  'renovate.json': [
    'renovate.json5',
    '.github/renovate.json',
    '.github/renovate.json5',
    '.renovaterc',
    '.renovaterc.json',
    '.renovaterc.json5',
  ],
  'lefthook.yml': [
    'lefthook.yaml',
    '.lefthook.yml',
    '.lefthook.yaml',
    'lefthook.json',
    '.husky',
    '.pre-commit-config.yaml',
    '.simple-git-hooks.json',
    '.simple-git-hooks.js',
  ],
  '.github/zizmor.yml': ['.github/zizmor.yaml', 'zizmor.yml'],
}

/** The baseline issue types: unused files and dependencies, unlisted and unresolved imports. */
export const KNIP_INCLUDE = ['files', 'dependencies', 'devDependencies', 'unlisted', 'unresolved']

export const KNIP_CONFIG = `{\n  "$schema": "https://unpkg.com/knip@6/schema.json",\n  "include": ${JSON.stringify(KNIP_INCLUDE).replaceAll(',', ', ')}\n}\n`

/** The lint and format standard's packages, pinned to the versions devkit tests with. */
export const OXC_PACKAGES = ['@interfere/landmines', 'oxfmt', 'oxlint']

export const OXC_SCRIPTS: Record<string, string> = {
  format: 'oxfmt',
  'format:check': 'oxfmt --check',
  lint: 'oxlint --deny-warnings',
}

/** The repo's own oxlint config: the shared standard plus this repo's exceptions. */
export const OXLINT_CONFIG =
  '{\n  "$schema": "./node_modules/oxlint/configuration_schema.json",\n  "extends": ["./.oxlintrc.devkit.jsonc"]\n}\n'

const OXLINT_CONFIG_FILE = /^(\.oxlintrc\.jsonc?|oxlint\.config\.(ts|mts|cts|js|mjs|cjs))$/

/** Linters and formatters that oxlint and oxfmt replace. init reports them and removes nothing. */
const OTHER_TOOLS = /^(biome\.jsonc?|\.eslintrc(\.\w+)?|eslint\.config\.\w+|\.prettierrc(\.\w+)?|prettier\.config\.\w+|dprint\.jsonc?|\.dprint\.jsonc?)$/

/** A workflow that already is CI: named like one, calls the shared jobs, or runs checks or tests. */
const CI_NAME = /^(ci|tests?|checks?|build|lint)\.ya?ml$/i
const CI_CONTENT = /ci-(bun|python)\.yml|\b(bun (run )?(check|test|lint|typecheck)|pytest|ruff check)\b/

const KNIP_CONFIG_FILE = /^\.?knip(\.config)?\.(json|jsonc|js|cjs|mjs|ts|cts|mts)$/

type PackageJson = Record<string, unknown> & {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

export type PackageManager = 'bun' | 'npm' | 'pnpm' | 'yarn'

export function detectPackageManager(pkg: PackageJson, names: Set<string>): PackageManager {
  const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : ''
  if (declared === 'bun' || declared === 'npm' || declared === 'pnpm' || declared === 'yarn') return declared
  if (names.has('bun.lock') || names.has('bun.lockb')) return 'bun'
  if (names.has('pnpm-lock.yaml')) return 'pnpm'
  if (names.has('yarn.lock')) return 'yarn'
  if (names.has('package-lock.json')) return 'npm'
  return 'bun'
}

/**
 * Add Knip to a package.json: the pinned devDependency, `check:knip` and its place in `check`.
 * Leaves every existing script and dependency as it is. Returns the new object and what changed.
 */
export function planKnip(pkg: PackageJson, knipVersion: string): { pkg: PackageJson; notes: string[] } {
  const out: PackageJson = structuredClone(pkg)
  const notes: string[] = []
  if (!out.dependencies?.knip && !out.devDependencies?.knip) {
    const dev = { ...(out.devDependencies ?? {}), knip: knipVersion }
    out.devDependencies = Object.fromEntries(Object.entries(dev).sort(([a], [b]) => a.localeCompare(b)))
    notes.push(`devDependencies.knip ${knipVersion}`)
  }
  const scripts = { ...(out.scripts ?? {}) }
  if (!/\bknip\b/.test(scripts.check ?? '')) {
    if (!scripts['check:knip']) {
      scripts['check:knip'] = 'knip'
      notes.push('scripts.check:knip')
    }
    const before = scripts.check
      ? [scripts.check]
      : ['lint', 'typecheck'].filter((s) => scripts[s]).map((s) => `bun run ${s}`)
    scripts.check = [...before, 'bun run check:knip'].join(' && ')
    notes.push(`scripts.check runs check:knip`)
  }
  out.scripts = scripts
  return { pkg: out, notes }
}

/**
 * Add the lint and format standard to a package.json: pinned devDependencies, the `format`,
 * `format:check` and `lint` scripts, and `check` running the format check and lint first.
 * Existing scripts that use other tools stay and get a note. Returns the new object and notes.
 */
export function planOxc(
  pkg: PackageJson,
  versions: Record<string, string>,
): { pkg: PackageJson; notes: string[]; advice: string[] } {
  const out: PackageJson = structuredClone(pkg)
  const notes: string[] = []
  const advice: string[] = []
  const missing = OXC_PACKAGES.filter((name) => !out.dependencies?.[name] && !out.devDependencies?.[name])
  if (missing.length) {
    const dev = { ...(out.devDependencies ?? {}) }
    for (const name of missing) {
      const version = versions[name]
      if (!version) throw new Error(`devkit package.json has no ${name} devDependency`)
      dev[name] = version
      notes.push(`devDependencies.${name} ${version}`)
    }
    out.devDependencies = Object.fromEntries(Object.entries(dev).sort(([a], [b]) => a.localeCompare(b)))
  }
  const scripts = { ...(out.scripts ?? {}) }
  if (!scripts.format) {
    scripts.format = OXC_SCRIPTS.format as string
    notes.push('scripts.format')
  } else if (!/\boxfmt\b/.test(scripts.format)) advice.push(`\`format\` runs \`${scripts.format}\`: switch it to \`oxfmt\`.`)
  if (!scripts['format:check'] && /\boxfmt\b/.test(scripts.format ?? '')) {
    scripts['format:check'] = OXC_SCRIPTS['format:check'] as string
    notes.push('scripts.format:check')
  }
  if (!scripts.lint) {
    scripts.lint = OXC_SCRIPTS.lint as string
    notes.push('scripts.lint')
  } else if (!/\boxlint\b/.test(scripts.lint)) {
    advice.push(`\`lint\` runs \`${scripts.lint}\`: switch it to \`oxlint --deny-warnings\`.`)
  }
  const check = scripts.check ?? ''
  const first: string[] = []
  if (/\boxfmt\b/.test(scripts['format:check'] ?? '') && !/format:check|\boxfmt\b/.test(check)) first.push('bun run format:check')
  if (/\boxlint\b/.test(scripts.lint) && !/\bbun run lint\b|\boxlint\b/.test(check)) first.push('bun run lint')
  if (first.length) {
    const rest = scripts.check
      ? [scripts.check]
      : ['lint', 'typecheck'].filter((s) => scripts[s] && !first.includes(`bun run ${s}`)).map((s) => `bun run ${s}`)
    scripts.check = [...first, ...rest].join(' && ')
    notes.push(`scripts.check runs ${first.map((s) => s.slice('bun run '.length)).join(' and ')}`)
  }
  out.scripts = scripts
  return { pkg: out, notes, advice }
}

/** `owner/name` from a GitHub URL, `github:owner/name` or `owner/name`. */
export function parseGitHubRepo(value: string): { owner: string; name: string } | null {
  const m =
    /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(value.trim()) ??
    /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(value.trim())
  return m?.[1] && m[2] ? { owner: m[1], name: m[2] } : null
}

function gitOrigin(dir: string): string {
  const proc = Bun.spawnSync(['git', '-C', dir, 'remote', 'get-url', 'origin'], { stderr: 'ignore' })
  return proc.exitCode === 0 ? proc.stdout.toString().trim() : ''
}

async function readText(path: string): Promise<string | null> {
  const f = Bun.file(path)
  return (await f.exists()) ? f.text() : null
}

async function exists(path: string): Promise<boolean> {
  return (await Bun.file(path).exists()) || (await readdir(path).then(() => true, () => false))
}

async function usesPythonWorkflow(dir: string): Promise<boolean> {
  const workflows = join(dir, '.github', 'workflows')
  const reference = 'neoromantic/devkit/.github/workflows/ci-python.yml@'
  for (const file of await readdir(workflows).catch(() => [] as string[])) {
    if (!/\.ya?ml$/.test(file)) continue
    const contents = await readText(join(workflows, file))
    if (!contents?.includes(reference)) continue
    const workflow = Bun.YAML.parse(contents) as { jobs?: Record<string, { uses?: string }> }
    if (Object.values(workflow.jobs ?? {}).some(job => job.uses?.startsWith(reference))) return true
  }
  return false
}

function detectIndent(text: string): string | number {
  const m = /\n([ \t]+)"/.exec(text)
  return m?.[1] ?? 2
}

export interface InitOptions {
  dir: string
  dryRun?: boolean
  adopt?: boolean
  install?: boolean
  repo?: string
  profile?: Profile
}

export interface InitResult {
  dir: string
  profile: Profile
  repo: string
  packageManager?: PackageManager
  written: boolean
  changes: Change[]
  notes: string[]
}

export async function init(opts: InitOptions): Promise<InitResult> {
  const dir = resolve(opts.dir)
  const names = new Set(await readdir(dir))
  const pkgText = names.has('package.json') ? await readText(join(dir, 'package.json')) : null
  const pyText = names.has('pyproject.toml') ? await readText(join(dir, 'pyproject.toml')) : null
  const python = pyText !== null || (!pkgText && await usesPythonWorkflow(dir))
  const profile = opts.profile ?? (pkgText && python ? undefined : pkgText ? 'bun' : python ? 'python' : undefined)
  if (!profile) {
    throw new Error(
      pkgText && pyText
        ? 'found package.json and pyproject.toml: pass --profile bun or --profile python'
        : 'no package.json or pyproject.toml: run `bun init` or `uv init` first',
    )
  }
  if (profile === 'bun' && !pkgText) throw new Error('no package.json: run `bun init` first')
  if (profile === 'python' && !python) throw new Error('no pyproject.toml: run `uv init` first')

  const pkg = (pkgText ? JSON.parse(pkgText) : {}) as PackageJson
  const pm = profile === 'bun' ? detectPackageManager(pkg, names) : undefined
  if (pm && pm !== 'bun') {
    throw new Error(
      `package.json uses ${pm}: devkit init supports Bun for JS and TS projects. Nothing was written. ` +
        'Move the project to Bun (bun install, then delete the old lockfile) and run devkit init again.',
    )
  }
  const write = opts.dryRun !== true
  const notes: string[] = []
  const changes: Change[] = []

  // Repo identity, from local sources only.
  const pkgRepo = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository as { url?: string })?.url
  const pyUrls = pyText ? Object.values((Bun.TOML.parse(pyText) as { project?: { urls?: Record<string, string> } }).project?.urls ?? {}) : []
  const id = [opts.repo, gitOrigin(dir), pkgRepo, ...pyUrls]
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .map(parseGitHubRepo)
    .find((v) => v !== null)
  if (opts.repo && !parseGitHubRepo(opts.repo)) throw new Error(`--repo must be owner/name, got "${opts.repo}"`)

  const files = { ...INIT_FILES[profile] }
  // Fleet sync has the repo's desired Renovate preset. Local init knows only the
  // existing selection and must preserve it, along with any custom options.
  const renovate = await readText(join(dir, 'renovate.json'))
  if (renovate && isManaged(renovate) && !renovate.includes('{{renovate_preset}}')) {
    delete files['renovate.json']
    changes.push({ path: 'renovate.json', action: 'ok', note: 'kept existing Renovate settings' })
  }
  if (!id) {
    delete files['SECURITY.md']
    notes.push('SECURITY.md skipped: no GitHub repo found. Add a git remote or pass --repo owner/name.')
  }
  for (const [target, alternatives] of Object.entries(EQUIVALENTS)) {
    if (!files[target] || (await exists(join(dir, target)))) continue
    const found = []
    for (const alt of alternatives) if (await exists(join(dir, alt))) found.push(alt)
    if (found.length) {
      delete files[target]
      changes.push({ path: target, action: 'skip', note: `kept ${found.join(', ')}` })
    }
  }

  const ciPath = '.github/workflows/ci.yml'
  const ci = await readText(join(dir, ciPath))
  let ownCi = ci !== null && !isManaged(ci)
  if (ci === null) {
    const workflows = await readdir(join(dir, '.github/workflows')).catch(() => [] as string[])
    const custom = []
    for (const f of workflows.filter((f) => /\.ya?ml$/.test(f))) {
      const text = (await readText(join(dir, '.github/workflows', f))) ?? ''
      if (!isManaged(text) && (CI_NAME.test(f) || CI_CONTENT.test(text))) custom.push(f)
    }
    if (custom.length) {
      delete files[ciPath]
      ownCi = true
      changes.push({ path: ciPath, action: 'skip', note: `kept .github/workflows/${custom.join(', ')}` })
    }
  }
  const pythonOtherPm = profile === 'python' && !names.has('uv.lock') && ['poetry.lock', 'Pipfile.lock', 'pdm.lock'].find((f) => names.has(f))
  if (pythonOtherPm) {
    delete files[ciPath]
    notes.push(`${pythonOtherPm} found: the shared ci-python job uses uv, so no CI stub was added.`)
  }

  const repo: Repo = {
    name: id?.name ?? basename(dir),
    owner: id?.owner ?? '',
    fullName: id ? `${id.owner}/${id.name}` : basename(dir),
    profile,
    files,
    settings: {},
  }
  // `bun init` and agents write rules into CLAUDE.md. With no AGENTS.md yet, they move to its
  // Project section and CLAUDE.md becomes "@AGENTS.md", as the shared rules require.
  const claude = names.has('AGENTS.md') ? null : await readText(join(dir, 'CLAUDE.md'))
  const moveClaude =
    claude !== null && claude.trim() !== '@AGENTS.md' && !(await lstat(join(dir, 'CLAUDE.md'))).isSymbolicLink()
  if (moveClaude) {
    changes.push({ path: 'AGENTS.md', action: 'create', note: 'devkit:agents block, CLAUDE.md rules under ## Project' })
    changes.push({ path: 'CLAUDE.md', action: 'update', note: '"@AGENTS.md"' })
    if (write) {
      await Bun.write(join(dir, 'AGENTS.md'), `# ${repo.name}\n\n## Project\n\n${claude.trim()}\n`)
      await Bun.write(join(dir, 'CLAUDE.md'), '@AGENTS.md\n')
    }
  }
  const synced = await syncCheckout(repo, dir, { adopt: opts.adopt === true, dryRun: !write })
  changes.push(...(moveClaude ? synced.filter((c) => c.path !== 'AGENTS.md' && c.path !== 'CLAUDE.md') : synced))

  if (ownCi) {
    const job =
      profile === 'bun'
        ? `      uses: neoromantic/devkit/.github/workflows/ci-bun.yml@v1\n      permissions: { contents: read }${(await declaresBin(dir)) ? '\n      with: { pack: true }' : ''}`
        : `      uses: neoromantic/devkit/.github/workflows/ci-python.yml@v1\n      permissions: { contents: read }`
    notes.push(
      `CI is yours, so it was not changed. ${profile === 'bun' ? 'Run `bun run check` in it (that runs check:knip), or opt' : 'Opt'} in to the shared job:\n  jobs:\n    build:\n${job}`,
    )
  }

  if (profile === 'bun' && pkgText) {
    const own = ((await Bun.file(join(ROOT, 'package.json')).json()) as PackageJson).devDependencies ?? {}
    const knipVersion = own.knip
    if (!knipVersion) throw new Error('devkit package.json has no knip devDependency')
    const oxc = planOxc(pkg, own)
    const knip = planKnip(oxc.pkg, knipVersion)
    const plan = { pkg: knip.pkg, notes: [...oxc.notes, ...knip.notes] }
    notes.push(...oxc.advice)
    if (plan.notes.length) {
      changes.push({ path: 'package.json', action: 'update', note: plan.notes.join(', ') })
      if (write) {
        const trailing = pkgText.endsWith('\n') ? '\n' : ''
        await Bun.write(join(dir, 'package.json'), JSON.stringify(plan.pkg, null, detectIndent(pkgText)) + trailing)
      }
    } else changes.push({ path: 'package.json', action: 'ok', note: 'knip' })

    const configs = [...names].filter((n) => KNIP_CONFIG_FILE.test(n))
    if (pkg.knip !== undefined) configs.push('package.json#knip')
    if (configs.length) changes.push({ path: configs.join(', '), action: 'ok', note: 'existing Knip config kept' })
    else {
      changes.push({ path: 'knip.json', action: 'create', note: `baseline: ${KNIP_INCLUDE.join(', ')}` })
      if (write) await Bun.write(join(dir, 'knip.json'), KNIP_CONFIG)
    }

    const oxlintConfigs = [...names].filter((n) => OXLINT_CONFIG_FILE.test(n))
    if (!oxlintConfigs.length) {
      changes.push({ path: '.oxlintrc.json', action: 'create', note: 'extends .oxlintrc.devkit.jsonc' })
      if (write) await Bun.write(join(dir, '.oxlintrc.json'), OXLINT_CONFIG)
    } else {
      const text = (await readText(join(dir, oxlintConfigs[0] as string))) ?? ''
      const extended = text.includes('.oxlintrc.devkit.jsonc')
      changes.push({ path: oxlintConfigs.join(', '), action: 'ok', note: 'existing oxlint config kept' })
      if (!extended) notes.push(`${oxlintConfigs[0]} does not extend ./.oxlintrc.devkit.jsonc: add it to \`extends\`.`)
    }
    const others = [...names].filter((n) => OTHER_TOOLS.test(n))
    if (others.length) notes.push(`Found ${others.join(', ')}: oxlint and oxfmt replace it. Remove it and its dependencies.`)

    // A transitive entry does not lock the root project’s direct dependency.
    const lock = await readText(join(dir, 'bun.lock'))
    const locked = lock === null ? undefined : Bun.JSONC.parse(lock) as { workspaces?: Record<string, PackageJson> }
    const root = locked?.workspaces?.['']
    const stale = ['knip', ...OXC_PACKAGES].some(
      (name) =>
        (root?.devDependencies?.[name] ?? root?.dependencies?.[name]) !==
        (plan.pkg.devDependencies?.[name] ?? plan.pkg.dependencies?.[name]),
    )
    if (stale) {
      const action = lock === null ? 'create' : 'update'
      if (!write) changes.push({ path: 'bun.lock', action, note: 'bun install' })
      else if (opts.install === false) notes.push('Run `bun install` to update bun.lock.')
      else {
        const proc = Bun.spawnSync([process.execPath, 'install'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
        if (proc.exitCode !== 0) {
          throw new Error(`bun install failed; fix it and run devkit init again: ${proc.stderr.toString().trim()}`)
        }
        changes.push({ path: 'bun.lock', action, note: 'bun install' })
      }
    }
  }

  if (files['lefthook.yml']) notes.push('Run `lefthook install` once per clone (needs lefthook and gitleaks).')
  if (profile === 'bun') {
    notes.push(
      'Run `bun run format` once and commit the result on its own, then fix what `bun run lint` reports. ' +
        'Exceptions go in .oxlintrc.json: https://github.com/neoromantic/devkit/blob/main/docs/standards/lint-format.md',
    )
    notes.push('Run `bun run check`: it runs the format check, lint and Knip.')
  }
  if (!write && changes.some((c) => c.action === 'create' || c.action === 'update' || c.action === 'adopt')) {
    notes.push('Dry run: nothing was written. Run again without --dry-run.')
  }
  return { dir, profile, repo: repo.fullName, packageManager: pm, written: write, changes, notes }
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      'usage: init [--dir path] [--dry-run] [--json] [--repo owner/name] [--profile bun|python] [--adopt] [--no-install]',
    )
    return 0
  }
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string', default: '.' },
      'dry-run': { type: 'boolean' },
      json: { type: 'boolean' },
      repo: { type: 'string' },
      profile: { type: 'string' },
      adopt: { type: 'boolean' },
      'no-install': { type: 'boolean' },
    },
  })
  if (values.profile !== undefined && values.profile !== 'bun' && values.profile !== 'python') {
    throw new Error('--profile must be bun or python')
  }
  const result = await init({
    dir: values.dir ?? '.',
    dryRun: values['dry-run'] === true,
    adopt: values.adopt === true,
    install: values['no-install'] !== true,
    repo: values.repo,
    profile: values.profile as Profile | undefined,
  })
  if (values.json) {
    console.log(JSON.stringify(result))
    return 0
  }
  console.log(`${result.repo} (${result.profile}${result.packageManager ? `, ${result.packageManager}` : ''})`)
  for (const c of result.changes) console.log(`  ${c.action.padEnd(6)} ${c.path}${c.note ? `  — ${c.note}` : ''}`)
  for (const n of result.notes) console.log(`\n${n}`)
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
