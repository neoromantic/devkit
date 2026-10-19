import type { Repo } from './repos'

export const MANAGED_MARK = 'managed by devkit'
export const AGENTS_BEGIN = /<!-- devkit:agents v\d+ -->/
export const AGENTS_END = '<!-- /devkit:agents -->'

export function isManaged(content: string): boolean {
  return content.includes(MANAGED_MARK)
}

export function templateVars(repo: Repo): Record<string, string> {
  return {
    owner: repo.owner,
    name: repo.name,
    full_name: repo.fullName,
    description: repo.description ?? '',
    renovate_preset: repo.maintenance ? 'maintenance' : 'default',
  }
}

/** Replace `{{var}}` placeholders. Unknown placeholders are an error, so typos don't ship. */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, key: string) => {
    const value = vars[key]
    if (value === undefined) throw new Error(`unknown template variable {{${key}}}`)
    return value
  })
}

/**
 * Put the shared block into an AGENTS.md.
 *  - existing block (any version) -> replaced in place;
 *  - no block -> inserted after the first `# ` heading, or at the top;
 *  - no file -> a new AGENTS.md with the block and an empty `## Project` section.
 */
export function applyAgentsBlock(existing: string | null, block: string, repoName: string): string {
  const body = block.trim()
  if (existing === null) {
    return `# ${repoName}\n\n${body}\n\n## Project\n\nProject-specific rules go here, below the devkit block.\n`
  }
  const begin = AGENTS_BEGIN.exec(existing)
  const endIdx = existing.indexOf(AGENTS_END)
  if (begin && endIdx > begin.index) {
    return existing.slice(0, begin.index) + body + existing.slice(endIdx + AGENTS_END.length)
  }
  const lines = existing.split('\n')
  const firstContent = lines.findIndex((l) => l.trim() !== '')
  if (firstContent !== -1 && /^# /.test(lines[firstContent] ?? '')) {
    const head = lines.slice(0, firstContent + 1).join('\n')
    const rest = lines
      .slice(firstContent + 1)
      .join('\n')
      .replace(/^\n+/, '')
    return `${head}\n\n${body}\n\n${rest}`
  }
  return `${body}\n\n${existing.replace(/^\n+/, '')}`
}

export type FileAction = 'ok' | 'create' | 'update' | 'adopt' | 'skip'

export function planFile(existing: string | null, desired: string, adopt: boolean): FileAction {
  if (existing === desired) return 'ok'
  if (existing === null) return 'create'
  if (isManaged(existing)) return 'update'
  return adopt ? 'adopt' : 'skip'
}
