#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export const FORMAT_CONFIG = ".oxfmtrc.jsonc";
export const LINT_CONFIG = ".oxlintrc.devkit.jsonc";
const LINTABLE = /\.[cm]?[jt]sx?$/;

function git(cwd: string, args: string[]) {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  if (proc.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
  return proc.stdout.toString();
}

function adopted(dir: string, config: string) {
  const path = join(dir, config);
  return existsSync(path) && readFileSync(path, "utf8").includes("managed by devkit");
}

export function owners(root: string, files: string[], config: string) {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    let dir = dirname(join(root, file));
    while (!adopted(dir, config) && dir !== root && dir.startsWith(root)) dir = dirname(dir);
    if (!adopted(dir, config)) continue;
    groups.set(dir, [...(groups.get(dir) ?? []), relative(dir, join(root, file))]);
  }
  return groups;
}

function runTool(dir: string, tool: string, args: string[], files: string[]) {
  if (!existsSync(join(dir, "node_modules", tool, "package.json"))) {
    console.error(`${tool} is not installed in ${dir}: run bun install there. Skipped.`);
    return true;
  }
  const proc = Bun.spawnSync([process.execPath, "x", tool, ...args, ...files], {
    cwd: dir,
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exitCode === 0;
}

export function main(argv: string[], cwd = process.cwd()) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "usage: oxc-staged   check staged files with oxfmt and oxlint where the repo uses the shared standard",
    );
    return 0;
  }
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const staged = git(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
    .split("\0")
    .filter(Boolean);
  let ok = true;
  for (const [dir, files] of owners(root, staged, FORMAT_CONFIG)) {
    ok = runTool(dir, "oxfmt", ["--check", "--no-error-on-unmatched-pattern"], files) && ok;
  }
  const scripts = staged.filter((file) => LINTABLE.test(file));
  for (const [dir, files] of owners(root, scripts, LINT_CONFIG)) {
    ok = runTool(dir, "oxlint", ["--deny-warnings"], files) && ok;
  }
  return ok ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
