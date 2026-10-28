import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isManaged, render } from '../scripts/lib/managed'

// The Go client is tested in a throwaway module: the template plus tests/telemetry/go, copied
// to a temp dir so nothing is written into the checkout.
const root = join(import.meta.dir, '..')
const template = join(root, 'templates/telemetry/telemetry.go')
const go = Bun.which('go')
if (!go) console.warn('telemetry-go: skipping the Go client tests, `go` is not installed')

/** The go1.N minor version in text, such as `go version` output. */
function goMinor(cmd: string[]): number {
  const out = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' }).stdout.toString()
  return Number(/go1\.(\d+)/.exec(out)?.[1] ?? 0)
}

// staticcheck only loads the standard library of a Go at least as new as the one it was built with.
let staticcheck = Bun.which('staticcheck')
if (go && staticcheck && goMinor(['go', 'version', staticcheck]) < goMinor(['go', 'version'])) {
  console.warn('telemetry-go: skipping staticcheck, it was built with an older Go; reinstall it')
  staticcheck = null
}

test('telemetry.go renders unchanged and carries the managed mark', async () => {
  const text = await Bun.file(template).text()
  expect(render(text, {})).toBe(text)
  expect(isManaged(text.split('\n')[0] ?? '')).toBe(true)
})

describe.skipIf(!go)('telemetry.go with the Go toolchain', () => {
  let dir = ''

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devkit-telemetry-go-'))
    await copyFile(template, join(dir, 'telemetry.go'))
    for (const name of ['go.mod', 'telemetry_test.go']) {
      await copyFile(join(root, 'tests/telemetry/go', name), join(dir, name))
    }
  })
  afterAll(() => rm(dir, { recursive: true, force: true }))

  function run(cmd: string[], env: Record<string, string> = {}) {
    const p = Bun.spawnSync(cmd, {
      cwd: dir,
      env: { ...process.env, GOWORK: 'off', GOFLAGS: '', ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { code: p.exitCode, output: `${p.stdout.toString()}${p.stderr.toString()}`.trim() }
  }

  test('go test', () => {
    const r = run(['go', 'test', '-count=1', './...'])
    expect(r.code, r.output).toBe(0)
  }, 300_000)

  // The release targets of the Go products.
  for (const goos of ['linux', 'darwin', 'windows']) {
    test(`go vet for ${goos}`, () => {
      const r = run(['go', 'vet', './...'], { GOOS: goos })
      expect(r.code, r.output).toBe(0)
    }, 300_000)
  }

  test('gofmt -l lists nothing', () => {
    expect(run(['gofmt', '-l', '.'])).toEqual({ code: 0, output: '' })
  })

  test.skipIf(!staticcheck)('staticcheck, when installed', () => {
    const r = run(['staticcheck', './...'])
    expect(r.code, r.output).toBe(0)
  }, 300_000)
})
