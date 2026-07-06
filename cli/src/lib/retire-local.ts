import { spawn } from "child_process";
import { homedir } from "os";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

import { getDaemonPidPath, loadAllAssistants } from "./assistant-config.js";
import type { AssistantEntry } from "./assistant-config.js";
import { stopIngressNginx } from "./nginx-ingress.js";
import {
  stopOrphanedDaemonProcesses,
  stopProcessByPidFile,
} from "./process.js";
import { getArchivePath, getMetadataPath } from "./retire-archive.js";
import {
  consoleLifecycleReporter,
  type LifecycleReporter,
} from "./lifecycle-reporter.js";

export interface RetireLocalResult {
  assistantId: string;
  /** Whether the instance data directory was archived (false when skipped). */
  archived: boolean;
  /** Path to the background tar archive, when archiving was started. */
  archivePath?: string;
  /** True when another local assistant shared the data dir, so it was kept. */
  sharedDataDir?: boolean;
}

export async function retireLocal(
  name: string,
  entry: AssistantEntry,
  reporter: LifecycleReporter = consoleLifecycleReporter,
): Promise<RetireLocalResult> {
  reporter.log("\u{1F5D1}\ufe0f  Stopping local assistant...\n");

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
    reporter.log(
      `   Skipping process stop and archive — another local assistant shares ${vellumDir}.`,
    );
    reporter.log("\u2705 Local instance retired (config entry removed only).");
    return { assistantId: name, archived: false, sharedDataDir: true };
  }

  const daemonPidFile = getDaemonPidPath(resources);
  const daemonStopped = await stopProcessByPidFile(daemonPidFile, "daemon");

  // Stop gateway via PID file — use a longer timeout because the gateway has a
  // drain window (5s) before it exits.
  const gatewayPidFile = join(vellumDir, "gateway.pid");
  await stopProcessByPidFile(gatewayPidFile, "gateway", undefined, 7000);

  // Stop the CES sibling if one was launched (CES_STANDALONE). No-op when the
  // PID file is absent — on the default topology the assistant owns CES as an
  // stdio child and it exits with the daemon.
  const cesPidFile = join(vellumDir, "ces.pid");
  const cesStopped = await stopProcessByPidFile(
    cesPidFile,
    "credential-executor",
  );
  if (cesStopped) {
    reporter.log("credential-executor stopped.");
  }

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

  // Stop the nginx ingress if one is fronting this gateway — it would
  // otherwise be orphaned when the instance directory is archived.
  await stopIngressNginx(join(vellumDir, "workspace"));

  // If the PID file didn't track a running daemon, scan for orphaned
  // daemon processes that may have been started without writing a PID.
  if (!daemonStopped) {
    await stopOrphanedDaemonProcesses();
  }

  // For named instances (instanceDir differs from the base directory),
  // archive and remove the entire instance directory. For the default
  // instance, archive only the .vellum subdirectory.
  const isNamedInstance = resources.instanceDir !== homedir();
  const dirToArchive = isNamedInstance ? resources.instanceDir : vellumDir;

  // Move the data directory out of the way so the path is immediately available
  // for the next hatch, then kick off the tar archive in the background.
  const archivePath = getArchivePath(name);
  const metadataPath = getMetadataPath(name);
  const stagingDir = `${archivePath}.staging`;

  if (!existsSync(dirToArchive)) {
    reporter.log(
      `   No data directory at ${dirToArchive} — nothing to archive.`,
    );
    reporter.log("\u2705 Local instance retired.");
    return { assistantId: name, archived: false };
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

  // Spawn tar + cleanup in the background and detach so the CLI can exit
  // immediately. The staging directory is removed once the archive is written.
  const tarCmd = [
    `tar czf ${JSON.stringify(archivePath)} -C ${JSON.stringify(dirname(stagingDir))} ${JSON.stringify(basename(stagingDir))}`,
    `rm -rf ${JSON.stringify(stagingDir)}`,
  ].join(" && ");

  const child = spawn("sh", ["-c", tarCmd], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();

  reporter.log(`📦 Archiving to ${archivePath} in the background.`);
  reporter.log("\u2705 Local instance retired.");

  return { assistantId: name, archived: true, archivePath };
}
