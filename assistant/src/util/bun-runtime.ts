/**
 * Shared helper for locating or JIT-installing a standalone `bun` binary.
 *
 * Several subsystems (package resolver, hook runner, browser runtime,
 * credential execution, embedding runtime) need to spawn `bun` as a child
 * process. Inside a `bun build --compile` binary, `process.execPath` is the
 * compiled app — not the bun CLI — and the user may not have bun on PATH.
 *
 * This module checks well-known locations first, and if none is found it
 * downloads a pinned release from GitHub into $VELLUM_WORKSPACE_DIR/bin/.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, homedir, platform } from "node:os";
import { basename, join } from "node:path";

import { getLogger } from "./logger.js";
import { getBinDir } from "./platform.js";

const log = getLogger("bun-runtime");

/** Pinned bun version to download when no system bun is available. */
const BUN_VERSION = "1.2.0";

/** Module-level cache so we only resolve/download once per process. */
let cachedBunPath: string | undefined;

/**
 * Return a path to a usable `bun` binary, downloading one if necessary.
 *
 * Resolution order:
 * 1. `process.execPath` if it IS the bun CLI (dev mode)
 * 2. Previously downloaded copy at $VELLUM_WORKSPACE_DIR/bin/bun
 * 3. Common install locations (~/.bun/bin/bun, /opt/homebrew/bin/bun, etc.)
 * 4. `Bun.which("bun")` (PATH lookup)
 * 5. Download from GitHub releases into $VELLUM_WORKSPACE_DIR/bin/
 */
export async function ensureBun(): Promise<string> {
  if (cachedBunPath && existsSync(cachedBunPath)) {
    return cachedBunPath;
  }

  const found = findBun();
  if (found) {
    cachedBunPath = found;
    return found;
  }

  // No bun found anywhere — download it
  log.info("No bun binary found, downloading…");
  const binDir = getBinDir();
  const downloaded = await downloadBun(binDir);
  cachedBunPath = downloaded;
  return downloaded;
}

/**
 * Synchronous check for an already-available bun binary.
 * Returns the path if found, undefined otherwise. Does NOT download.
 */
export function findBun(): string | undefined {
  // 1. process.execPath if it is the bun CLI itself (dev mode)
  const execBase = basename(process.execPath);
  if (execBase === "bun" || execBase === "bun.exe") {
    return process.execPath;
  }

  // 2. Previously downloaded copy
  const downloaded = join(getBinDir(), "bun");
  if (existsSync(downloaded)) return downloaded;

  // 3. Common install locations
  const home = homedir();
  for (const p of [
    join(home, ".bun", "bin", "bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ]) {
    if (existsSync(p)) return p;
  }

  // 4. PATH lookup
  const which = Bun.which("bun");
  if (which) return which;

  return undefined;
}

/**
 * Download a pinned bun release into the given directory.
 * Returns the absolute path to the downloaded binary.
 */
async function downloadBun(installDir: string): Promise<string> {
  const os = platform();
  const cpu = arch() === "arm64" ? "aarch64" : arch();
  const target = `${os}-${cpu}`;
  const url = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-${target}.zip`;

  log.info({ url, target, bunVersion: BUN_VERSION }, "Downloading bun binary");

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(
      `Failed to download bun: ${response.status} ${response.statusText}`,
    );
  }

  const zipData = await response.arrayBuffer();
  mkdirSync(installDir, { recursive: true });

  const tmpZip = join(installDir, `bun-download-${Date.now()}.zip`);
  writeFileSync(tmpZip, Buffer.from(zipData));

  try {
    const proc = Bun.spawn({
      cmd: ["unzip", "-o", tmpZip, "-d", installDir],
      stdout: "ignore",
      stderr: "pipe",
    });
    await proc.exited;
    if (proc.exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Failed to extract bun zip: ${stderr}`);
    }

    // Move binary from bun-{target}/bun to installDir/bun
    const extractedBun = join(installDir, `bun-${target}`, "bun");
    const finalPath = join(installDir, "bun");
    if (existsSync(extractedBun)) {
      // Remove old binary first to avoid "Text file busy" on some systems
      if (existsSync(finalPath)) {
        rmSync(finalPath);
      }
      renameSync(extractedBun, finalPath);
      rmSync(join(installDir, `bun-${target}`), {
        recursive: true,
        force: true,
      });
    }

    chmodSync(finalPath, 0o755);

    log.info({ path: finalPath }, "Bun binary downloaded successfully");
    return finalPath;
  } finally {
    try {
      rmSync(tmpZip);
    } catch {
      /* ignore cleanup failure */
    }
  }
}
