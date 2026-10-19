import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALLOW_COMMENT,
  GENERIC_RULES,
  hasHomePath,
  hasPhone,
  parseMarkers,
  parseUnifiedDiff,
  scanLine,
  scanText,
} from '../scripts/privacy-scan'

// Built at runtime so this file doesn't trip the scanner itself.
const PHONE = ['+44', '7700', '9124', '86'].join(' ')
const HOME = ['', 'Users', 'alice', 'Developer', 'x'].join('/')

describe('generic patterns', () => {
  test('finds phone numbers in common formats', () => {
    expect(hasPhone(`call ${PHONE}`)).toBe(true)
    expect(hasPhone(`tel:${PHONE.replace(/ /g, '')}`)).toBe(true)
    expect(hasPhone(`"phone": "${PHONE.replace(/ /g, '-')}"`)).toBe(true)
  })

  test('ignores placeholders and non-phones', () => {
    expect(hasPhone('+1234567890')).toBe(false)
    expect(hasPhone('+1 555 0100 123')).toBe(false)
    expect(hasPhone('+7 000 000 00 00')).toBe(false)
    expect(hasPhone('+11111111111')).toBe(false)
    expect(hasPhone('version 1.4.2 +build.20261019')).toBe(false)
    expect(hasPhone('a+1 = 2')).toBe(false)
    expect(hasPhone('sha256-abc+1234567890123/def==')).toBe(false)
  })

  test('finds home directory paths but not placeholders', () => {
    expect(hasHomePath(`open ${HOME}`)).toBe(true)
    expect(hasHomePath(['', 'home', 'bob', '.config'].join('/'))).toBe(true)
    expect(hasHomePath(['C:', 'Users', 'bob', 'x'].join('\\'))).toBe(true)
    expect(hasHomePath('/Users/<name>/Developer')).toBe(false)
    expect(hasHomePath('/home/runner/work/x')).toBe(false)
    expect(hasHomePath('/Users/you/code')).toBe(false)
    expect(hasHomePath('~/Developer/open-source')).toBe(false)
    expect(hasHomePath('/usr/local/bin')).toBe(false)
  })

  test('allow comment silences a line', () => {
    expect(scanLine(`${PHONE} # ${ALLOW_COMMENT}`, GENERIC_RULES)).toBeNull()
    expect(scanLine(PHONE, GENERIC_RULES)).toBe('phone')
  })
})

describe('private markers', () => {
  test('literal markers are case-insensitive, regex markers keep flags', () => {
    const rules = parseMarkers('# comment\n\nSecret Project\n/inter(nal)?-host-\\d+/\n')
    expect(rules).toHaveLength(2)
    expect(scanLine('see SECRET project notes', rules)).toBe('marker')
    expect(scanLine('ssh internal-host-42', rules)).toBe('marker')
    expect(scanLine('INTERNAL-HOST-42', rules)).toBeNull()
    expect(scanLine('nothing here', rules)).toBeNull()
  })

  test('literal markers with regex characters are escaped', () => {
    const rules = parseMarkers('a.b (c)\n')
    expect(scanLine('x a.b (c) y', rules)).toBe('marker')
    expect(scanLine('x aXb (c) y', rules)).toBeNull()
  })

  test('invalid regex reports the line number only', () => {
    expect(() => parseMarkers('ok\n/[unclosed/\n')).toThrow('private-markers line 2: invalid regular expression')
  })
})

describe('scanText', () => {
  test('reports 1-based line numbers', () => {
    const hits = scanText('a.md', `one\n${PHONE}\nthree\n${HOME}\n`, GENERIC_RULES)
    expect(hits.map((h) => `${h.path}:${h.line}:${h.kind}`)).toEqual(['a.md:2:phone', 'a.md:4:home-path'])
  })
})

describe('parseUnifiedDiff', () => {
  test('returns added lines with new-file line numbers', () => {
    const diff = [
      'diff --git a/x.txt b/x.txt',
      '--- a/x.txt',
      '+++ b/x.txt',
      '@@ -2 +2,2 @@',
      '-old',
      '+new two',
      '+new three',
      '@@ -10,0 +12 @@',
      '+++ starts with plus signs',
      'diff --git a/gone.txt b/gone.txt',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/new.txt b/new.txt',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+hello',
      '\\ No newline at end of file',
    ].join('\n')
    expect(parseUnifiedDiff(diff)).toEqual([
      { path: 'x.txt', line: 2, text: 'new two' },
      { path: 'x.txt', line: 3, text: 'new three' },
      { path: 'x.txt', line: 12, text: '++ starts with plus signs' },
      { path: 'new.txt', line: 1, text: 'hello' },
    ])
  })
})

describe('cli', () => {
  async function runScan(args: string[], cwd: string, markers?: string) {
    const env: Record<string, string> = { ...process.env, DEVKIT_PRIVATE_MARKERS: markers ?? join(cwd, 'none') }
    const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'scripts', 'privacy-scan.ts'), ...args], {
      cwd,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, code }
  }

  test('staged mode flags only added lines and never prints the match', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devkit-scan-'))
    try {
      const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: dir })
      git('init', '-q', '-b', 'main')
      git('config', 'user.email', 'test@example.com')
      git('config', 'user.name', 'test')
      await Bun.write(join(dir, 'a.md'), `old ${PHONE}\nclean\n`)
      git('add', '.')
      git('commit', '-q', '-m', 'init')
      await Bun.write(join(dir, 'a.md'), `old ${PHONE}\nclean\nProject Falcon here\n`)
      await Bun.write(join(dir, 'markers'), 'project falcon\n')
      git('add', 'a.md')

      const hit = await runScan([], dir, join(dir, 'markers'))
      expect(hit.code).toBe(1)
      expect(hit.stdout.trim()).toBe('a.md:3')
      expect(hit.stdout + hit.stderr).not.toContain('Falcon')
      expect(hit.stdout + hit.stderr).not.toContain('7700')

      const generic = await runScan(['--no-markers'], dir)
      expect(generic.code).toBe(0)

      const all = await runScan(['--all', '--no-markers'], dir)
      expect(all.code).toBe(1)
      expect(all.stdout.trim()).toBe('a.md:1')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('unknown option exits 2', async () => {
    const res = await runScan(['--nope'], tmpdir())
    expect(res.code).toBe(2)
  })
})
