import { app } from "electron";
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import log from "./logger";

// Auto-stamped by create-release-branch workflow.
export const PINNED_CLI_VERSION = "0.8.12";

// Baked by electron.vite.config.ts: the repo CLI entry for local builds,
// empty for release builds (and absent under bun test).
declare const __VELLUM_LOCAL_CLI_ENTRY__: string;
const LOCAL_CLI_ENTRY =
  typeof __VELLUM_LOCAL_CLI_ENTRY__ === "string"
    ? __VELLUM_LOCAL_CLI_ENTRY__
    : "";

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

/** Directory where the pinned CLI version is installed. */
export function getCliInstallDir(): string {
  return path.join(app.getPath("userData"), "cli", PINNED_CLI_VERSION);
}

/**
 * Absolute path of what the bundled bun should execute as the CLI: the repo
 * source entry in local builds, otherwise the installed `vellum` binary.
 * Everything downstream (invocation, locator, PATH wrapper) flows through
 * this, so local builds never touch the npm install path.
 */
export function getCliBinPath(): string {
  return (
    getLocalCliEntry() ??
    path.join(getCliInstallDir(), "node_modules", ".bin", "vellum")
  );
}

/** Absolute path to the bun runtime bundled inside the app resources. */
export function getBundledBunPath(): string {
  return path.join(process.resourcesPath, "bun");
}

/** Whether the pinned CLI version is already installed on disk. */
export function isCliInstalled(): boolean {
  return existsSync(getCliBinPath());
}

/** Path to the shell-sourceable locator file consumed by the PATH wrapper. */
export function getCliLocatorPath(): string {
  return path.join(app.getPath("userData"), "cli", "locator.sh");
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
 * No-ops when the pinned CLI bin isn't installed yet (e.g. first launch
 * after a version bump) so the wrapper is never pointed at a missing binary.
 */
export function writeCliLocator(): void {
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

function bunInstallCli(): Promise<void> {
  const installDir = getCliInstallDir();
  mkdirSync(installDir, { recursive: true });

  const bunPath = getBundledBunPath();
  const seeded = seedCliLockfile(installDir);

  const args = seeded
    ? ["install", "--frozen-lockfile", "--ignore-scripts"]
    : ["add", `vellum@${PINNED_CLI_VERSION}`, "--ignore-scripts"];

  return new Promise<void>((resolve, reject) => {
    const child = spawn(bunPath, args, {
      cwd: installDir,
      env: buildInstallEnv(),
    });

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
        new Error(
          `Failed to spawn bun for package install: ${err.message}`,
        ),
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

// Singleton promise prevents concurrent installs from corrupting node_modules.
let cliInstallPromise: Promise<void> | null = null;

/** Reset the install lock. Exposed for testing only. */
export function _resetInstallLock(): void {
  cliInstallPromise = null;
}

/**
 * Install the pinned vellum meta-package if it isn't already present.
 *
 * Packaged builds ship a pre-resolved lockfile so `bun install
 * --frozen-lockfile` pins the exact dependency graph from build time;
 * lifecycle scripts are always suppressed via `--ignore-scripts`.
 */
export async function ensureCliInstalled(): Promise<void> {
  if (isCliInstalled()) {
    writeCliLocator();
    return;
  }

  if (cliInstallPromise) return cliInstallPromise;

  cliInstallPromise = (async () => {
    await bunInstallCli();
    writeCliLocator();
    cleanupOldVersions();
  })();

  try {
    await cliInstallPromise;
  } catch (err) {
    cliInstallPromise = null;
    throw err;
  }
}

/**
 * Remove CLI versions other than the currently pinned one.
 *
 * Non-fatal — cleanup errors are logged but never thrown so a stale
 * directory doesn't block the app from starting.
 */
export function cleanupOldVersions(): void {
  try {
    const cliRoot = path.join(app.getPath("userData"), "cli");
    const entries = readdirSync(cliRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === PINNED_CLI_VERSION) continue;
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
