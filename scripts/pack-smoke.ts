#!/usr/bin/env bun
// WARNING: import only Node builtins and Bun here: ci-bun.yml copies this one file out of devkit and runs it alone.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";

const TIMEOUT_MS = 120_000;
const WINDOWS = process.platform === "win32";
const KEEP = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "SYSTEMDRIVE",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
];
const INSTALL_ONLY = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
];

export type Run = { cmd: string[]; exitCode: number | null; output: string; timedOut: boolean };

export function parseArgs(raw: string | undefined) {
  if (!raw?.trim()) return [["--help"]];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      `pack args must be JSON, such as ["--version"] or [["--help"],["--version"]]: ${raw}`,
    );
  }
  const isArgv = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((a) => typeof a === "string");
  if (isArgv(value) && value.length > 0) return [value];
  if (Array.isArray(value) && value.length > 0 && value.every(isArgv)) return value as string[][];
  throw new Error(`pack args must be a non-empty argv list or list of argv lists: ${raw}`);
}

/** Bin names and paths from a package.json, as npm resolves them. */
export function binsOf(manifest: { name?: string; bin?: unknown }) {
  const { name = "", bin } = manifest;
  if (typeof bin === "string") return { [name.replace(/^@[^/]+\//, "")]: bin };
  if (bin && typeof bin === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(bin)) if (typeof v === "string") out[k] = v;
    return out;
  }
  return {};
}

function inside(child: string, parent: string) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function getEnv(name: string) {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : process.env[key];
}

/** An allowlisted environment: nothing from the job leaks in except locale, OS basics and PATH. */
export function cleanEnv(opts: { home: string; tmp: string; path: string[]; install?: boolean }) {
  const env: Record<string, string> = {};
  for (const name of opts.install ? [...KEEP, ...INSTALL_ONLY] : KEEP) {
    const value = getEnv(name);
    if (value !== undefined) env[name] = value;
  }
  Object.assign(env, {
    PATH: opts.path.join(delimiter),
    HOME: opts.home,
    USERPROFILE: opts.home,
    APPDATA: join(opts.home, "AppData", "Roaming"),
    LOCALAPPDATA: join(opts.home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(opts.home, ".config"),
    XDG_CACHE_HOME: join(opts.home, ".cache"),
    XDG_DATA_HOME: join(opts.home, ".local", "share"),
    TMPDIR: opts.tmp,
    TEMP: opts.tmp,
    TMP: opts.tmp,
    BUN_INSTALL_CACHE_DIR: join(opts.home, ".bun-cache"),
    NO_COLOR: "1",
  });
  return env;
}

async function run(cmd: string[], cwd: string, env?: Record<string, string>) {
  const proc = Bun.spawn(cmd, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return { cmd, exitCode: timedOut ? null : exitCode, output: (stdout + stderr).trim(), timedOut };
}

function show(r: Run, label: string) {
  const status = r.timedOut ? `timed out after ${TIMEOUT_MS / 1000}s` : `exit ${r.exitCode}`;
  console.log(`$ ${label}  (${status})`);
  const lines = r.output.split("\n");
  console.log(
    lines
      .slice(0, 40)
      .map((l) => `  ${l}`)
      .join("\n") + (lines.length > 40 ? `\n  … ${lines.length - 40} more lines` : ""),
  );
}

function binPath(binDir: string, name: string) {
  for (const candidate of WINDOWS ? [`${name}.exe`, name] : [name]) {
    const path = join(binDir, candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

export async function main(argv: string[]) {
  const pkgDir = realpathSync(resolve(argv[0] ?? process.env.DEVKIT_PACK_DIR ?? "."));
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const argSets = parseArgs(process.env.DEVKIT_PACK_ARGS);
  const workspace = process.env.GITHUB_WORKSPACE ? resolve(process.env.GITHUB_WORKSPACE) : null;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "devkit-pack-")));
  if (inside(root, pkgDir) || (workspace && inside(root, workspace))) {
    throw new Error(`temp dir ${root} is inside the checkout; set TMPDIR elsewhere`);
  }
  const failures: string[] = [];
  try {
    const [out, home, tmp, project, work] = ["out", "home", "tmp", "project", "work"].map((d) =>
      join(root, d),
    );
    for (const d of [out, home, tmp, project, work]) mkdirSync(d!, { recursive: true });

    const pack = await run(
      [process.execPath, "pm", "pack", "--destination", out!, "--quiet"],
      pkgDir,
    );
    show(pack, "bun pm pack");
    const tarballs = readdirSync(out!).filter((f) => f.endsWith(".tgz"));
    if (pack.exitCode !== 0 || tarballs.length !== 1)
      throw new Error(`bun pm pack failed or wrote ${tarballs.length} tarballs`);
    const tarball = join(out!, tarballs[0]!);
    console.log(`packed ${tarball}`);

    const binDir = join(project!, "node_modules", ".bin");
    const systemPath = (getEnv("PATH") ?? "")
      .split(delimiter)
      .filter(
        (p) =>
          p &&
          isAbsolute(p) &&
          !inside(resolve(p), pkgDir) &&
          !(workspace && inside(resolve(p), workspace)),
      );
    const path = [binDir, dirname(process.execPath), ...systemPath];
    const installEnv = cleanEnv({ home: home!, tmp: tmp!, path, install: true });
    const runEnv = cleanEnv({ home: home!, tmp: tmp!, path });

    const name = manifest.name ?? "unnamed";
    await Bun.write(
      join(project!, "package.json"),
      JSON.stringify(
        {
          name: "devkit-pack-smoke",
          private: true,
          dependencies: { [name]: `file:${tarball}` },
        },
        null,
        2,
      ),
    );
    const install = await run([process.execPath, "install", "--no-progress"], project!, installEnv);
    show(install, "bun install");
    if (install.exitCode !== 0) throw new Error("installing the tarball failed");

    const installedDir = join(project!, "node_modules", ...name.split("/"));
    const installed = JSON.parse(readFileSync(join(installedDir, "package.json"), "utf8"));
    const bins = binsOf(installed);
    if (Object.keys(bins).length === 0) throw new Error("package.json has no bin to run");

    for (const [bin, target] of Object.entries(bins)) {
      if (!existsSync(join(installedDir, target))) {
        failures.push(
          `bin ${bin}: ${target} is missing from the tarball (check "files" and the build)`,
        );
        continue;
      }
      const exe = binPath(binDir, bin);
      if (!exe) {
        failures.push(`bin ${bin}: install did not link it into node_modules/.bin`);
        continue;
      }
      for (const args of argSets) {
        const r = await run([exe, ...args], work!, runEnv);
        show(r, `${bin} ${JSON.stringify(args)}`);
        if (r.exitCode !== 0)
          failures.push(
            `${bin} ${JSON.stringify(args)}: ${r.timedOut ? "timed out" : `exit ${r.exitCode}`}`,
          );
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
  for (const f of failures) console.error(`pack-smoke: ${f}`);
  if (failures.length === 0) console.log("pack-smoke: ok");
  return failures.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (err) {
    console.error(`pack-smoke: ${(err as Error).message}`);
    process.exit(2);
  }
}
