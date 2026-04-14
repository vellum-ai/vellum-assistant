import { spawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { getBaseDir, loadAllAssistants } from "./assistant-config.js";
import type { AssistantEntry } from "./assistant-config.js";
import {
  stopOrphanedDaemonProcesses,
  stopProcessByPidFile,
} from "./process.js";
import { getArchivePath, getMetadataPath } from "./retire-archive.js";

export async function retireLocal(
  name: string,
  entry: AssistantEntry,
  opts: { backgroundArchive?: boolean } = {},
): Promise<void> {
  // Production path runs tar in a detached child so the CLI can exit
  // immediately. Tests override this to get a synchronous archive so they
  // can assert on archive contents right after the call returns.
  const backgroundArchive = opts.backgroundArchive ?? true;
  console.log("\u{1F5D1}\ufe0f  Stopping local assistant...\n");

  if (!entry.resources) {
    throw new Error(
      `Local assistant '${name}' is missing resource configuration. Re-hatch to fix.`,
    );
  }
  const resources = entry.resources;
  const vellumDir = join(resources.instanceDir, ".vellum");

  // Check whether another local assistant shares the same data directory.
  const otherSharesDir = loadAllAssistants().some((other) => {
    if (other.cloud !== "local") return false;
    if (other.assistantId === name) return false;
    if (!other.resources) return false;
    const otherVellumDir = join(other.resources.instanceDir, ".vellum");
    return otherVellumDir === vellumDir;
  });

  if (otherSharesDir) {
    console.log(
      `   Skipping process stop and archive — another local assistant shares ${vellumDir}.`,
    );
    console.log("\u2705 Local instance retired (config entry removed only).");
    return;
  }

  const daemonPidFile = resources.pidFile;
  const daemonStopped = await stopProcessByPidFile(daemonPidFile, "daemon");

  // Stop gateway via PID file — use a longer timeout because the gateway has a
  // drain window (5s) before it exits.
  const gatewayPidFile = join(vellumDir, "gateway.pid");
  await stopProcessByPidFile(gatewayPidFile, "gateway", undefined, 7000);

  // Stop Qdrant — the daemon's graceful shutdown tries to stop it via
  // qdrantManager.stop(), but if the daemon was SIGKILL'd (after 2s timeout)
  // Qdrant may still be running as an orphan. Check both the current PID file
  // location and the legacy location.
  const qdrantPidFile = join(
    vellumDir,
    "workspace",
    "data",
    "qdrant",
    "qdrant.pid",
  );
  const qdrantLegacyPidFile = join(vellumDir, "qdrant.pid");
  await stopProcessByPidFile(qdrantPidFile, "qdrant", undefined, 5000);
  await stopProcessByPidFile(qdrantLegacyPidFile, "qdrant", undefined, 5000);

  // If the PID file didn't track a running daemon, scan for orphaned
  // daemon processes that may have been started without writing a PID.
  if (!daemonStopped) {
    await stopOrphanedDaemonProcesses();
  }

  // For named instances (instanceDir differs from the base directory),
  // archive and remove the entire instance directory. For the default
  // instance, archive only the .vellum subdirectory. The "default" branch
  // is a backwards-compat path for pre env-data-layout first-local entries
  // whose instanceDir is still homedir() (or BASE_DATA_DIR under test).
  // All new hatches go through the named-instance path.
  const isNamedInstance = resources.instanceDir !== getBaseDir();
  const dirToArchive = isNamedInstance ? resources.instanceDir : vellumDir;

  // Move the data directory out of the way so the path is immediately available
  // for the next hatch, then kick off the tar archive in the background.
  const archivePath = getArchivePath(name);
  const metadataPath = getMetadataPath(name);
  const stagingDir = `${archivePath}.staging`;

  if (!existsSync(dirToArchive)) {
    console.log(
      `   No data directory at ${dirToArchive} — nothing to archive.`,
    );
    console.log("\u2705 Local instance retired.");
    return;
  }

  // Ensure the retired archive directory exists before attempting the rename
  mkdirSync(dirname(stagingDir), { recursive: true });

  try {
    renameSync(dirToArchive, stagingDir);
  } catch (err) {
    // Re-throw so the caller (and the desktop app) knows the archive failed.
    // If the rename fails, old workspace data stays in place and a subsequent
    // hatch would inherit stale SOUL.md, IDENTITY.md, and memories.
    throw new Error(
      `Failed to archive ${dirToArchive}: ${err instanceof Error ? err.message : err}`,
    );
  }

  writeFileSync(metadataPath, JSON.stringify(entry, null, 2) + "\n");

  createArchive({ archivePath, stagingDir, background: backgroundArchive });

  if (backgroundArchive) {
    console.log(`📦 Archiving to ${archivePath} in the background.`);
  } else {
    console.log(`📦 Archived to ${archivePath}.`);
  }
  console.log("\u2705 Local instance retired.");
}

/**
 * Archive the CONTENTS of `stagingDir` (not the directory itself) into
 * `archivePath`, then delete `stagingDir`. The `-C <stagingDir> .` form tells
 * tar to change into the staging dir and archive the current directory's
 * contents — the archive's root-level entries will be the files and subdirs
 * that were originally inside the instance's data dir, with no wrapper
 * directory. `recover.ts` relies on this shape so it can extract directly
 * into the entry's target directory.
 *
 * When `background` is true (production path), the tar + cleanup runs in a
 * detached child process so the CLI can exit immediately. When false (test
 * path), the work runs synchronously so tests can assert on the archive
 * existing right after `retireLocal` returns.
 */
export function createArchive(opts: {
  archivePath: string;
  stagingDir: string;
  background: boolean;
}): void {
  const { archivePath, stagingDir, background } = opts;
  if (background) {
    const tarCmd = [
      `tar czf ${JSON.stringify(archivePath)} -C ${JSON.stringify(stagingDir)} .`,
      `rm -rf ${JSON.stringify(stagingDir)}`,
    ].join(" && ");
    const child = spawn("sh", ["-c", tarCmd], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    return;
  }
  const result = spawnSync("tar", ["czf", archivePath, "-C", stagingDir, "."], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `tar exited with code ${result.status} while archiving ${stagingDir}`,
    );
  }
  rmSync(stagingDir, { recursive: true, force: true });
}
