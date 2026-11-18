#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { excludedPaths } from "./lib/exclude.ts";

export const GITLEAKS = ["git", "--pre-commit", "--staged", "--redact", "--no-banner", "--verbose"];
export const NO_COLOR = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "color.diff",
  GIT_CONFIG_VALUE_0: "never",
};

function git(cwd: string, args: string[], env: Record<string, string | undefined> = process.env) {
  const proc = Bun.spawnSync(["git", ...args], { cwd, env, stderr: "pipe" });
  if (proc.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
  return proc.stdout.toString();
}

function boundIndex(root: string, dir: string, paths: string[]) {
  const index = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim();
  const copy = join(dir, "index");
  if (existsSync(index)) copyFileSync(index, copy);
  const env = { ...process.env, GIT_INDEX_FILE: copy };
  const specs = paths.map((path) => `:(top)${path}`);
  const born = Bun.spawnSync(["git", "rev-parse", "--verify", "-q", "HEAD"], { cwd: root });
  git(
    root,
    born.exitCode === 0
      ? ["reset", "-q", "HEAD", "--", ...specs]
      : ["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--", ...specs],
    env,
  );
  return copy;
}

export function main(argv: string[], cwd = process.cwd()) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("usage: gitleaks-staged   gitleaks on staged changes, outside .devkit-exclude");
    return 0;
  }
  if (!Bun.which("gitleaks")) {
    console.error("gitleaks is not on PATH: install it (brew install gitleaks).");
    return 1;
  }
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const paths = excludedPaths(root);
  const dir = mkdtempSync(join(tmpdir(), "devkit-gitleaks-"));
  try {
    const env: Record<string, string | undefined> = { ...process.env, ...NO_COLOR };
    if (paths.length > 0) env.GIT_INDEX_FILE = boundIndex(root, dir, paths);
    const proc = Bun.spawnSync(["gitleaks", ...GITLEAKS], {
      cwd: root,
      env,
      stdout: "inherit",
      stderr: "inherit",
    });
    return proc.exitCode;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
