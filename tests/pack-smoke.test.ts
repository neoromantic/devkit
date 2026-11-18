import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../scripts/lib/repos";
import { binsOf, cleanEnv, parseArgs } from "../scripts/pack-smoke";

const SCRIPT = join(ROOT, "scripts", "pack-smoke.ts");
const dir = mkdtempSync(join(tmpdir(), "devkit-pack-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The fixture CLI fails if job state leaks in, and echoes its argv as JSON.
const CLI = `#!/usr/bin/env bun
const leaked = Object.entries(process.env).filter(([, v]) => v === 'fake-secret-value').map(([k]) => k)
if (leaked.length) { console.error('leaked', leaked); process.exit(9) }
if (process.env.HOME === process.env.DEVKIT_TEST_REAL_HOME) { console.error('real HOME'); process.exit(9) }
if (process.cwd().startsWith(process.env.DEVKIT_TEST_PKG ?? '\\0')) { console.error('ran in checkout'); process.exit(9) }
const args = process.argv.slice(2)
if (args[0] === 'fail') process.exit(3)
console.log(JSON.stringify(args))
`;

let n = 0;
function fixture(
  manifest: Record<string, unknown>,
  files: Record<string, string> = { "bin/cli.ts": CLI },
): string {
  const pkg = join(dir, `pkg${n++}`);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(pkg, path, ".."), { recursive: true });
    writeFileSync(join(pkg, path), body);
    chmodSync(join(pkg, path), 0o755);
  }
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@fake/demo-cli", version: "0.0.1", ...manifest }),
  );
  return pkg;
}

function smoke(pkg: string, env: Record<string, string> = {}) {
  // A PATH without Bun: the helper must supply its own Bun for the `env bun` shebang.
  const r = Bun.spawnSync([process.execPath, SCRIPT, pkg], {
    env: {
      PATH: "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/nonexistent",
      TMPDIR: dir,
      FAKE_TOKEN: "fake-secret-value",
      DEVKIT_TEST_REAL_HOME: process.env.HOME ?? "/nonexistent",
      DEVKIT_TEST_PKG: pkg,
      ...env,
    },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const GOOD = { bin: { demo: "bin/cli.ts" }, files: ["bin"] };

describe("pack-smoke helper", () => {
  test("packs, installs in isolation and runs the CLI with --help", () => {
    const r = smoke(fixture(GOOD));
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain('["--help"]');
    expect(r.out).toContain("pack-smoke: ok");
  });

  test("keeps argv boundaries and runs several invocations", () => {
    const args = [["a b", "", '--q="x y"', "$HOME", "*"], ["--version"]];
    const r = smoke(fixture(GOOD), { DEVKIT_PACK_ARGS: JSON.stringify(args) });
    expect(r.code).toBe(0);
    expect(r.out).toContain(JSON.stringify(args[0]));
    expect(r.out).toContain('["--version"]');
  });

  test("fails when a bin entry is missing from the tarball", () => {
    const r = smoke(
      fixture({ bin: { demo: "bin/cli.ts", other: "dist/other.js" }, files: ["bin"] }),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("bin other: dist/other.js is missing from the tarball");
  });

  test('fails when a module the CLI imports was left out of "files"', () => {
    const pkg = fixture(GOOD, {
      "bin/cli.ts": `#!/usr/bin/env bun\nimport { help } from '../lib/help.ts'\nconsole.log(help)\n`,
      "lib/help.ts": `export const help = 'usage: demo'\n`,
    });
    const r = smoke(pkg);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Cannot find module");
    expect(r.err).toContain('demo ["--help"]: exit 1');
  });

  test("fails when the CLI exits non-zero", () => {
    const r = smoke(fixture(GOOD), { DEVKIT_PACK_ARGS: '["fail"]' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('demo ["fail"]: exit 3');
  });

  test("resolves a string bin to the unscoped package name", () => {
    expect(smoke(fixture({ bin: "bin/cli.ts", files: ["bin"] })).out).toContain(
      '$ demo-cli ["--help"]',
    );
  });

  test("refuses a package without bin", () => {
    const r = smoke(fixture({ files: ["bin"] }));
    expect(r.code).toBe(2);
    expect(r.err).toContain("no bin to run");
  });

  test("reads the package dir from DEVKIT_PACK_DIR", () => {
    const pkg = fixture(GOOD);
    const r = Bun.spawnSync([process.execPath, SCRIPT], {
      cwd: dir,
      env: { PATH: "/usr/bin:/bin", TMPDIR: dir, DEVKIT_PACK_DIR: pkg },
    });
    expect(r.exitCode).toBe(0);
  });

  test("dogfoods devkit itself", () => {
    const r = Bun.spawnSync([process.execPath, SCRIPT, ROOT], {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/nonexistent",
        TMPDIR: dir,
        DEVKIT_PACK_ARGS: '[["--help"],["status","--help"]]',
      },
    });
    expect(r.stderr.toString()).toBe("");
    expect(r.stdout.toString()).toContain("usage: devkit <");
    expect(r.exitCode).toBe(0);
  }, 60_000);
});

describe("pack-smoke units", () => {
  test("parseArgs", () => {
    expect(parseArgs(undefined)).toEqual([["--help"]]);
    expect(parseArgs("  ")).toEqual([["--help"]]);
    expect(parseArgs('["--version"]')).toEqual([["--version"]]);
    expect(parseArgs('[["-h"],["a b"]]')).toEqual([["-h"], ["a b"]]);
    for (const bad of ["--help", "[]", "[1]", '[["a"],"b"]', "{}"])
      expect(() => parseArgs(bad)).toThrow();
  });

  test("binsOf", () => {
    expect(binsOf({ name: "@s/x", bin: "cli.js" })).toEqual({ x: "cli.js" });
    expect(binsOf({ name: "x", bin: { a: "a.js", b: 1 } })).toEqual({ a: "a.js" });
    expect(binsOf({ name: "x" })).toEqual({});
  });

  test("cleanEnv keeps only the allowlist", () => {
    process.env.FAKE_TOKEN_FOR_TEST = "nope";
    process.env.HTTPS_PROXY ??= "http://proxy.example.com:3128";
    try {
      const run = cleanEnv({ home: "/h", tmp: "/t", path: ["/b"] });
      expect(Object.values(run)).not.toContain("nope");
      expect(run.HOME).toBe("/h");
      expect(run.PATH).toBe("/b");
      expect(run.HTTPS_PROXY).toBeUndefined();
      expect(
        cleanEnv({ home: "/h", tmp: "/t", path: [], install: true }).HTTPS_PROXY,
      ).toBeDefined();
    } finally {
      delete process.env.FAKE_TOKEN_FOR_TEST;
    }
  });
});

describe("ci-bun.yml pack step", () => {
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "ci-bun.yml"), "utf8");

  test("pack is an optional boolean input that defaults to false", () => {
    expect(workflow).toMatch(
      /\n {6}pack:\n {8}description: .+\n {8}type: boolean\n {8}default: false\n/,
    );
    expect(workflow).toMatch(
      /\n {6}pack-args:\n {8}description: .+\n {8}type: string\n {8}default: ''\n/,
    );
  });

  test("takes the helper from the exact called revision and keeps it out of the package", () => {
    expect(workflow).toContain("repository: ${{ fromJSON(toJSON(job)).workflow_repository }}");
    expect(workflow).toContain("ref: ${{ fromJSON(toJSON(job)).workflow_sha }}");
    expect(workflow).toContain("sparse-checkout: scripts/pack-smoke.ts");
    expect(workflow).toContain('rm -rf "$GITHUB_WORKSPACE/.devkit-pack-helper"');
    expect(workflow.indexOf("- name: Pack and run")).toBeLessThan(
      workflow.indexOf("- name: Test\n"),
    );
  });
});
