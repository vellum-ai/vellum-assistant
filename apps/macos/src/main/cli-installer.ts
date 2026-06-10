import { app } from "electron";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Auto-stamped by create-release-branch workflow.
export const PINNED_CLI_VERSION = "0.8.10";

/** Directory where the pinned CLI version is installed. */
export function getCliInstallDir(): string {
  return path.join(app.getPath("userData"), "cli", PINNED_CLI_VERSION);
}

/** Absolute path to the installed `vellum` binary. */
export function getCliBinPath(): string {
  return path.join(getCliInstallDir(), "node_modules", ".bin", "vellum");
}

/** Absolute path to the bun runtime bundled inside the app resources. */
export function getBundledBunPath(): string {
  return path.join(process.resourcesPath, "bun");
}

/** Whether the pinned CLI version is already installed on disk. */
export function isCliInstalled(): boolean {
  return existsSync(getCliBinPath());
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
  if (isCliInstalled()) return;

  if (cliInstallPromise) return cliInstallPromise;

  cliInstallPromise = (async () => {
    await bunInstallCli();
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
