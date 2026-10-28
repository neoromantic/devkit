import { expect, test } from 'bun:test'
import { join } from 'node:path'

// Runs the unittest suite of templates/telemetry/telemetry.py (Python 3.11+, stdlib only).
const root = join(import.meta.dir, '..')

function findPython(): string | null {
  for (const name of ['python3', 'python']) {
    const path = Bun.which(name)
    if (!path) continue
    const probe = Bun.spawnSync([path, '-c', 'import sys; print(sys.version_info >= (3, 11))'])
    if (probe.exitCode === 0 && probe.stdout.toString().trim() === 'True') return path
  }
  return null
}

const python = findPython()
if (!python) console.warn('telemetry.py tests skipped: no python3 >= 3.11 on PATH')

test.skipIf(!python)(
  'telemetry.py passes its unittest suite',
  () => {
    // A clean environment: the suite sets its own HOME, state dir and endpoint.
    const run = Bun.spawnSync(
      [python ?? 'python3', '-B', '-m', 'unittest', 'discover', '-s', 'tests/telemetry/python'],
      { cwd: root, env: { PATH: process.env.PATH ?? '' }, stdout: 'pipe', stderr: 'pipe' },
    )
    const output = run.stderr.toString()
    if (run.exitCode !== 0) console.error(output)
    expect(run.exitCode).toBe(0)
    expect(output).toMatch(/\nOK/)
  },
  120_000,
)
