#!/usr/bin/env bun
/** devkit <command>: entry point for `bunx github:neoromantic/devkit#v1 <command>`. */
const COMMANDS: Record<string, () => Promise<{ main: (argv: string[]) => Promise<number> }>> = {
  'privacy-scan': () => import('./privacy-scan'),
  sync: () => import('./sync'),
  'repo-settings': () => import('./repo-settings'),
  status: () => import('./status'),
}

const [command, ...rest] = process.argv.slice(2)
const load = command ? COMMANDS[command] : undefined
if (!load) {
  console.error(`usage: devkit <${Object.keys(COMMANDS).join(' | ')}> [options]`)
  process.exit(command === undefined || command === '--help' || command === '-h' ? 0 : 2)
}
const mod = await load()
try {
  process.exit(await mod.main(rest))
} catch (err) {
  console.error((err as Error).message)
  process.exit(2)
}

export {}
