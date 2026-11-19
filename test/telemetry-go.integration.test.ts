import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isManaged, render } from "../scripts/lib/managed";

const root = join(import.meta.dir, "..");
const template = join(root, "templates/telemetry/telemetry.go");
const go = Bun.which("go");
if (!go) console.warn("telemetry-go: skipping the Go client tests, `go` is not installed");

function goMinor(cmd: string[]) {
  const out = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" }).stdout.toString();
  return Number(/go1\.(\d+)/.exec(out)?.[1] ?? 0);
}

let staticcheck = Bun.which("staticcheck");
if (go && staticcheck && goMinor(["go", "version", staticcheck]) < goMinor(["go", "version"])) {
  console.warn("telemetry-go: skipping staticcheck, it was built with an older Go; reinstall it");
  staticcheck = null;
}

test("telemetry.go renders unchanged and carries the managed mark", async () => {
  const text = await Bun.file(template).text();
  expect(render(text, {})).toBe(text);
  expect(isManaged(text.split("\n")[0] ?? "")).toBe(true);
});

const GOOS = ["linux", "darwin", "windows"];

describe.skipIf(!go)("telemetry.go with the Go toolchain", () => {
  let dir = "";
  const results = new Map<string, { code: number; output: string }>();

  function run(cmd: string[], env: Record<string, string> = {}) {
    const p = Bun.spawnSync(cmd, {
      cwd: dir,
      env: { ...process.env, GOWORK: "off", GOFLAGS: "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: p.exitCode, output: `${p.stdout.toString()}${p.stderr.toString()}`.trim() };
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "devkit-telemetry-go-"));
    await copyFile(template, join(dir, "telemetry.go"));
    for (const name of ["go.mod", "telemetry_test.go"]) {
      await copyFile(join(root, "test/telemetry/go", name), join(dir, name));
    }
    results.set("go test", run(["go", "test", "-count=1", "./..."]));
    for (const goos of GOOS)
      results.set(`go vet ${goos}`, run(["go", "vet", "./..."], { GOOS: goos }));
    results.set("gofmt", run(["gofmt", "-l", "."]));
    if (staticcheck) results.set("staticcheck", run(["staticcheck", "./..."]));
  }, 600_000);
  afterAll(() => rm(dir, { recursive: true, force: true }));

  test("go test", () => {
    const r = results.get("go test");
    expect(r?.code, r?.output).toBe(0);
  });

  for (const goos of GOOS) {
    test(`go vet for ${goos}`, () => {
      const r = results.get(`go vet ${goos}`);
      expect(r?.code, r?.output).toBe(0);
    });
  }

  test("gofmt -l lists nothing", () => {
    expect(results.get("gofmt")).toEqual({ code: 0, output: "" });
  });

  test.skipIf(!staticcheck)("staticcheck, when installed", () => {
    const r = results.get("staticcheck");
    expect(r?.code, r?.output).toBe(0);
  });
});
