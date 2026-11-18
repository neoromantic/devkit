import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  init,
  INIT_FILES,
  KNIP_CONFIG,
  KNIP_INCLUDE,
  OXC_PACKAGES,
  OXLINT_CONFIG,
  planKnip,
  planOxc,
} from "./init";
import { render, templateVars } from "./lib/managed";
import { loadReposFile, type Repo, ROOT, TEMPLATES_DIR } from "./lib/repos";
import { syncCheckout, withPack } from "./sync";

const OWN = (await Bun.file(join(ROOT, "package.json")).json()).devDependencies as Record<
  string,
  string
>;
const KNIP = OWN.knip as string;
const TOOLS = Object.fromEntries(
  ["knip", ...OXC_PACKAGES].map((name) => [name, OWN[name] as string]),
);
const KNIP_BIN = join(ROOT, "node_modules", ".bin", "knip");

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "devkit-init-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function git(dir: string, ...args: string[]) {
  expect(Bun.spawnSync(["git", ...args], { cwd: dir }).exitCode).toBe(0);
}

async function gitRepo(dir: string, remote = "https://github.com/someone/demo.git") {
  git(dir, "init", "--quiet", "--initial-branch=main");
  git(dir, "remote", "add", "origin", remote);
}

async function fakeLock(dir: string) {
  await Bun.write(
    join(dir, "bun.lock"),
    `${JSON.stringify({ workspaces: { "": { devDependencies: TOOLS } } })}\n`,
  );
}

async function writeJson(path: string, value: unknown) {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function snapshot(dir: string) {
  const out: Record<string, string> = {};
  for (const f of await readdir(dir, { recursive: true })) {
    if (f.startsWith(".git/") || f === ".git") continue;
    const file = Bun.file(join(dir, f));
    if (await file.exists()) out[f] = await file.text();
  }
  return out;
}

function syncRepo(profile: "bun" | "python") {
  const repo: Repo = {
    name: "demo",
    owner: "someone",
    fullName: "someone/demo",
    profile,
    files: INIT_FILES[profile],
    settings: {},
  };
  return repo;
}

const actions = (r: { changes: { action: string; path: string }[] }) =>
  r.changes.map((c) => `${c.action} ${c.path}`);

describe("init profiles", () => {
  test("match the bun and python profiles in repos.yml, so sync keeps what init wrote", async () => {
    const file = await loadReposFile();
    for (const profile of ["bun", "python"] as const) {
      expect(INIT_FILES[profile]).toEqual({ ...file.files, ...file.profiles[profile]?.files });
    }
  });
});

describe("init: fresh Bun project", () => {
  test("dry run writes nothing, --write sets up devkit and Knip, a repeat is a no-op", () =>
    withDir(async (dir) => {
      await gitRepo(dir);
      await writeJson(join(dir, "package.json"), {
        name: "demo",
        module: "index.ts",
        type: "module",
      });
      await Bun.write(join(dir, "index.ts"), 'console.log("hi")\n');
      const before = await snapshot(dir);

      const dry = await init({ dir, dryRun: true });
      expect(dry.repo).toBe("someone/demo");
      expect(dry.written).toBe(false);
      expect(await snapshot(dir)).toEqual(before);
      expect(dry.notes.join("\n")).toContain("Dry run");

      const run = await init({ dir, install: false });
      expect(actions(run)).toEqual([
        "create SECURITY.md",
        "create .gitleaks.toml",
        "create .github/zizmor.yml",
        "create renovate.json",
        "create lefthook.yml",
        "create .github/workflows/ci.yml",
        "create CONTRIBUTING.md",
        "create .github/PULL_REQUEST_TEMPLATE.md",
        "create .oxfmtrc.jsonc",
        "create .oxlintrc.devkit.jsonc",
        "create AGENTS.md",
        "create CLAUDE.md",
        "update package.json",
        "create knip.json",
        "create .oxlintrc.json",
      ]);
      expect(actions(dry)).toEqual([...actions(run), "create bun.lock"]);
      expect(run.notes.join("\n")).toContain("Run `bun install`");
      await fakeLock(dir);
      const pkg = await Bun.file(join(dir, "package.json")).json();
      expect(pkg.devDependencies).toEqual(TOOLS);
      expect(Object.keys(pkg.devDependencies)).toEqual(Object.keys(TOOLS).sort());
      expect(pkg.scripts).toEqual({
        format: "oxfmt",
        "format:check": "oxfmt --check",
        lint: "oxlint --deny-warnings",
        "check:knip": "knip",
        check: "bun run format:check && bun run lint && bun run check:knip",
      });
      expect(await Bun.file(join(dir, "knip.json")).text()).toBe(KNIP_CONFIG);
      expect(await Bun.file(join(dir, ".oxlintrc.json")).text()).toBe(OXLINT_CONFIG);
      expect(run.notes.join("\n")).toContain("Run `bun run format` once");
      const ci = await Bun.file(join(dir, ".github/workflows/ci.yml")).text();
      expect(ci).toBe(
        render(
          await Bun.file(join(TEMPLATES_DIR, "ci.bun.yml")).text(),
          templateVars(syncRepo("bun")),
        ),
      );
      expect(ci).not.toContain("pack:");
      expect(await Bun.file(join(dir, "CLAUDE.md")).text()).toBe("@AGENTS.md\n");
      expect(await Bun.file(join(dir, "SECURITY.md")).text()).toContain(
        "someone/demo/security/advisories/new",
      );

      const after = await snapshot(dir);
      const again = await init({ dir, dryRun: true });
      expect(again.changes.every((c) => c.action === "ok")).toBe(true);
      expect(again.notes.join("\n")).not.toContain("Dry run");
      expect((await init({ dir, install: false })).changes.every((c) => c.action === "ok")).toBe(
        true,
      );
      expect(await snapshot(dir)).toEqual(after);
      expect(
        (await syncCheckout(syncRepo("bun"), dir, { adopt: false })).every(
          (c) => c.action === "ok",
        ),
      ).toBe(true);
    }));

  test("moves the rules bun init wrote to CLAUDE.md into AGENTS.md", () =>
    withDir(async (dir) => {
      await gitRepo(dir);
      await writeJson(join(dir, "package.json"), {
        name: "demo",
        scripts: { typecheck: "bun check" },
      });
      await Bun.write(
        join(dir, "CLAUDE.md"),
        "\nDefault to using Bun.\n\n## APIs\n\n- Use Bun.file.\n",
      );
      const dry = await init({ dir, dryRun: true });
      expect(await Bun.file(join(dir, "AGENTS.md")).exists()).toBe(false);
      const run = await init({ dir, install: false });
      expect(actions(run)).toEqual(actions(dry).filter((a) => a !== "create bun.lock"));
      expect(actions(run)).toContain("update CLAUDE.md");
      expect(await Bun.file(join(dir, "CLAUDE.md")).text()).toBe("@AGENTS.md\n");
      const agents = await Bun.file(join(dir, "AGENTS.md")).text();
      expect(agents.startsWith("# demo\n\n<!-- devkit:agents v1 -->")).toBe(true);
      expect(
        agents.endsWith(
          "<!-- /devkit:agents -->\n\n## Project\n\nDefault to using Bun.\n\n## APIs\n\n- Use Bun.file.\n",
        ),
      ).toBe(true);
      expect((await Bun.file(join(dir, "package.json")).json()).scripts.check).toBe(
        "bun run format:check && bun run lint && bun run typecheck && bun run check:knip",
      );
      await fakeLock(dir);
      expect((await init({ dir, dryRun: true })).changes.every((c) => c.action === "ok")).toBe(
        true,
      );
    }));

  test("a CLI with bin gets pack: true in its new CI stub, and sync keeps it", () =>
    withDir(async (dir) => {
      await gitRepo(dir);
      await writeJson(join(dir, "package.json"), { name: "demo", bin: { demo: "cli.ts" } });
      await init({ dir, install: false });
      await fakeLock(dir);
      const ci = await Bun.file(join(dir, ".github/workflows/ci.yml")).text();
      const build = (Bun.YAML.parse(ci) as { jobs: { build: { with: Record<string, unknown> } } })
        .jobs.build;
      expect(build.with).toEqual({ e2e: true, pack: true });
      expect((await init({ dir, dryRun: true })).changes.every((c) => c.action === "ok")).toBe(
        true,
      );
      expect(
        (await syncCheckout(syncRepo("bun"), dir, { adopt: false })).every(
          (c) => c.action === "ok",
        ),
      ).toBe(true);
    }));

  test("a project without a GitHub remote skips SECURITY.md until --repo is given", () =>
    withDir(async (dir) => {
      await writeJson(join(dir, "package.json"), { name: "demo" });
      const plain = await init({ dir, dryRun: true });
      expect(plain.changes.some((c) => c.path === "SECURITY.md")).toBe(false);
      expect(plain.notes.join("\n")).toContain("--repo owner/name");
      const named = await init({ dir, dryRun: true, repo: "someone/demo" });
      expect(named.repo).toBe("someone/demo");
      expect(named.changes.find((c) => c.path === "SECURITY.md")?.action).toBe("create");
    }));
});

describe("init: Python", () => {
  test("a fresh uv project gets the Python CI stub and no Knip", () =>
    withDir(async (dir) => {
      await gitRepo(dir, "git@github.com:someone/demo.git");
      await Bun.write(join(dir, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
      const run = await init({ dir });
      expect(run.profile).toBe("python");
      expect(actions(run)).not.toContain("create knip.json");
      expect(run.changes.some((c) => c.path === "package.json")).toBe(false);
      expect(await Bun.file(join(dir, ".github/workflows/ci.yml")).text()).toContain(
        "ci-python.yml@v1",
      );
      expect(
        (await syncCheckout(syncRepo("python"), dir, { adopt: false })).every(
          (c) => c.action === "ok",
        ),
      ).toBe(true);
    }));

  test("locks Knip in the root manifest even when a workspace already uses it", () =>
    withDir(async (dir) => {
      await writeJson(join(dir, "package.json"), { name: "demo" });
      await writeJson(join(dir, "bun.lock"), {
        workspaces: { "": {}, "tools/demo": { devDependencies: { knip: KNIP } } },
        packages: { knip: [] },
      });
      const dry = await init({ dir, dryRun: true });
      expect(actions(dry)).toContain("update bun.lock");
    }));

  test("recognizes a standard-library project from its existing Python workflow", () =>
    withDir(async (dir) => {
      const workflow =
        "jobs:\n  test:\n    uses: neoromantic/devkit/.github/workflows/ci-python.yml@v1\n";
      await Bun.write(join(dir, ".github/workflows/ci.yml"), workflow);
      const run = await init({ dir });
      expect(run.profile).toBe("python");
      expect(await Bun.file(join(dir, ".github/workflows/ci.yml")).text()).toBe(workflow);
    }));

  test("a Poetry project keeps its own CI", () =>
    withDir(async (dir) => {
      await Bun.write(
        join(dir, "pyproject.toml"),
        '[project]\nname = "demo"\n[project.urls]\nSource = "https://github.com/someone/demo"\n',
      );
      await Bun.write(join(dir, "poetry.lock"), "");
      const run = await init({ dir, dryRun: true });
      expect(run.repo).toBe("someone/demo");
      expect(run.changes.some((c) => c.path === ".github/workflows/ci.yml")).toBe(false);
    }));
});

describe("init: existing project", () => {
  test("keeps a managed Renovate preset and its project-specific settings", () =>
    withDir(async (dir) => {
      await writeJson(join(dir, "package.json"), { name: "demo" });
      const config = {
        description: "managed by devkit v1",
        extends: ["github>neoromantic/devkit//renovate/maintenance"],
        timezone: "UTC",
      };
      await writeJson(join(dir, "renovate.json"), config);
      await init({ dir, install: false });
      expect(await Bun.file(join(dir, "renovate.json")).json()).toEqual(config);
    }));

  test("keeps manual CI, other hooks, prior Knip settings, project rules and scripts", () =>
    withDir(async (dir) => {
      await gitRepo(dir);
      const pkg = {
        name: "demo",
        scripts: { lint: "eslint .", typecheck: "tsc --noEmit", test: "bun test" },
        devDependencies: { typescript: "5.0.0", knip: "^5.0.0" },
      };
      await Bun.write(join(dir, "package.json"), `${JSON.stringify(pkg, null, "\t")}\n`);
      await writeJson(join(dir, "bun.lock"), {
        workspaces: { "": { devDependencies: { knip: "^5.0.0" } } },
      });
      await Bun.write(join(dir, "knip.config.ts"), "export default {}\n");
      await mkdir(join(dir, ".github/workflows"), { recursive: true });
      await Bun.write(join(dir, ".github/workflows/test.yml"), "name: test\n");
      await mkdir(join(dir, ".husky"));
      await Bun.write(join(dir, ".husky/pre-commit"), "bun test\n");
      await Bun.write(join(dir, ".github/renovate.json"), "{}\n");
      await Bun.write(join(dir, "AGENTS.md"), "# demo\n\n## Project\n\nOur own rules.\n");
      await Bun.write(join(dir, "CLAUDE.md"), "@AGENTS.md\n");

      const run = await init({ dir, install: false });
      expect(run.changes.find((c) => c.path === ".github/workflows/ci.yml")?.action).toBe("skip");
      expect(run.changes.find((c) => c.path === "lefthook.yml")?.action).toBe("skip");
      expect(run.changes.find((c) => c.path === "renovate.json")?.action).toBe("skip");
      expect(run.changes.find((c) => c.path === "knip.config.ts")?.action).toBe("ok");
      expect(await Bun.file(join(dir, ".github/workflows/ci.yml")).exists()).toBe(false);
      expect(await Bun.file(join(dir, "lefthook.yml")).exists()).toBe(false);
      expect(await Bun.file(join(dir, "knip.json")).exists()).toBe(false);
      expect(await Bun.file(join(dir, ".github/workflows/test.yml")).text()).toBe("name: test\n");

      const text = await Bun.file(join(dir, "package.json")).text();
      expect(text.startsWith('{\n\t"name"')).toBe(true);
      const out = JSON.parse(text);
      const { knip: _, ...oxc } = TOOLS;
      expect(out.devDependencies).toEqual({ ...pkg.devDependencies, ...oxc });
      expect(out.scripts).toEqual({
        ...pkg.scripts,
        format: "oxfmt",
        "format:check": "oxfmt --check",
        "check:knip": "knip",
        check: "bun run format:check && bun run lint && bun run typecheck && bun run check:knip",
      });
      await writeJson(join(dir, "bun.lock"), {
        workspaces: { "": { devDependencies: out.devDependencies } },
      });

      const agents = await Bun.file(join(dir, "AGENTS.md")).text();
      expect(agents).toContain("<!-- devkit:agents v1 -->");
      expect(agents.endsWith("## Project\n\nOur own rules.\n")).toBe(true);
      const notes = run.notes.join("\n");
      expect(notes).toContain("Run `bun run check` in it");
      expect(notes).toContain("uses: neoromantic/devkit/.github/workflows/ci-bun.yml@v1");
      expect(notes).toContain("`lint` runs `eslint .`: switch it to `oxlint --deny-warnings`.");

      expect(
        (await init({ dir, dryRun: true })).changes.every(
          (c) => c.action === "ok" || c.action === "skip",
        ),
      ).toBe(true);
    }));

  test("refuses npm, pnpm and yarn projects before writing anything", () =>
    withDir(async (dir) => {
      await gitRepo(dir);
      await writeJson(join(dir, "package.json"), { name: "demo" });
      for (const [lock, pm] of [
        ["package-lock.json", "npm"],
        ["pnpm-lock.yaml", "pnpm"],
        ["yarn.lock", "yarn"],
      ]) {
        await Bun.write(join(dir, lock as string), "");
        const before = await snapshot(dir);
        await expect(init({ dir, install: false })).rejects.toThrow(`package.json uses ${pm}`);
        expect(await snapshot(dir)).toEqual(before);
        await rm(join(dir, lock as string));
      }
    }));

  test("adds CI next to release and docs workflows, but not next to an existing CI workflow", () =>
    withDir(async (dir) => {
      await gitRepo(dir);
      await writeJson(join(dir, "package.json"), { name: "demo" });
      await mkdir(join(dir, ".github/workflows"), { recursive: true });
      await Bun.write(
        join(dir, ".github/workflows/release.yml"),
        'on: { push: { tags: ["v*"] } }\n',
      );
      await Bun.write(join(dir, ".github/workflows/docs.yml"), "on: push\n");
      expect(
        (await init({ dir, dryRun: true })).changes.find(
          (c) => c.path === ".github/workflows/ci.yml",
        )?.action,
      ).toBe("create");
      await Bun.write(
        join(dir, ".github/workflows/main.yml"),
        "jobs: { t: { steps: [{ run: bun test }] } }\n",
      );
      const run = await init({ dir, dryRun: true });
      expect(run.changes.find((c) => c.path === ".github/workflows/ci.yml")).toEqual({
        path: ".github/workflows/ci.yml",
        action: "skip",
        note: "kept .github/workflows/main.yml",
      });
    }));

  test("asks for --profile when both manifests exist, and needs one", () =>
    withDir(async (dir) => {
      await expect(init({ dir, dryRun: true })).rejects.toThrow("bun init");
      await writeJson(join(dir, "package.json"), { name: "demo" });
      await Bun.write(join(dir, "pyproject.toml"), '[project]\nname = "demo"\n');
      await expect(init({ dir, dryRun: true })).rejects.toThrow("--profile");
      expect((await init({ dir, dryRun: true, profile: "python" })).profile).toBe("python");
    }));
});

describe("planKnip", () => {
  test("appends check:knip to an existing check and leaves a check that runs knip alone", () => {
    expect(planKnip({ scripts: { check: "tsc" } }, "1.0.0").pkg.scripts).toEqual({
      check: "tsc && bun run check:knip",
      "check:knip": "knip",
    });
    const done = { scripts: { check: "tsc && knip" }, devDependencies: { knip: "1.0.0" } };
    expect(planKnip(done, "2.0.0")).toEqual({ pkg: done, notes: [] });
  });
});

describe("planOxc", () => {
  const versions = { oxlint: "1.0.0", oxfmt: "0.1.0", "@interfere/landmines": "0.1.0" };

  test("puts the format check and lint first in an existing check", () => {
    const plan = planOxc({ scripts: { check: "tsc && bun run check:knip" } }, versions);
    expect(plan.pkg.scripts?.check).toBe(
      "bun run format:check && bun run lint && tsc && bun run check:knip",
    );
    expect(plan.advice).toEqual([]);
  });

  test("keeps scripts that use other tools, advises a switch and leaves them out of check", () => {
    const plan = planOxc(
      { scripts: { lint: "biome check .", format: "biome format --write .", check: "tsc" } },
      versions,
    );
    expect(plan.pkg.scripts).toEqual({
      lint: "biome check .",
      format: "biome format --write .",
      check: "tsc",
    });
    expect(plan.advice).toEqual([
      "`format` runs `biome format --write .`: switch it to `oxfmt`.",
      "`lint` runs `biome check .`: switch it to `oxlint --deny-warnings`.",
    ]);
  });

  test("changes nothing once the standard is in place", () => {
    const done = {
      scripts: {
        format: "oxfmt",
        "format:check": "oxfmt --check",
        lint: "oxlint --deny-warnings",
        check: "bun run format:check && bun run lint",
      },
      devDependencies: { ...versions },
    };
    expect(
      planOxc(done, { oxlint: "2.0.0", oxfmt: "0.2.0", "@interfere/landmines": "0.2.0" }),
    ).toEqual({ pkg: done, notes: [], advice: [] });
  });
});

describe("pack for Bun CLIs", () => {
  test("withPack adds one line to the rendered stub", async () => {
    const stub = render(
      await Bun.file(join(TEMPLATES_DIR, "ci.bun.yml")).text(),
      templateVars(syncRepo("bun")),
    );
    expect(withPack(stub)).toBe(
      stub.replace("      e2e: true\n", "      e2e: true\n      pack: true\n"),
    );
  });

  test("sync adds pack to a managed stub in a repo that declares bin", () =>
    withDir(async (dir) => {
      await writeJson(join(dir, "package.json"), { name: "demo" });
      await syncCheckout(syncRepo("bun"), dir, { adopt: false });
      await writeJson(join(dir, "package.json"), { name: "demo", bin: "cli.ts" });
      const changes = await syncCheckout(syncRepo("bun"), dir, { adopt: false });
      expect(changes.find((c) => c.path === ".github/workflows/ci.yml")?.action).toBe("update");
      expect(await Bun.file(join(dir, ".github/workflows/ci.yml")).text()).toContain(
        "      pack: true\n",
      );
    }));
});

describe("Knip baseline", () => {
  let knip = { exitCode: 0, stdout: "" };

  beforeAll(
    () =>
      withDir(async (dir) => {
        await writeJson(join(dir, "package.json"), {
          name: "demo",
          type: "module",
          dependencies: { "left-pad": "1.3.0" },
          devDependencies: { "is-odd": "3.0.1" },
        });
        await Bun.write(join(dir, "knip.json"), KNIP_CONFIG);
        await Bun.write(
          join(dir, "index.ts"),
          "import kebab from 'lodash-es/kebabCase'\nimport { a } from './missing'\nexport const publicApi = 1\nconsole.log(kebab, a)\n",
        );
        await Bun.write(join(dir, "orphan.ts"), "export const x = 1\n");
        const proc = Bun.spawnSync([KNIP_BIN, "--reporter", "json"], {
          cwd: dir,
          stdout: "pipe",
          stderr: "pipe",
        });
        knip = { exitCode: proc.exitCode, stdout: proc.stdout.toString() };
      }),
    60_000,
  );

  test("reports unused files and dependencies, unlisted and unresolved imports, but not exports", () => {
    expect(knip.exitCode).toBe(1);
    const found = new Set<string>();
    for (const issue of JSON.parse(knip.stdout).issues as Record<string, unknown>[]) {
      for (const type of KNIP_INCLUDE) {
        for (const item of (issue[type] as { name: string }[] | undefined) ?? [])
          found.add(`${type}:${item.name}`);
      }
      expect(issue.exports ?? []).toEqual([]);
    }
    expect([...found].sort()).toEqual([
      "dependencies:left-pad",
      "devDependencies:is-odd",
      "files:orphan.ts",
      "unlisted:lodash-es",
      "unresolved:./missing",
    ]);
  });
});

describe("cli", () => {
  test("devkit init --help", () => {
    const proc = Bun.spawnSync([process.execPath, join(ROOT, "scripts/cli.ts"), "init", "--help"], {
      stdout: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("usage: init");
  });
});
