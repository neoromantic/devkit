import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const EXCLUDE_FILE = ".devkit-exclude";

export function excludedPaths(root: string) {
  const path = join(root, EXCLUDE_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

export function excludePathspecs(root: string) {
  return excludedPaths(root).map((path) => `:(top,exclude)${path}`);
}
