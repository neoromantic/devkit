import { describe, expect, test } from 'bun:test'
import { applyAgentsBlock, isManaged, planFile, render } from '../scripts/lib/managed'

const BLOCK = '<!-- devkit:agents v1 -->\n## Shared rules\n- one\n<!-- /devkit:agents -->\n'

describe('render', () => {
  test('replaces known variables', () => {
    expect(render('{{ owner }}/{{name}}', { owner: 'o', name: 'n' })).toBe('o/n')
  })
  test('throws on unknown variables', () => {
    expect(() => render('{{nope}}', {})).toThrow('unknown template variable {{nope}}')
  })
})

describe('applyAgentsBlock', () => {
  test('creates a new AGENTS.md', () => {
    const out = applyAgentsBlock(null, BLOCK, 'demo')
    expect(out.startsWith('# demo\n\n<!-- devkit:agents v1 -->')).toBe(true)
    expect(out).toContain('## Project')
  })

  test('replaces an older block in place and keeps the rest', () => {
    const existing = '# demo\n\n<!-- devkit:agents v0 -->\nold\n<!-- /devkit:agents -->\n\n## Project\n\nmine\n'
    const out = applyAgentsBlock(existing, BLOCK, 'demo')
    expect(out).toBe(`# demo\n\n${BLOCK.trim()}\n\n## Project\n\nmine\n`)
    expect(applyAgentsBlock(out, BLOCK, 'demo')).toBe(out)
  })

  test('inserts after the first heading when there is no block', () => {
    const out = applyAgentsBlock('# demo\n\nSome rules.\n', BLOCK, 'demo')
    expect(out).toBe(`# demo\n\n${BLOCK.trim()}\n\nSome rules.\n`)
  })

  test('inserts at the top when there is no heading', () => {
    expect(applyAgentsBlock('rules\n', BLOCK, 'demo')).toBe(`${BLOCK.trim()}\n\nrules\n`)
  })
})

describe('planFile', () => {
  test('decides per existing content', () => {
    expect(planFile('x', 'x', false)).toBe('ok')
    expect(planFile(null, 'x', false)).toBe('create')
    expect(planFile('# managed by devkit v1\nold', 'new', false)).toBe('update')
    expect(planFile('hand written', 'new', false)).toBe('skip')
    expect(planFile('hand written', 'new', true)).toBe('adopt')
  })
  test('isManaged looks for the mark', () => {
    expect(isManaged('<!-- managed by devkit v1 -->')).toBe(true)
    expect(isManaged('plain')).toBe(false)
  })
})
