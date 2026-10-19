#!/usr/bin/env bun
/**
 * privacy-scan: block private text from reaching a public repo.
 *
 * Checks lines against two rule sets:
 *  - generic patterns (phone numbers, home directory paths), always on;
 *  - private markers from ~/.config/devkit/private-markers (one per line,
 *    `/regex/flags` or a plain case-insensitive string). That file never
 *    lives in a repo.
 *
 * Prints only `path:line` for each hit, never the matched text, so CI logs
 * and terminal scrollback don't leak the very thing it found.
 *
 * Exit codes: 0 clean, 1 hits, 2 usage or setup error.
 */
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

export const ALLOW_COMMENT = 'privacy-scan:allow'
const MAX_FILE_BYTES = 5 * 1024 * 1024
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'dist', '.tmp'])

export type RuleKind = 'marker' | 'phone' | 'home-path'
export interface Rule {
  kind: RuleKind
  test: (line: string) => boolean
}
export interface Hit {
  path: string
  line: number
  kind: RuleKind
}

const PHONE_CANDIDATE = /(?<![\w+/=])\+\d[\d ().-]{7,20}\d(?![\w])/g

/** Digits of a phone-like string, or null when it is an obvious placeholder. */
export function phoneDigits(candidate: string): string | null {
  const digits = candidate.replace(/\D/g, '')
  if (digits.length < 10 || digits.length > 15) return null
  if (/^(\d)\1+$/.test(digits)) return null
  if (digits.includes('1234567') || digits.includes('9876543')) return null
  // North American fictional range: +1 555 01xx and friends.
  if (/^1555/.test(digits)) return null
  // Mostly zeros (+44 20 0000 0000 and similar) is a placeholder.
  if ((digits.match(/0/g)?.length ?? 0) >= digits.length - 3) return null
  return digits
}

export function hasPhone(line: string): boolean {
  for (const m of line.matchAll(PHONE_CANDIDATE)) {
    if (phoneDigits(m[0])) return true
  }
  return false
}

const HOME_PATH =
  /(?:^|[^\w])(?:\/Users|\/home|[A-Za-z]:\\Users)[\\/](?!(?:runner|user|username|you|me|name|example|shared|Shared|Public|linuxbrew|USER|NAME)(?:[\\/]|$))[A-Za-z0-9._-]+[\\/]/

export function hasHomePath(line: string): boolean {
  return HOME_PATH.test(line)
}

export const GENERIC_RULES: Rule[] = [
  { kind: 'phone', test: hasPhone },
  { kind: 'home-path', test: hasHomePath },
]

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Parse a private-markers file. Blank lines and `#` comments are skipped.
 * `/body/flags` is a regex; anything else is a literal, case-insensitive.
 * Errors name the line number only, never the marker itself.
 */
export function parseMarkers(text: string): Rule[] {
  const rules: Rule[] = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const re = /^\/(.+)\/([dgimsuvy]*)$/.exec(line)
    let regex: RegExp
    try {
      regex = re ? new RegExp(re[1] ?? '', (re[2] ?? '').replace('g', '')) : new RegExp(escapeRegExp(line), 'i')
    } catch {
      throw new Error(`private-markers line ${i + 1}: invalid regular expression`)
    }
    rules.push({ kind: 'marker', test: (s) => regex.test(s) })
  })
  return rules
}

export function scanLine(line: string, rules: Rule[]): RuleKind | null {
  if (line.includes(ALLOW_COMMENT)) return null
  for (const rule of rules) {
    if (rule.test(line)) return rule.kind
  }
  return null
}

export function scanText(path: string, text: string, rules: Rule[]): Hit[] {
  const hits: Hit[] = []
  text.split('\n').forEach((line, i) => {
    const kind = scanLine(line, rules)
    if (kind) hits.push({ path, line: i + 1, kind })
  })
  return hits
}

export interface AddedLine {
  path: string
  line: number
  text: string
}

/** Added lines from `git diff -U0` output, with their line numbers in the new file. */
export function parseUnifiedDiff(diff: string): AddedLine[] {
  const out: AddedLine[] = []
  const lines = diff.split('\n')
  let path: string | null = null
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.startsWith('diff --git ')) {
      path = null
      i++
      continue
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4)
      path = target === '/dev/null' ? null : target.replace(/^b\//, '')
      i++
      continue
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk) {
      let oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1])
      let newLeft = hunk[3] === undefined ? 1 : Number(hunk[3])
      let lineNo = Number(hunk[2])
      i++
      while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
        const body = lines[i] ?? ''
        if (body.startsWith('+')) {
          if (path) out.push({ path, line: lineNo, text: body.slice(1) })
          lineNo++
          newLeft--
        } else if (body.startsWith('-')) {
          oldLeft--
        } else if (body.startsWith(' ')) {
          lineNo++
          oldLeft--
          newLeft--
        } else if (!body.startsWith('\\')) {
          break
        }
        i++
      }
      continue
    }
    i++
  }
  return out
}

function git(args: string[], cwd?: string): string {
  const proc = Bun.spawnSync(['git', '-c', 'core.quotePath=false', ...args], { cwd, stderr: 'pipe' })
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString().trim()}`)
  }
  return proc.stdout.toString()
}

function scanAdded(added: AddedLine[], rules: Rule[]): Hit[] {
  const hits: Hit[] = []
  for (const a of added) {
    const kind = scanLine(a.text, rules)
    if (kind) hits.push({ path: a.path, line: a.line, kind })
  }
  return hits
}

async function readTextFile(path: string): Promise<string | null> {
  const file = Bun.file(path)
  if (!(await file.exists()) || file.size > MAX_FILE_BYTES) return null
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.subarray(0, 8000).includes(0)) return null
  return new TextDecoder().decode(bytes)
}

async function* walk(path: string): AsyncGenerator<string> {
  const stat = await Bun.file(path)
    .stat()
    .catch(() => null)
  if (!stat) return
  if (!stat.isDirectory()) {
    yield path
    return
  }
  const glob = new Bun.Glob('**/*')
  for await (const rel of glob.scan({ cwd: path, dot: true, onlyFiles: true })) {
    if (rel.split('/').some((part) => SKIP_DIRS.has(part))) continue
    yield join(path, rel)
  }
}

export function defaultMarkersPath(): string {
  return process.env.DEVKIT_PRIVATE_MARKERS || join(homedir(), '.config', 'devkit', 'private-markers')
}

export async function loadMarkerRules(path: string, warn: (msg: string) => void): Promise<Rule[]> {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    warn(`privacy-scan: no private markers at ${path}; using generic patterns only`)
    return []
  }
  const stat = await file.stat()
  if ((stat.mode & 0o077) !== 0) {
    warn(`privacy-scan: ${path} is readable by others; run: chmod 600 ${path}`)
  }
  return parseMarkers(await file.text())
}

const USAGE = `usage: privacy-scan [--staged | --diff <range> | --all | <path>...] [--markers <file> | --no-markers]

  (no args)        scan lines added in the staged changes (pre-commit)
  --staged         same as no args
  --diff <range>   scan lines added in \`git diff <range>\` (e.g. origin/main...HEAD)
  --all            scan every tracked file
  <path>...        scan these files or directories
  --markers <file> private markers file (default: $DEVKIT_PRIVATE_MARKERS or ~/.config/devkit/private-markers)
  --no-markers     generic patterns only

Prints path:line for each hit and exits 1. Add "${ALLOW_COMMENT}" to a line to accept it.`

export async function main(argv: string[]): Promise<number> {
  let mode: 'staged' | 'diff' | 'all' | 'paths' = 'staged'
  let range = ''
  let markersPath: string | null = defaultMarkersPath()
  const paths: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      return 0
    } else if (arg === '--staged') mode = 'staged'
    else if (arg === '--all') mode = 'all'
    else if (arg === '--diff') {
      mode = 'diff'
      range = argv[++i] ?? ''
      if (!range) {
        console.error(USAGE)
        return 2
      }
    } else if (arg === '--markers') {
      markersPath = argv[++i] ?? null
      if (!markersPath) {
        console.error(USAGE)
        return 2
      }
    } else if (arg === '--no-markers') markersPath = null
    else if (arg.startsWith('-')) {
      console.error(`privacy-scan: unknown option ${arg}\n${USAGE}`)
      return 2
    } else {
      mode = 'paths'
      paths.push(arg)
    }
  }

  let rules: Rule[]
  try {
    const markers = markersPath ? await loadMarkerRules(markersPath, (m) => console.error(m)) : []
    rules = [...markers, ...GENERIC_RULES]
  } catch (err) {
    console.error(`privacy-scan: ${(err as Error).message}`)
    return 2
  }

  let hits: Hit[] = []
  try {
    if (mode === 'staged' || mode === 'diff') {
      const args =
        mode === 'staged'
          ? ['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--diff-filter=ACMR']
          : ['diff', '-U0', '--no-color', '--no-ext-diff', '--diff-filter=ACMR', range]
      hits = scanAdded(parseUnifiedDiff(git(args)), rules)
    } else {
      const files: string[] = []
      if (mode === 'all') {
        files.push(...git(['ls-files', '-z']).split('\0').filter(Boolean))
      } else {
        for (const p of paths) for await (const f of walk(p)) files.push(f)
      }
      for (const f of files) {
        const text = await readTextFile(f)
        if (text !== null) hits.push(...scanText(relative(process.cwd(), f) || f, text, rules))
      }
    }
  } catch (err) {
    console.error(`privacy-scan: ${(err as Error).message}`)
    return 2
  }

  if (hits.length === 0) return 0
  const seen = new Set<string>()
  for (const h of hits) {
    const key = `${h.path}:${h.line}`
    if (seen.has(key)) continue
    seen.add(key)
    console.log(key)
  }
  const files = new Set(hits.map((h) => h.path)).size
  console.error(
    `privacy-scan: ${seen.size} line(s) in ${files} file(s) look private (matched text is not printed). ` +
      `Fix them, or add "${ALLOW_COMMENT}" to a line that is fine.`,
  )
  return 1
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)))
}
