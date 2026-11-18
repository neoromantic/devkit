import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./knip-push";

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "devkit-knip-push-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function manifest(scripts: Record<string, string>) {
  return JSON.stringify({ name: "demo", scripts });
}

test("runs the repo's check:knip and fails the push with its exit code", () =>
  withDir(async (dir) => {
    await Bun.write(
      join(dir, "package.json"),
      manifest({ "check:knip": "bun -e \"require('node:fs').writeFileSync('ran', '')\"" }),
    );
    expect(main(dir)).toBe(0);
    expect(await Bun.file(join(dir, "ran")).exists()).toBe(true);

    await Bun.write(
      join(dir, "package.json"),
      manifest({ "check:knip": 'bun -e "process.exit(3)"' }),
    );
    expect(main(dir)).toBe(3);
  }));

test("does nothing in a repo without package.json or without check:knip", () =>
  withDir(async (dir) => {
    expect(main(dir)).toBe(0);
    await Bun.write(join(dir, "package.json"), manifest({ check: 'bun -e "process.exit(1)"' }));
    expect(main(dir)).toBe(0);
  }));
