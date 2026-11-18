#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function main(cwd = process.cwd()) {
  const manifest = join(cwd, "package.json");
  if (!existsSync(manifest)) return 0;
  const { scripts } = JSON.parse(readFileSync(manifest, "utf8")) as {
    scripts?: Record<string, string>;
  };
  if (!scripts?.["check:knip"]) return 0;
  return Bun.spawnSync([process.execPath, "run", "check:knip"], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  }).exitCode;
}
