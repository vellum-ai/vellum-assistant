import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";

// Direct import — bun embeds this at compile time so it works in compiled binaries.
import cliPkg from "../../package.json";

import { buildOpenclawStartupScript } from "../adapters/openclaw";
import {
  allocateLocalResources,
  findAssistantByName,
  loadAllAssistants,
  saveAssistantEntry,
  setActiveAssistant,
  syncConfigToLockfile,
} from "../lib/assistant-config";
import type {
  AssistantEntry,
  LocalInstanceResources,
} from "../lib/assistant-config";
import { hatchAws } from "../lib/aws";
import {
  SPECIES_CONFIG,
  VALID_REMOTE_HOSTS,
  VALID_SPECIES,
} from "../lib/constants";
import type { RemoteHost, Species } from "../lib/constants";
import { hatchDocker } from "../lib/docker";
import { hatchGcp } from "../lib/gcp";
import type { PollResult, WatchHatchingResult } from "../lib/gcp";
import { buildNestedConfig, writeInitialConfig } from "../lib/config-utils";
import {
  startLocalDaemon,
  startGateway,
  stopLocalProcesses,
} from "../lib/local";
import { maybeStartNgrokTunnel } from "../lib/ngrok";
import { getPlatformUrl } from "../lib/platform-client";
import { httpHealthCheck } from "../lib/http-client";
import { detectOrphanedProcesses } from "../lib/orphan-detection";
import { isProcessAlive, stopProcess } from "../lib/process";
import { generateInstanceName } from "../lib/random-name";
import { validateAssistantName } from "../lib/retire-archive";
import { leaseGuardianToken } from "../lib/guardian-token";
import { archiveLogFile, resetLogFile } from "../lib/xdg-log";

export type { PollResult, WatchHatchingResult } from "../lib/gcp";

const INSTALL_SCRIPT_REMOTE_PATH = "/tmp/vellum-install.sh";

const HATCH_TIMEOUT_MS: Record<Species, number> = {
  vellum: 2 * 60 * 1000,
  openclaw: 10 * 60 * 1000,
};
const DEFAULT_SPECIES: Species = "vellum";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const IS_DESKTOP = !!process.env.VELLUM_DESKTOP_APP;

function desktopLog(msg: string): void {
  process.stdout.write(msg + "\n");
}

function buildTimestampRedirect(logPath: string): string {
  return `exec > >(while IFS= read -r line; do printf '[%s] %s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$line"; done > ${logPath}) 2>&1`;
}

function buildUserSetup(sshUser: string): string {
  return `
SSH_USER="${sshUser}"
if ! id "$SSH_USER" &>/dev/null; then
  useradd -m -s /bin/bash "$SSH_USER"
fi
SSH_USER_HOME=$(eval echo "~$SSH_USER")
mkdir -p "$SSH_USER_HOME"
export HOME="$SSH_USER_HOME"
`;
}

function buildOwnershipFixup(): string {
  return `
chown -R "$SSH_USER:$SSH_USER" "$SSH_USER_HOME" 2>/dev/null || true
`;
}

export async function buildStartupScript(
  species: Species,
  sshUser: string,
  providerApiKeys: Record<string, string>,
  instanceName: string,
  cloud: RemoteHost,
  configValues: Record<string, string> = {},
): Promise<string> {
  const platformUrl = getPlatformUrl();
  const logPath =
    cloud === "custom"
      ? "/tmp/vellum-startup.log"
      : "/var/log/startup-script.log";
  const errorPath =
    cloud === "custom" ? "/tmp/vellum-startup-error" : "/var/log/startup-error";
  const timestampRedirect = buildTimestampRedirect(logPath);
  const userSetup = buildUserSetup(sshUser);
  const ownershipFixup = buildOwnershipFixup();

  if (species === "openclaw") {
    return await buildOpenclawStartupScript(
      sshUser,
      providerApiKeys,
      timestampRedirect,
      userSetup,
      ownershipFixup,
    );
  }

  // Build bash lines that set each provider API key as a shell variable
  // and corresponding dotenv lines for the env file.
  const envSetLines = Object.entries(providerApiKeys)
    .map(([envVar, value]) => `${envVar}=${value}`)
    .join("\n");
  const dotenvLines = Object.keys(providerApiKeys)
    .map((envVar) => `${envVar}=\$${envVar}`)
    .join("\n");

  // Write --config key=value pairs to a temp JSON file on the remote host
  // and export the env var so the daemon reads it on first boot.
  let configWriteBlock = "";
  if (Object.keys(configValues).length > 0) {
    const configJson = JSON.stringify(buildNestedConfig(configValues), null, 2);
    configWriteBlock = `
echo "Writing default workspace config..."
VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH="/tmp/vellum-initial-config-$$.json"
cat > "\$VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH" << 'VELLUM_CONFIG_EOF'
${configJson}
VELLUM_CONFIG_EOF
export VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH
echo "Default workspace config written to \$VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH"
`;
  }

  return `#!/bin/bash
set -e

${timestampRedirect}

trap 'EXIT_CODE=\$?; if [ \$EXIT_CODE -ne 0 ]; then echo "Startup script failed with exit code \$EXIT_CODE at line \$LINENO" > ${errorPath}; echo "Last 20 log lines:" >> ${errorPath}; tail -20 ${logPath} >> ${errorPath} 2>/dev/null || true; fi' EXIT
${userSetup}
${envSetLines}
VELLUM_ASSISTANT_NAME=${instanceName}
mkdir -p "\$HOME/.config/vellum"
cat > "\$HOME/.config/vellum/env" << DOTENV_EOF
${dotenvLines}
RUNTIME_HTTP_PORT=7821
DOTENV_EOF

${ownershipFixup}
${configWriteBlock}
export VELLUM_SSH_USER="\$SSH_USER"
export VELLUM_ASSISTANT_NAME="\$VELLUM_ASSISTANT_NAME"
echo "Downloading install script from ${platformUrl}/install.sh..."
curl -fsSL ${platformUrl}/install.sh -o ${INSTALL_SCRIPT_REMOTE_PATH}
echo "Install script downloaded (\$(wc -c < ${INSTALL_SCRIPT_REMOTE_PATH}) bytes)"
chmod +x ${INSTALL_SCRIPT_REMOTE_PATH}
echo "Running install script..."
source ${INSTALL_SCRIPT_REMOTE_PATH}
`;
}

const DEFAULT_REMOTE: RemoteHost = "local";

interface HatchArgs {
  species: Species;
  detached: boolean;
  keepAlive: boolean;
  name: string | null;
  remote: RemoteHost;
  restart: boolean;
  watch: boolean;
  configValues: Record<string, string>;
}

function parseArgs(): HatchArgs {
  const args = process.argv.slice(3);
  let species: Species = DEFAULT_SPECIES;
  let detached = false;
  let keepAlive = false;
  let name: string | null = null;
  let remote: RemoteHost = DEFAULT_REMOTE;
  let restart = false;
  let watch = false;
  const configValues: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: vellum hatch [species] [options]");
      console.log("");
      console.log("Create a new assistant instance.");
      console.log("");
      console.log("Species:");
      console.log("  vellum       Default assistant (default)");
      console.log("  openclaw     OpenClaw adapter");
      console.log("");
      console.log("Options:");
      console.log("  -d                        Run in detached mode");
      console.log("  --name <name>             Custom instance name");
      console.log(
        "  --remote <host>           Remote host (local, gcp, aws, docker, custom)",
      );
      console.log(
        "  --restart                 Restart processes without onboarding side effects",
      );
      console.log(
        "  --watch                   Run assistant and gateway in watch mode (hot reload on source changes)",
      );
      console.log(
        "  --keep-alive              Stay alive after hatch, exit when gateway stops",
      );
      console.log(
        "  --config <key=value>      Set a workspace config value (repeatable)",
      );
      process.exit(0);
    } else if (arg === "-d") {
      detached = true;
    } else if (arg === "--restart") {
      restart = true;
    } else if (arg === "--watch") {
      watch = true;
    } else if (arg === "--keep-alive") {
      keepAlive = true;
    } else if (arg === "--name") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --name requires a value");
        process.exit(1);
      }
      try {
        validateAssistantName(next);
      } catch {
        console.error(
          `Error: --name contains invalid characters (path separators or traversal segments are not allowed)`,
        );
        process.exit(1);
      }
      name = next;
      i++;
    } else if (arg === "--remote") {
      const next = args[i + 1];
      if (!next || !VALID_REMOTE_HOSTS.includes(next as RemoteHost)) {
        console.error(
          `Error: --remote requires one of: ${VALID_REMOTE_HOSTS.join(", ")}`,
        );
        process.exit(1);
      }
      remote = next as RemoteHost;
      i++;
    } else if (arg === "--config") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --config requires a key=value argument");
        process.exit(1);
      }
      const eqIndex = next.indexOf("=");
      if (eqIndex <= 0) {
        console.error(
          `Error: --config value must be in key=value format, got '${next}'`,
        );
        process.exit(1);
      }
      const key = next.slice(0, eqIndex);
      const value = next.slice(eqIndex + 1);
      configValues[key] = value;
      i++;
    } else if (VALID_SPECIES.includes(arg as Species)) {
      species = arg as Species;
    } else {
      console.error(
        `Error: Unknown argument '${arg}'. Valid options: ${VALID_SPECIES.join(", ")}, -d, --restart, --watch, --keep-alive, --name <name>, --remote <${VALID_REMOTE_HOSTS.join("|")}>, --config <key=value>`,
      );
      process.exit(1);
    }
  }

  return {
    species,
    detached,
    keepAlive,
    name,
    remote,
    restart,
    watch,
    configValues,
  };
}

function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s.toString().padStart(2, "0")}s` : `${s}s`;
}

function pickMessage(messages: string[], elapsedMs: number): string {
  const idx = Math.floor(elapsedMs / 15000) % messages.length;
  return messages[idx];
}

function getPhaseIcon(
  hasLogs: boolean,
  elapsedMs: number,
  species: Species,
): string {
  if (!hasLogs) {
    return elapsedMs < 30000 ? "🥚" : "🪺";
  }
  return elapsedMs < 120000 ? "🐣" : SPECIES_CONFIG[species].hatchedEmoji;
}

export async function watchHatching(
  pollFn: () => Promise<PollResult>,
  instanceName: string,
  startTime: number,
  species: Species,
): Promise<WatchHatchingResult> {
  if (IS_DESKTOP) {
    return watchHatchingDesktop(pollFn, instanceName, startTime, species);
  }

  let spinnerIdx = 0;
  let lastLogLine: string | null = null;
  let linesDrawn = 0;
  let finished = false;
  let failed = false;
  let lastErrorContent = "";
  let pollInFlight = false;
  let nextPollAt = Date.now() + 15000;

  function draw(): void {
    if (linesDrawn > 0) {
      process.stdout.write(`\x1b[${linesDrawn}A`);
    }

    const elapsed = Date.now() - startTime;

    const hasLogs = lastLogLine !== null;
    const icon = finished
      ? failed
        ? "💀"
        : SPECIES_CONFIG[species].hatchedEmoji
      : getPhaseIcon(hasLogs, elapsed, species);
    const spinner = finished
      ? failed
        ? "✘"
        : "✔"
      : SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length];
    const config = SPECIES_CONFIG[species];
    const message = finished
      ? failed
        ? "❌ Startup script failed"
        : "✨ Your assistant has hatched!"
      : hasLogs
        ? lastLogLine!.length > 68
          ? lastLogLine!.substring(0, 65) + "..."
          : lastLogLine!
        : pickMessage(config.waitingMessages, elapsed);
    spinnerIdx++;

    const lines = [
      "",
      `   ${icon} ${spinner}  ${message}  ⏱  ${formatElapsed(elapsed)}`,
      "",
    ];

    for (const line of lines) {
      process.stdout.write(`\x1b[K${line}\n`);
    }
    linesDrawn = lines.length;
  }

  async function poll(): Promise<void> {
    if (pollInFlight || finished) return;
    pollInFlight = true;
    try {
      const result = await pollFn();
      if (result.lastLine) {
        lastLogLine = result.lastLine;
      }
      if (result.errorContent) {
        lastErrorContent = result.errorContent;
      }
      if (result.done) {
        finished = true;
        failed = result.failed;
      }
    } finally {
      pollInFlight = false;
      nextPollAt = Date.now() + 5000;
    }
  }

  return new Promise<WatchHatchingResult>((resolve) => {
    const interval = setInterval(() => {
      if (finished) {
        draw();
        clearInterval(interval);
        resolve({ success: !failed, errorContent: lastErrorContent });
        return;
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= HATCH_TIMEOUT_MS[species]) {
        clearInterval(interval);
        console.log("");
        console.log(
          `   ⏰ Timed out after ${formatElapsed(elapsed)}. Instance is still running.`,
        );
        console.log(`   Monitor with: vel logs ${instanceName}`);
        console.log("");
        resolve({ success: false, errorContent: lastErrorContent });
        return;
      }

      if (Date.now() >= nextPollAt) {
        poll();
      }

      draw();
    }, 80);

    process.on("SIGINT", () => {
      clearInterval(interval);
      console.log("");
      console.log(`   ⚠️  Detaching. Instance is still running.`);
      console.log(`   Monitor with: vel logs ${instanceName}`);
      console.log("");
      process.exit(0);
    });
  });
}

function watchHatchingDesktop(
  pollFn: () => Promise<PollResult>,
  instanceName: string,
  startTime: number,
  species: Species,
): Promise<WatchHatchingResult> {
  return new Promise<WatchHatchingResult>((resolve) => {
    let prevLogLine: string | null = null;
    let lastErrorContent = "";
    let pollInFlight = false;
    let nextPollAt = Date.now() + 15000;

    desktopLog("Waiting for instance to start...");

    const interval = setInterval(async () => {
      const elapsed = Date.now() - startTime;

      if (elapsed >= HATCH_TIMEOUT_MS[species]) {
        clearInterval(interval);
        desktopLog(
          `Timed out after ${formatElapsed(elapsed)}. Instance is still running.`,
        );
        desktopLog(`Monitor with: vel logs ${instanceName}`);
        resolve({ success: false, errorContent: lastErrorContent });
        return;
      }

      if (Date.now() < nextPollAt || pollInFlight) return;

      pollInFlight = true;
      try {
        const result = await pollFn();

        if (result.lastLine && result.lastLine !== prevLogLine) {
          prevLogLine = result.lastLine;
          desktopLog(result.lastLine);
        }

        if (result.errorContent) {
          lastErrorContent = result.errorContent;
        }

        if (result.done) {
          clearInterval(interval);
          if (result.failed) {
            desktopLog("Startup script failed");
          } else {
            desktopLog("Your assistant has hatched!");
          }
          resolve({ success: !result.failed, errorContent: lastErrorContent });
        }
      } finally {
        pollInFlight = false;
        nextPollAt = Date.now() + 5000;
      }
    }, 5000);

    process.on("SIGINT", () => {
      clearInterval(interval);
      desktopLog("Detaching. Instance is still running.");
      desktopLog(`Monitor with: vel logs ${instanceName}`);
      process.exit(0);
    });
  });
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

async function hatchLocal(
  species: Species,
  name: string | null,
  restart: boolean = false,
  watch: boolean = false,
  keepAlive: boolean = false,
  configValues: Record<string, string> = {},
): Promise<void> {
  if (restart && !name && !process.env.VELLUM_ASSISTANT_NAME) {
    console.error(
      "Error: Cannot restart without a known assistant ID. Provide --name or ensure VELLUM_ASSISTANT_NAME is set.",
    );
    process.exit(1);
  }

  const instanceName = generateInstanceName(
    species,
    name ?? process.env.VELLUM_ASSISTANT_NAME,
  );

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

  const initialConfigPath = writeInitialConfig(configValues);

  await startLocalDaemon(watch, resources, { initialConfigPath });

  let runtimeUrl = `http://127.0.0.1:${resources.gatewayPort}`;
  try {
    runtimeUrl = await startGateway(watch, resources);
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
  // instead of hitting /v1/guardian/init itself.
  try {
    await leaseGuardianToken(runtimeUrl, instanceName);
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
    serviceGroupVersion: cliPkg.version ? `v${cliPkg.version}` : undefined,
    resources,
  };
  if (!restart) {
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
  }

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

function getCliVersion(): string {
  return cliPkg.version ?? "unknown";
}

export async function hatch(): Promise<void> {
  const cliVersion = getCliVersion();
  console.log(`@vellumai/cli v${cliVersion}`);

  const {
    species,
    detached,
    keepAlive,
    name,
    remote,
    restart,
    watch,
    configValues,
  } = parseArgs();

  if (restart && remote !== "local") {
    console.error(
      "Error: --restart is only supported for local hatch targets.",
    );
    process.exit(1);
  }

  if (watch && remote !== "local" && remote !== "docker") {
    console.error(
      "Error: --watch is only supported for local and docker hatch targets.",
    );
    process.exit(1);
  }

  if (remote === "local") {
    await hatchLocal(species, name, restart, watch, keepAlive, configValues);
    return;
  }

  if (remote === "gcp") {
    await hatchGcp(
      species,
      detached,
      name,
      buildStartupScript,
      watchHatching,
      configValues,
    );
    return;
  }

  if (remote === "aws") {
    await hatchAws(species, detached, name, configValues);
    return;
  }

  if (remote === "docker") {
    await hatchDocker(species, detached, name, watch, configValues);
    return;
  }

  console.error(`Error: Remote host '${remote}' is not yet supported.`);
  process.exit(1);
}
