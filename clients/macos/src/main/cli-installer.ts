import { app } from "electron";
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import log from "./logger";

// Empty by default: the happy path floats to the environment's dist-tag.
// Set by hand to pin the bundled CLI to an exact version.
export const PINNED_CLI_VERSION = "";

// Install dir for fresh, unpinned installs.
const LATEST_INSTALL_DIR = "latest";

// Injected by `electron.vite.config.ts` at build time.
declare const __VELLUM_ENVIRONMENT__: string;
const VELLUM_ENVIRONMENT =
  typeof __VELLUM_ENVIRONMENT__ === "string"
    ? __VELLUM_ENVIRONMENT__
    : "production";

/**
 * npm dist-tag the unpinned CLI install floats to. Dev and staging builds run
 * their own published CLI (`--tag dev` / `--tag staging`); everything else
 * tracks production `latest`. Keep in sync with generate-cli-lockfile.sh.
 */
function getCliDistTag(): string {
  if (VELLUM_ENVIRONMENT === "dev") return "dev";
  if (VELLUM_ENVIRONMENT === "staging") return "staging";
  return "latest";
}

// Baked by electron.vite.config.ts: the repo CLI entry for local builds,
// empty for release builds (and absent under bun test).
declare const __VELLUM_LOCAL_CLI_ENTRY__: string;
const LOCAL_CLI_ENTRY =
  typeof __VELLUM_LOCAL_CLI_ENTRY__ === "string"
    ? __VELLUM_LOCAL_CLI_ENTRY__
    : "";

// Baked by electron.vite.config.ts from .tool-versions: the version of the
// bundled bun. Empty outside a packaged build (e.g. under bun test).
declare const __VELLUM_BUN_VERSION__: string;
const BUNDLED_BUN_VERSION =
  typeof __VELLUM_BUN_VERSION__ === "string" ? __VELLUM_BUN_VERSION__ : "";

/**
 * Repo CLI entry for local builds, when the checkout is actually runnable:
 * the entry must exist and the CLI package's deps must be installed
 * (cli/node_modules is a standalone install, not hoisted). Otherwise local
 * builds fall back to the pinned install path.
 */
export function getLocalCliEntry(): string | null {
  if (LOCAL_CLI_ENTRY === "" || !existsSync(LOCAL_CLI_ENTRY)) return null;
  const cliRoot = path.resolve(path.dirname(LOCAL_CLI_ENTRY), "..");
  return existsSync(path.join(cliRoot, "node_modules"))
    ? LOCAL_CLI_ENTRY
    : null;
}

/** Root directory holding every CLI install: `<userData>/cli`. */
export function getCliRootDir(): string {
  return path.join(app.getPath("userData"), "cli");
}

/** The `vellum` bin path within an install directory. */
function binPathIn(dir: string): string {
  return path.join(dir, "node_modules", ".bin", "vellum");
}

/** Compare two version-like dir names numerically (so 0.10.0 > 0.9.0). */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Newest existing install under `cli/` whose `vellum` bin is present: prefer
 * `cli/latest`, otherwise the highest semver-named dir (including an old
 * pinned dir like `cli/0.9.0`). Returns `null` when nothing is installed.
 */
export function findExistingInstallDir(): string | null {
  const cliRoot = getCliRootDir();

  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = readdirSync(cliRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  const installed = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(binPathIn(path.join(cliRoot, name))));

  if (installed.length === 0) return null;

  if (installed.includes(LATEST_INSTALL_DIR)) {
    return path.join(cliRoot, LATEST_INSTALL_DIR);
  }

  const newest = installed.sort(compareVersions).at(-1)!;
  return path.join(cliRoot, newest);
}

/**
 * Directory where the CLI is (or will be) installed. When `PINNED_CLI_VERSION`
 * is set, the exact pinned dir; otherwise reuse any existing install, falling
 * back to `cli/latest` for a fresh install.
 */
export function getCliInstallDir(): string {
  const cliRoot = getCliRootDir();
  if (PINNED_CLI_VERSION) return path.join(cliRoot, PINNED_CLI_VERSION);
  return findExistingInstallDir() ?? path.join(cliRoot, LATEST_INSTALL_DIR);
}

/**
 * Rename an adopted version-named install dir (e.g. `cli/0.9.0`) to the
 * canonical `cli/latest` so its name reflects reality after an in-place float.
 *
 * Version-named dirs are only ever created by pinned builds. When a later
 * unpinned build adopts one and bumps its contents to a newer version in
 * place, the dir name goes stale (`cli/0.9.0` now holding 0.10.x) and the path
 * baked into the locator/wrapper misleads debugging (LUM-2648). Pinned builds
 * always install into a correctly-named dir, so this is a no-op for them.
 *
 * Non-fatal — failures are logged and leave the existing dir untouched.
 */
export function migrateStaleInstallDir(): void {
  if (PINNED_CLI_VERSION) return;

  const cliRoot = getCliRootDir();
  const latestDir = path.join(cliRoot, LATEST_INSTALL_DIR);
  if (existsSync(binPathIn(latestDir))) return; // already canonical

  const existing = findExistingInstallDir();
  if (existing === null || path.basename(existing) === LATEST_INSTALL_DIR) {
    return;
  }

  try {
    // Drop any partial `cli/latest` (dir without a bin) so the rename lands.
    rmSync(latestDir, { recursive: true, force: true });
    renameSync(existing, latestDir);
    log.info(
      `[cli-installer] renamed stale CLI install ${path.basename(existing)} -> ${LATEST_INSTALL_DIR}`,
    );
  } catch (err) {
    log.error("[cli-installer] failed to migrate stale CLI install dir:", err);
  }
}

/**
 * Absolute path of what the bundled bun should execute as the CLI: the repo
 * source entry in local builds, otherwise the installed `vellum` binary.
 * Everything downstream (invocation, locator, PATH wrapper) flows through
 * this, so local builds never touch the npm install path.
 */
export function getCliBinPath(): string {
  return getLocalCliEntry() ?? binPathIn(getCliInstallDir());
}

/** Absolute path to the bun runtime bundled inside the app resources. */
export function getBundledBunPath(): string {
  return path.join(process.resourcesPath, "bun");
}

/** Whether the CLI is already installed on disk. */
export function isCliInstalled(): boolean {
  return existsSync(getCliBinPath());
}

/** Path to the shell-sourceable locator file consumed by the PATH wrapper. */
export function getCliLocatorPath(): string {
  return path.join(getCliRootDir(), "locator.sh");
}

/** Single-quote a value for safe interpolation into a shell script. */
export function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Atomically write `content` via tmp-file + rename, optionally chmod'd. */
export function writeFileAtomicSync(
  filePath: string,
  content: string,
  mode?: number,
): void {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, content);
  if (mode !== undefined) chmodSync(tmpPath, mode);
  renameSync(tmpPath, filePath);
}

/**
 * Atomically write the locator file the `~/.local/bin/vellum` wrapper
 * sources to find the bundled bun and the current CLI bin. Refreshed on
 * every launch so app moves and version bumps self-heal. Non-fatal —
 * failures are logged but never block app startup.
 *
 * No-ops when the CLI bin isn't installed yet (e.g. first launch) so the
 * wrapper is never pointed at a missing binary.
 */
export function writeCliLocator(): void {
  // Heal a stale versioned install dir first so the locator points at the
  // canonical path rather than an old version-named one (LUM-2648).
  migrateStaleInstallDir();
  if (!isCliInstalled()) return;

  try {
    const locatorPath = getCliLocatorPath();
    mkdirSync(path.dirname(locatorPath), { recursive: true });

    const content =
      "# Written by Vellum.app on every launch. Do not edit.\n" +
      `VELLUM_BUN=${shQuote(getBundledBunPath())}\n` +
      `VELLUM_CLI_BIN=${shQuote(getCliBinPath())}\n`;

    writeFileAtomicSync(locatorPath, content);
  } catch (err) {
    log.error("[cli-installer] failed to write CLI locator:", err);
  }
}

function findNvmNodeBinDir(home: string): string[] {
  try {
    const nvmDir = process.env.NVM_DIR || path.join(home, ".nvm");
    const versionsDir = path.join(nvmDir, "versions", "node");
    for (const entry of readdirSync(versionsDir)) {
      if (!entry.startsWith("v")) continue;
      const binDir = path.join(versionsDir, entry, "bin");
      if (existsSync(path.join(binDir, "node"))) return [binDir];
    }
  } catch {
    // nvm not installed
  }
  return [];
}

export function buildInstallEnv(): NodeJS.ProcessEnv {
  const home = homedir();
  const basePath =
    process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  const pathParts = basePath.split(":");
  const extraDirs = [
    path.join(home, ".bun", "bin"),
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".volta", "bin"),
    ...findNvmNodeBinDir(home),
  ].filter((d) => !pathParts.includes(d));

  return {
    ...process.env,
    PATH: [...extraDirs, basePath].filter(Boolean).join(":"),
  };
}

/**
 * Seed the install directory with the package.json and bun.lock shipped in
 * the signed app bundle.  When present, the subsequent `bun install
 * --frozen-lockfile` uses the exact dependency graph that was resolved at
 * build time rather than resolving from the live registry.
 */
function seedCliLockfile(installDir: string): boolean {
  const seedDir = path.join(process.resourcesPath, "cli-lockfile");
  const seedPkg = path.join(seedDir, "package.json");
  const seedLock = path.join(seedDir, "bun.lock");

  if (!existsSync(seedPkg) || !existsSync(seedLock)) return false;

  copyFileSync(seedPkg, path.join(installDir, "package.json"));
  copyFileSync(seedLock, path.join(installDir, "bun.lock"));
  return true;
}

/**
 * Stamp `packageManager: bun@<version>` into the install dir's package.json to
 * mark the install bun-only. Both `bun add` and the seeded package.json omit
 * the field, so a manual `npm install` during recovery would silently drift the
 * install to a package-lock.json the bun loader ignores. No-op when the bun
 * version is unknown (non-packaged build) or already stamped. Non-fatal.
 */
function stampPackageManager(installDir: string): void {
  if (!BUNDLED_BUN_VERSION) return;

  const pkgPath = path.join(installDir, "package.json");
  const packageManager = `bun@${BUNDLED_BUN_VERSION}`;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.packageManager === packageManager) return;
    pkg.packageManager = packageManager;
    writeFileAtomicSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  } catch (err) {
    log.warn(
      "[cli-installer] failed to stamp packageManager into package.json:",
      err,
    );
  }
}

/** Spawn the bundled bun with `args` in `cwd` and await its exit. */
function runBun(args: string[], cwd: string): Promise<void> {
  const bunPath = getBundledBunPath();

  return new Promise<void>((resolve, reject) => {
    const child = spawn(bunPath, args, { cwd, env: buildInstallEnv() });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("error", (err: Error) => {
      reject(
        new Error(`Failed to spawn bun for package install: ${err.message}`),
      );
    });

    child.on("close", (code: number | null) => {
      if (code !== 0) {
        const detail = (stderr || stdout).trim();
        reject(
          new Error(
            `Package install failed with exit code ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}

async function bunInstallCli(): Promise<void> {
  const installDir = getCliInstallDir();
  mkdirSync(installDir, { recursive: true });

  // Recover from a corrupt prior install. When `node_modules` already exists
  // but no longer exposes the `vellum` bin — e.g. a partial tree left behind
  // by an app upgrade — `bun add` treats the lockfile as satisfied and exits
  // 0 without relinking the bin, so every relaunch repeats the same no-op and
  // the app stays wedged on "Failed to connect". Wipe the stale tree (and its
  // lockfile) so the install below re-extracts every package and recreates the
  // bin from scratch, exactly as a fresh install would.
  const nodeModulesDir = path.join(installDir, "node_modules");
  if (existsSync(nodeModulesDir) && !existsSync(binPathIn(installDir))) {
    log.warn(
      "[cli-installer] stale CLI node_modules without a vellum bin; reinstalling clean",
    );
    rmSync(nodeModulesDir, { recursive: true, force: true });
    rmSync(path.join(installDir, "bun.lock"), { force: true });
  }

  if (PINNED_CLI_VERSION) {
    // Pinned: prefer the seeded frozen lockfile, else resolve the exact version.
    const seeded = seedCliLockfile(installDir);
    const args = seeded
      ? ["install", "--frozen-lockfile", "--ignore-scripts"]
      : ["add", `vellum@${PINNED_CLI_VERSION}`, "--ignore-scripts"];
    await runBun(args, installDir);
  } else {
    // Unpinned: float to the environment's dist-tag, falling back to the seeded
    // frozen lockfile (resolved at build time) when the registry is unreachable.
    const spec = `vellum@${getCliDistTag()}`;
    try {
      await runBun(["add", spec, "--ignore-scripts"], installDir);
    } catch (err) {
      if (!seedCliLockfile(installDir)) throw err;
      log.warn(
        `[cli-installer] \`bun add ${spec}\` failed; falling back to seeded lockfile:`,
        err,
      );
      await runBun(
        ["install", "--frozen-lockfile", "--ignore-scripts"],
        installDir,
      );
    }
  }

  // Mark the freshly written install bun-only so manual recovery doesn't drift
  // it to npm. Both bun add and the seeded package.json omit the field.
  stampPackageManager(installDir);
}

// Singleton promise prevents concurrent installs from corrupting node_modules.
let cliInstallPromise: Promise<void> | null = null;

/** Reset the install lock. Exposed for testing only. */
export function _resetInstallLock(): void {
  cliInstallPromise = null;
}

/**
 * Install the vellum meta-package if it isn't already present.
 *
 * Packaged builds ship a pre-resolved lockfile so `bun install
 * --frozen-lockfile` pins the exact dependency graph from build time;
 * lifecycle scripts are always suppressed via `--ignore-scripts`.
 */
export async function ensureCliInstalled(): Promise<void> {
  if (isCliInstalled()) {
    writeCliLocator();
    // Heal installs written before this field existed (or before a bun bump):
    // the upgrade path returns here without reinstalling, so an existing user's
    // package.json would otherwise stay unmarked and exposed to npm drift
    // (LUM-2649). Skipped for local builds that run the repo CLI source.
    if (getLocalCliEntry() === null) stampPackageManager(getCliInstallDir());
    return;
  }

  // Clear the lock once the install settles (success or failure) so a later
  // call never short-circuits on a stale resolved promise — otherwise a bin
  // that goes missing mid-session wedges every retry until an app restart.
  if (!cliInstallPromise) {
    cliInstallPromise = (async () => {
      try {
        await bunInstallCli();
        writeCliLocator();
        cleanupOldVersions();
      } finally {
        cliInstallPromise = null;
      }
    })();
  }
  await cliInstallPromise;

  // Fail loudly on an exit-0 install that linked no bin, rather than letting
  // it surface downstream as a cryptic `bun run` "Module not found".
  if (!isCliInstalled()) {
    throw new Error(
      `CLI install reported success but no vellum binary was found at ${getCliBinPath()}.`,
    );
  }
}

/**
 * Remove CLI installs other than the one currently in use.
 *
 * Runs only after a fresh install, so an adopted existing install is never
 * touched. Non-fatal — cleanup errors are logged but never thrown so a stale
 * directory doesn't block the app from starting.
 */
export function cleanupOldVersions(): void {
  try {
    const cliRoot = getCliRootDir();
    const keep = path.basename(getCliInstallDir());
    const entries = readdirSync(cliRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === keep) continue;
      if (!entry.isDirectory()) continue;

      try {
        rmSync(path.join(cliRoot, entry.name), { recursive: true, force: true });
      } catch {
        // Individual entry cleanup failure is non-fatal.
      }
    }
  } catch {
    // The cli directory may not exist yet — that's fine.
  }
}
