import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";

// Direct import — bun embeds this at compile time so it works in compiled binaries.
import cliPkg from "../../package.json";

import {
  allocateLocalResources,
  findAssistantByName,
  loadAllAssistants,
  saveAssistantEntry,
  setActiveAssistant,
  syncConfigToLockfile,
} from "./assistant-config.js";
import type {
  AssistantEntry,
  LocalInstanceResources,
} from "./assistant-config.js";
import type { Species } from "./constants.js";
import { writeInitialConfig } from "./config-utils.js";
import {
  generateLocalSigningKey,
  startLocalDaemon,
  startGateway,
  stopLocalProcesses,
} from "./local.js";
import { maybeStartNgrokTunnel } from "./ngrok.js";
import { httpHealthCheck } from "./http-client.js";
import { detectOrphanedProcesses } from "./orphan-detection.js";
import { isProcessAlive, stopProcess } from "./process.js";
import { generateInstanceName } from "./random-name.js";
import { leaseGuardianToken } from "./guardian-token.js";
import { archiveLogFile, resetLogFile } from "./xdg-log.js";
import { emitProgress } from "./desktop-progress.js";

const IS_DESKTOP = !!process.env.VELLUM_DESKTOP_APP;

function desktopLog(msg: string): void {
  process.stdout.write(msg + "\n");
}

/**
 * Attempts to place a symlink at the given path pointing to cliBinary.
 * Returns true if the symlink was created (or already correct), false on failure.
 */
function trySymlink(cliBinary: string, symlinkPath: string): boolean {
  try {
    // Use lstatSync (not existsSync) to detect dangling symlinks —
    // existsSync follows symlinks and returns false for broken links.
    try {
      const stats = lstatSync(symlinkPath);
      if (!stats.isSymbolicLink()) {
        // Real file — don't overwrite (developer's local install)
        return false;
      }
      // Already a symlink — skip if it already points to our binary
      const dest = readlinkSync(symlinkPath);
      if (dest === cliBinary) return true;
      // Stale or dangling symlink — remove before creating new one
      unlinkSync(symlinkPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") return false;
      // Path doesn't exist — proceed to create symlink
    }

    const dir = join(symlinkPath, "..");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    symlinkSync(cliBinary, symlinkPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures ~/.local/bin is present in the user's shell profile so that
 * symlinks placed there are on PATH in new terminal sessions.
 */
function ensureLocalBinInShellProfile(localBinDir: string): void {
  const shell = process.env.SHELL ?? "";
  const home = homedir();
  // Determine the appropriate shell profile to modify
  const profilePath = shell.endsWith("/zsh")
    ? join(home, ".zshrc")
    : shell.endsWith("/bash")
      ? join(home, ".bash_profile")
      : null;
  if (!profilePath) return;

  try {
    const contents = existsSync(profilePath)
      ? readFileSync(profilePath, "utf-8")
      : "";
    // Check if ~/.local/bin is already referenced in PATH exports
    if (contents.includes(localBinDir)) return;
    const line = `\nexport PATH="${localBinDir}:\$PATH"\n`;
    appendFileSync(profilePath, line);
    console.log(`   Added ${localBinDir} to ${profilePath}`);
  } catch {
    // Not critical — user can add it manually
  }
}

function installCLISymlink(): void {
  const cliBinary = process.execPath;
  if (!cliBinary || !existsSync(cliBinary)) return;

  // Preferred location — works on most Macs where /usr/local/bin exists
  const preferredPath = "/usr/local/bin/vellum";
  if (trySymlink(cliBinary, preferredPath)) {
    console.log(`   Symlinked ${preferredPath} → ${cliBinary}`);
    return;
  }

  // Fallback — use ~/.local/bin which is user-writable and doesn't need root.
  // On some Macs /usr/local doesn't exist and creating it requires admin privileges.
  const localBinDir = join(homedir(), ".local", "bin");
  const fallbackPath = join(localBinDir, "vellum");
  if (trySymlink(cliBinary, fallbackPath)) {
    console.log(`   Symlinked ${fallbackPath} → ${cliBinary}`);
    ensureLocalBinInShellProfile(localBinDir);
    return;
  }

  console.log(
    `   ⚠ Could not create symlink for vellum CLI (tried ${preferredPath} and ${fallbackPath})`,
  );
}

export async function hatchLocal(
  species: Species,
  name: string | null,
  watch: boolean = false,
  keepAlive: boolean = false,
  configValues: Record<string, string> = {},
): Promise<void> {
  const instanceName = generateInstanceName(
    species,
    name ?? process.env.VELLUM_ASSISTANT_NAME,
  );

  emitProgress(1, 7, "Preparing workspace...");

  // Clean up stale local state: if daemon/gateway processes are running but
  // the lock file has no entries AND the daemon is not healthy, stop them
  // before starting fresh. A healthy daemon should be reused, not killed —
  // it may have been started intentionally via `vellum wake`.
  const vellumDir = join(homedir(), ".vellum");
  const existingAssistants = loadAllAssistants();
  const localAssistants = existingAssistants.filter((a) => a.cloud === "local");
  if (localAssistants.length === 0) {
    const daemonPid = isProcessAlive(join(vellumDir, "vellum.pid"));
    const gatewayPid = isProcessAlive(join(vellumDir, "gateway.pid"));
    if (daemonPid.alive || gatewayPid.alive) {
      // Check if the daemon is actually healthy before killing it.
      // Default port 7821 is used when there's no lockfile entry.
      const defaultPort = parseInt(process.env.RUNTIME_HTTP_PORT || "7821", 10);
      const healthy = await httpHealthCheck(defaultPort);
      if (!healthy) {
        console.log(
          "🧹 Cleaning up stale local processes (no lock file entry)...\n",
        );
        await stopLocalProcesses();
      }
    }
  }

  // On desktop, scan the process table for orphaned vellum processes that
  // are not tracked by any PID file or lock file entry and kill them before
  // starting new ones. This prevents resource leaks when the desktop app
  // crashes or is force-quit without a clean shutdown.
  //
  // Skip orphan cleanup if the daemon is already healthy on the expected port
  // — those processes are intentional (e.g. started via `vellum wake`) and
  // startLocalDaemon() will reuse them.
  if (IS_DESKTOP) {
    const existingResources = findAssistantByName(instanceName);
    const expectedPort =
      existingResources?.cloud === "local" && existingResources.resources
        ? existingResources.resources.daemonPort
        : undefined;
    const daemonAlreadyHealthy = expectedPort
      ? await httpHealthCheck(expectedPort)
      : false;

    if (!daemonAlreadyHealthy) {
      const orphans = await detectOrphanedProcesses();
      if (orphans.length > 0) {
        desktopLog(
          `🧹 Found ${orphans.length} orphaned process${orphans.length === 1 ? "" : "es"} — cleaning up...`,
        );
        for (const orphan of orphans) {
          await stopProcess(
            parseInt(orphan.pid, 10),
            `${orphan.name} (PID ${orphan.pid})`,
          );
        }
      }
    }
  }

  emitProgress(2, 7, "Allocating resources...");

  // Reuse existing resources if re-hatching with --name that matches a known
  // local assistant, otherwise allocate fresh per-instance ports and directories.
  let resources: LocalInstanceResources;
  const existingEntry = findAssistantByName(instanceName);
  if (existingEntry?.cloud === "local" && existingEntry.resources) {
    resources = existingEntry.resources;
  } else {
    resources = await allocateLocalResources(instanceName);
  }

  // Clean up stale workspace data: if the workspace directory already exists for
  // this instance but no local lockfile entry owns it, a previous retire failed
  // to archive it (or a managed-only retire left local data behind). Remove the
  // workspace subtree so the new assistant starts fresh — but preserve the rest
  // of .vellum (e.g. protected/, credentials) which may be shared.
  if (
    !existingEntry ||
    (existingEntry.cloud != null && existingEntry.cloud !== "local")
  ) {
    const instanceWorkspaceDir = join(
      resources.instanceDir,
      ".vellum",
      "workspace",
    );
    if (existsSync(instanceWorkspaceDir)) {
      const ownedByOther = loadAllAssistants().some((a) => {
        if ((a.cloud != null && a.cloud !== "local") || !a.resources)
          return false;
        return (
          join(a.resources.instanceDir, ".vellum", "workspace") ===
          instanceWorkspaceDir
        );
      });
      if (!ownedByOther) {
        console.log(
          `🧹 Removing stale workspace at ${instanceWorkspaceDir} (not owned by any assistant)...\n`,
        );
        rmSync(instanceWorkspaceDir, { recursive: true, force: true });
      }
    }
  }

  const logsDir = join(
    resources.instanceDir,
    ".vellum",
    "workspace",
    "data",
    "logs",
  );
  archiveLogFile("hatch.log", logsDir);
  resetLogFile("hatch.log");

  console.log(`🥚 Hatching local assistant: ${instanceName}`);
  console.log(`   Species: ${species}`);
  console.log("");

  if (!process.env.APP_VERSION) {
    process.env.APP_VERSION = cliPkg.version;
  }

  emitProgress(3, 7, "Writing configuration...");
  const defaultWorkspaceConfigPath = writeInitialConfig(configValues);

  emitProgress(4, 7, "Starting assistant...");
  const signingKey = generateLocalSigningKey();
  await startLocalDaemon(watch, resources, {
    defaultWorkspaceConfigPath,
    signingKey,
  });

  emitProgress(5, 7, "Starting gateway...");
  let runtimeUrl = `http://127.0.0.1:${resources.gatewayPort}`;
  try {
    runtimeUrl = await startGateway(watch, resources, { signingKey });
  } catch (error) {
    // Gateway failed — stop the daemon we just started so we don't leave
    // orphaned processes with no lock file entry.
    console.error(
      `\n❌ Gateway startup failed — stopping assistant to avoid orphaned processes.`,
    );
    await stopLocalProcesses(resources);
    throw error;
  }

  // Lease a guardian token so the desktop app can import it on first launch
  // instead of hitting /v1/guardian/init itself. Use loopback to satisfy
  // the daemon's local-only check — the mDNS runtimeUrl resolves to a LAN
  // IP which the daemon rejects as non-loopback.
  emitProgress(6, 7, "Securing connection...");
  const loopbackUrl = `http://127.0.0.1:${resources.gatewayPort}`;
  try {
    await leaseGuardianToken(loopbackUrl, instanceName);
  } catch (err) {
    console.error(`⚠️  Guardian token lease failed: ${err}`);
  }

  // Auto-start ngrok if webhook integrations (e.g. Telegram, Twilio) are configured.
  // Set BASE_DATA_DIR so ngrok reads the correct instance config.
  const prevBaseDataDir = process.env.BASE_DATA_DIR;
  process.env.BASE_DATA_DIR = resources.instanceDir;
  const ngrokChild = await maybeStartNgrokTunnel(resources.gatewayPort);
  if (ngrokChild?.pid) {
    const ngrokPidFile = join(resources.instanceDir, ".vellum", "ngrok.pid");
    writeFileSync(ngrokPidFile, String(ngrokChild.pid));
  }
  if (prevBaseDataDir !== undefined) {
    process.env.BASE_DATA_DIR = prevBaseDataDir;
  } else {
    delete process.env.BASE_DATA_DIR;
  }

  const localEntry: AssistantEntry = {
    assistantId: instanceName,
    runtimeUrl,
    localUrl: `http://127.0.0.1:${resources.gatewayPort}`,
    cloud: "local",
    species,
    hatchedAt: new Date().toISOString(),
    resources: { ...resources, signingKey },
  };
  emitProgress(7, 7, "Saving configuration...");
  saveAssistantEntry(localEntry);
  setActiveAssistant(instanceName);
  syncConfigToLockfile();

  if (process.env.VELLUM_DESKTOP_APP) {
    installCLISymlink();
  }

  console.log("");
  console.log(`✅ Local assistant hatched!`);
  console.log("");
  console.log("Instance details:");
  console.log(`  Name: ${instanceName}`);
  console.log(`  Runtime: ${runtimeUrl}`);
  console.log("");

  if (keepAlive) {
    const healthUrl = `http://127.0.0.1:${resources.gatewayPort}/healthz`;
    const healthTarget = "Gateway";
    const POLL_INTERVAL_MS = 5000;
    const MAX_FAILURES = 3;
    let consecutiveFailures = 0;

    const shutdown = async (): Promise<void> => {
      console.log("\nShutting down local processes...");
      await stopLocalProcesses(resources);
      process.exit(0);
    };

    process.on("SIGTERM", () => void shutdown());
    process.on("SIGINT", () => void shutdown());

    // Poll the health endpoint until it stops responding.
    while (true) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      try {
        const res = await fetch(healthUrl, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          consecutiveFailures = 0;
        } else {
          consecutiveFailures++;
        }
      } catch {
        consecutiveFailures++;
      }
      if (consecutiveFailures >= MAX_FAILURES) {
        console.log(
          `\n⚠️  ${healthTarget} stopped responding — shutting down.`,
        );
        await stopLocalProcesses(resources);
        process.exit(1);
      }
    }
  }
}
