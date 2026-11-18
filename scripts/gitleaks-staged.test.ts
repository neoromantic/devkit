import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./gitleaks-staged";
import { main as oxcStaged } from "./oxc-staged";

function git(dir: string, ...args: string[]) {
  const proc = Bun.spawnSync(["git", ...args], { cwd: dir, stderr: "pipe" });
  expect(proc.exitCode).toBe(0);
  return proc.stdout.toString();
}

const token = () => ["ghp", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");

async function repo(born: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "devkit-gitleaks-test-"));
  git(dir, "init", "--quiet");
  git(dir, "config", "user.email", "dev@example.com");
  git(dir, "config", "user.name", "dev");
  git(dir, "config", "color.ui", "always");
  await Bun.write(join(dir, ".devkit-exclude"), "# private\ndata/private\n");
  if (born) {
    await Bun.write(join(dir, "README.md"), "demo\n");
    git(dir, "add", ".");
    git(dir, "commit", "--quiet", "-m", "init");
  }
  await mkdir(join(dir, "data", "private"), { recursive: true });
  await Bun.write(join(dir, "data", "private", "a.txt"), `token = "${token()}"\n`);
  git(dir, "add", "-f", ".");
  return dir;
}

const hasGitleaks = Bun.which("gitleaks") !== null;
const results = { born: [] as number[], unborn: [] as number[], oxc: 0, index: "" };

beforeAll(async () => {
  for (const born of [true, false]) {
    const dir = await repo(born);
    const codes = [];
    if (hasGitleaks) codes.push(main([], dir));
    await Bun.write(join(dir, "src.txt"), `token = "${token()}"\n`);
    git(dir, "add", "src.txt");
    if (hasGitleaks) codes.push(main([], dir));
    results[born ? "born" : "unborn"] = codes;
    if (born) {
      results.oxc = oxcStaged([], dir);
      results.index = git(dir, "diff", "--cached", "--name-only");
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

describe("gitleaks-staged", () => {
  test.skipIf(!hasGitleaks)("never scans excluded paths and still finds the rest", () => {
    expect(results.born).toEqual([0, 1]);
    expect(results.unborn).toEqual([0, 1]);
  });

  test("leaves the real index alone", () => {
    expect(results.index).toBe("data/private/a.txt\nsrc.txt\n");
  });

  test("oxc-staged does nothing for excluded paths", () => {
    expect(results.oxc).toBe(0);
  });
});
