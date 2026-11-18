import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { INIT_FILES, KNIP_CONFIG, OXLINT_CONFIG } from "./init";
import { applyAgentsBlock, render, templateVars } from "./lib/managed";
import {
  AGENTS_BLOCK_PATH,
  loadReposFile,
  resolveRepos,
  ROOT,
  type Repo,
  TEMPLATES_DIR,
} from "./lib/repos";
import { main as oxcStaged } from "./oxc-staged";
import { withPack } from "./sync";

const OXFMT = join(ROOT, "node_modules", ".bin", "oxfmt");

async function withDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "devkit-oxc-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function git(dir: string, ...args: string[]) {
  expect(Bun.spawnSync(["git", ...args], { cwd: dir }).exitCode).toBe(0);
}

const repo: Repo = {
  name: "demo",
  owner: "someone",
  fullName: "someone/demo",
  profile: "bun",
  files: {},
  settings: {},
};

async function template(name: string) {
  return render(await Bun.file(join(TEMPLATES_DIR, name)).text(), templateVars(repo));
}

function oxfmtCheck(dir: string) {
  const proc = Bun.spawnSync([OXFMT, "--check", "."], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

describe("managed files come out formatted", () => {
  test("every rendered template, the CI stub with pack and the init configs pass oxfmt", () =>
    withDir(async (dir) => {
      const names = new Set([
        ...resolveRepos(await loadReposFile()).flatMap((r) => Object.values(r.files)),
        ...Object.values(INIT_FILES).flatMap((files) => Object.values(files)),
        "lefthook.private.yml",
        ".oxlintrc.devkit.react.jsonc",
      ]);
      for (const name of names) {
        await mkdir(dirname(join(dir, name)), { recursive: true });
        await Bun.write(join(dir, name), await template(name));
      }
      await Bun.write(join(dir, "ci.pack.yml"), withPack(await template("ci.bun.yml")));
      await Bun.write(join(dir, "knip.json"), KNIP_CONFIG);
      await Bun.write(join(dir, ".oxlintrc.json"), OXLINT_CONFIG);
      const result = oxfmtCheck(dir);
      expect(result.out).not.toContain("Format issues");
      expect(result.code).toBe(0);
    }));

  test("the AGENTS block keeps a new or formatted AGENTS.md formatted", () =>
    withDir(async (dir) => {
      const block = await Bun.file(AGENTS_BLOCK_PATH).text();
      await Bun.write(join(dir, ".oxfmtrc.jsonc"), await template(".oxfmtrc.jsonc"));
      await Bun.write(join(dir, "NEW.md"), applyAgentsBlock(null, block, "demo"));
      await Bun.write(
        join(dir, "EXISTING.md"),
        applyAgentsBlock("# demo\n\n## Project\n\nOur rules.\n", block, "demo"),
      );
      await Bun.write(
        join(dir, "TOP.md"),
        applyAgentsBlock("Rules without a heading.\n", block, "demo"),
      );
      const result = oxfmtCheck(dir);
      expect(result.out).not.toContain("Format issues");
      expect(result.code).toBe(0);
    }));
});

describe("the shared oxlint config", () => {
  test("enables every rule and plugin of landmines recommended as an error", async () => {
    const shared = Bun.JSONC.parse(
      await Bun.file(join(TEMPLATES_DIR, ".oxlintrc.devkit.jsonc")).text(),
    ) as {
      jsPlugins: unknown[];
      rules: Record<string, string>;
      plugins: string[];
    };
    const recommended = (await Bun.file(
      join(ROOT, "node_modules", "@interfere", "landmines", "configs", "recommended.json"),
    ).json()) as { jsPlugins: unknown[]; rules: Record<string, string> };
    expect(shared.jsPlugins).toEqual(recommended.jsPlugins);
    for (const rule of Object.keys(recommended.rules)) expect(shared.rules[rule]).toBe("error");
    expect(shared.plugins).toEqual(["typescript", "unicorn", "oxc", "import"]);
  });
});

describe("oxc-staged", () => {
  async function project(dir: string) {
    await Bun.write(join(dir, ".oxfmtrc.jsonc"), await template(".oxfmtrc.jsonc"));
    await Bun.write(join(dir, ".oxlintrc.devkit.jsonc"), await template(".oxlintrc.devkit.jsonc"));
    await Bun.write(join(dir, ".oxlintrc.json"), OXLINT_CONFIG);
    await Bun.write(join(dir, "package.json"), '{\n  "name": "demo",\n  "type": "module"\n}\n');
    await symlink(join(ROOT, "node_modules"), join(dir, "node_modules"));
    await Bun.write(join(dir, ".gitignore"), "node_modules\n");
  }

  const codes = { unadopted: [] as number[], root: [] as number[], subdirectory: [] as number[] };

  beforeAll(async () => {
    codes.unadopted = await withDir(async (dir) => {
      git(dir, "init", "--quiet");
      await Bun.write(join(dir, "a.ts"), "const  x=1\n// prose\n");
      git(dir, "add", ".");
      return [oxcStaged([], dir)];
    });

    codes.root = await withDir(async (dir) => {
      git(dir, "init", "--quiet");
      await project(dir);
      await Bun.write(join(dir, "a.ts"), "export const x = 1;\n");
      git(dir, "add", ".");
      const clean = oxcStaged([], dir);

      await Bun.write(join(dir, "a.ts"), "export const  x=1\n");
      git(dir, "add", "a.ts");
      const unformatted = oxcStaged([], dir);

      await Bun.write(join(dir, "a.ts"), "// prose\nexport const x = 1;\n");
      git(dir, "add", "a.ts");
      return [clean, unformatted, oxcStaged([], dir)];
    });

    codes.subdirectory = await withDir(async (dir) => {
      git(dir, "init", "--quiet");
      await mkdir(join(dir, "plugin"));
      await project(join(dir, "plugin"));
      await Bun.write(join(dir, "main.go"), "package main\n");
      await Bun.write(
        join(dir, "plugin", "a.ts"),
        "export function f(): number {\n  return 1;\n}\n",
      );
      git(dir, "add", ".");
      const returnType = oxcStaged([], dir);
      await Bun.write(join(dir, "plugin", "a.ts"), "export function f() {\n  return 1;\n}\n");
      git(dir, "add", ".");
      return [returnType, oxcStaged([], dir)];
    });
  }, 60_000);

  test("does nothing in a repo that is not on the standard", () => {
    expect(codes.unadopted).toEqual([0]);
  });

  test("checks staged files with oxfmt and with oxlint, landmines included", () => {
    expect(codes.root).toEqual([0, 1, 1]);
  });

  test("checks a package in a subdirectory from that package", () => {
    expect(codes.subdirectory).toEqual([1, 0]);
  });
});
