import { spawn } from "child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

import {
  findAssistantByName,
  getBaseDir,
  loadAllAssistants,
  removeAssistantEntry,
} from "../lib/assistant-config";
import type { AssistantEntry } from "../lib/assistant-config";
import {
  fetchOrganizationId,
  getPlatformUrl,
  readPlatformToken,
} from "../lib/platform-client";
import { retireInstance as retireAwsInstance } from "../lib/aws";
import { retireDocker } from "../lib/docker";
import { retireInstance as retireGcpInstance } from "../lib/gcp";
import {
  stopOrphanedDaemonProcesses,
  stopProcessByPidFile,
} from "../lib/process";
import { getArchivePath, getMetadataPath } from "../lib/retire-archive";
import { exec } from "../lib/step-runner";
import {
  openLogFile,
  closeLogFile,
  resetLogFile,
  writeToLogFile,
} from "../lib/xdg-log";

function resolveCloud(entry: AssistantEntry): string {
  if (entry.cloud) {
    return entry.cloud;
  }
  if (entry.project) {
    return "gcp";
  }
  if (entry.sshUser) {
    return "custom";
  }
  return "local";
}

function extractHostFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return url.replace(/^https?:\/\//, "").split(":")[0];
  }
}

async function retireLocal(name: string, entry: AssistantEntry): Promise<void> {
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
  // instance, archive only the .vellum subdirectory.
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

  console.log(`📦 Archiving to ${archivePath} in the background.`);
  console.log("\u2705 Local instance retired.");
}

async function retireCustom(entry: AssistantEntry): Promise<void> {
  const host = extractHostFromUrl(entry.runtimeUrl);
  const sshUser = entry.sshUser ?? "root";
  const sshHost = `${sshUser}@${host}`;

  console.log(`\u{1F5D1}\ufe0f  Retiring custom instance on ${sshHost}...\n`);

  const remoteCmd = [
    "bunx vellum sleep 2>/dev/null || true",
    "pkill -f gateway 2>/dev/null || true",
    "rm -rf ~/.vellum",
  ].join(" && ");

  try {
    await exec("ssh", [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "LogLevel=ERROR",
      sshHost,
      remoteCmd,
    ]);
  } catch (error) {
    console.warn(
      `\u26a0\ufe0f  Remote cleanup may have partially failed: ${error instanceof Error ? error.message : error}`,
    );
  }

  console.log(`\u2705 Custom instance retired.`);
}

async function retireVellum(assistantId: string): Promise<void> {
  console.log("\u{1F5D1}\ufe0f  Retiring platform-hosted instance...\n");

  const token = readPlatformToken();
  if (!token) {
    console.error(
      "Error: Not logged in. Run `vellum login --token <token>` first.",
    );
    process.exit(1);
  }

  const orgId = await fetchOrganizationId(token);

  const url = `${getPlatformUrl()}/v1/assistants/${encodeURIComponent(assistantId)}/retire/`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      "X-Session-Token": token,
      "Vellum-Organization-Id": orgId,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(
      `Error: Platform retire failed (${response.status}): ${body}`,
    );
    process.exit(1);
  }

  console.log("\u2705 Platform-hosted instance retired.");
}

function parseSource(): string | undefined {
  const args = process.argv.slice(4);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source" && args[i + 1]) {
      return args[i + 1];
    }
  }
  return undefined;
}

/** Patch console methods to also append output to the given log file descriptor. */
function teeConsoleToLogFile(fd: number | "ignore"): void {
  if (fd === "ignore") return;

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  const timestamp = () => new Date().toISOString();

  console.log = (...args: unknown[]) => {
    origLog(...args);
    writeToLogFile(fd, `[${timestamp()}] ${args.map(String).join(" ")}\n`);
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    writeToLogFile(
      fd,
      `[${timestamp()}] WARN: ${args.map(String).join(" ")}\n`,
    );
  };
  console.error = (...args: unknown[]) => {
    origError(...args);
    writeToLogFile(
      fd,
      `[${timestamp()}] ERROR: ${args.map(String).join(" ")}\n`,
    );
  };
}

export async function retire(): Promise<void> {
  if (process.env.VELLUM_DESKTOP_APP) {
    resetLogFile("retire.log");
  }
  const logFd = process.env.VELLUM_DESKTOP_APP
    ? openLogFile("retire.log")
    : "ignore";
  teeConsoleToLogFile(logFd);

  try {
    await retireInner();
  } finally {
    closeLogFile(logFd);
  }
}

async function retireInner(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum retire <name> [--source <source>]");
    console.log("");
    console.log("Delete an assistant instance and archive its data.");
    console.log("");
    console.log("Arguments:");
    console.log("  <name>               Name of the assistant to retire");
    console.log("");
    console.log("Options:");
    console.log("  --source <source>    Source identifier for the retirement");
    process.exit(0);
  }

  const name = process.argv[3];

  if (!name) {
    console.error("Error: Instance name is required.");
    console.error("Usage: vellum retire <name> [--source <source>]");
    process.exit(1);
  }

  const entry = findAssistantByName(name);
  if (!entry) {
    console.error(`No assistant found with name '${name}'.`);
    console.error("Run 'vellum hatch' first, or check the instance name.");
    process.exit(1);
  }

  const source = parseSource();
  const cloud = resolveCloud(entry);

  if (cloud === "gcp") {
    const project = entry.project;
    const zone = entry.zone;
    if (!project || !zone) {
      console.error(
        "Error: GCP project and zone not found in assistant config.",
      );
      process.exit(1);
    }
    await retireGcpInstance(name, project, zone, source);
  } else if (cloud === "aws") {
    const region = entry.region;
    if (!region) {
      console.error("Error: AWS region not found in assistant config.");
      process.exit(1);
    }
    await retireAwsInstance(name, region, source);
  } else if (cloud === "docker") {
    await retireDocker(name);
  } else if (cloud === "local") {
    await retireLocal(name, entry);
  } else if (cloud === "custom") {
    await retireCustom(entry);
  } else if (cloud === "vellum") {
    await retireVellum(entry.assistantId);
  } else {
    console.error(`Error: Unknown cloud type '${cloud}'.`);
    process.exit(1);
  }

  removeAssistantEntry(name);
  console.log(`Removed ${name} from config.`);
}
