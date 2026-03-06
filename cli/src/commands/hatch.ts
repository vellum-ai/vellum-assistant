import { createHash, randomBytes, randomUUID } from "crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir, hostname, userInfo } from "os";
import { join } from "path";

import QRCode from "qrcode";
import qrcode from "qrcode-terminal";

// Direct import — bun embeds this at compile time so it works in compiled binaries.
import cliPkg from "../../package.json";

import { buildOpenclawStartupScript } from "../adapters/openclaw";
import {
  loadAllAssistants,
  saveAssistantEntry,
  syncConfigToLockfile,
} from "../lib/assistant-config";
import type { AssistantEntry } from "../lib/assistant-config";
import { hatchAws } from "../lib/aws";
import {
  GATEWAY_PORT,
  SPECIES_CONFIG,
  VALID_REMOTE_HOSTS,
  VALID_SPECIES,
} from "../lib/constants";
import type { RemoteHost, Species } from "../lib/constants";
import { hatchGcp } from "../lib/gcp";
import type { PollResult, WatchHatchingResult } from "../lib/gcp";
import {
  startLocalDaemon,
  startGateway,
  stopLocalProcesses,
} from "../lib/local";
import { probePort } from "../lib/port-probe";
import { isProcessAlive } from "../lib/process";
import { generateRandomSuffix } from "../lib/random-name";
import { validateAssistantName } from "../lib/retire-archive";

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
  bearerToken: string,
  sshUser: string,
  anthropicApiKey: string,
  instanceName: string,
  cloud: RemoteHost,
): Promise<string> {
  const platformUrl =
    process.env.VELLUM_ASSISTANT_PLATFORM_URL ?? "https://assistant.vellum.ai";
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
      bearerToken,
      sshUser,
      anthropicApiKey,
      timestampRedirect,
      userSetup,
      ownershipFixup,
    );
  }

  return `#!/bin/bash
set -e

${timestampRedirect}

trap 'EXIT_CODE=\$?; if [ \$EXIT_CODE -ne 0 ]; then echo "Startup script failed with exit code \$EXIT_CODE at line \$LINENO" > ${errorPath}; echo "Last 20 log lines:" >> ${errorPath}; tail -20 ${logPath} >> ${errorPath} 2>/dev/null || true; fi' EXIT
${userSetup}
ANTHROPIC_API_KEY=${anthropicApiKey}
GATEWAY_RUNTIME_PROXY_ENABLED=true
RUNTIME_PROXY_BEARER_TOKEN=${bearerToken}
VELLUM_ASSISTANT_NAME=${instanceName}
VELLUM_CLOUD=${cloud}
mkdir -p "\$HOME/.vellum"
cat > "\$HOME/.vellum/.env" << DOTENV_EOF
ANTHROPIC_API_KEY=\$ANTHROPIC_API_KEY
GATEWAY_RUNTIME_PROXY_ENABLED=\$GATEWAY_RUNTIME_PROXY_ENABLED
RUNTIME_PROXY_BEARER_TOKEN=\$RUNTIME_PROXY_BEARER_TOKEN
RUNTIME_HTTP_PORT=7821
VELLUM_CLOUD=\$VELLUM_CLOUD
DOTENV_EOF

mkdir -p "\$HOME/.vellum/workspace"
cat > "\$HOME/.vellum/workspace/config.json" << CONFIG_EOF
{
  "logFile": {
    "dir": "\$HOME/.vellum/workspace/data/logs"
  }
}
CONFIG_EOF

${ownershipFixup}

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
  name: string | null;
  remote: RemoteHost;
  daemonOnly: boolean;
  restart: boolean;
  watch: boolean;
}

function parseArgs(): HatchArgs {
  const args = process.argv.slice(3);
  let species: Species = DEFAULT_SPECIES;
  let detached = false;
  let name: string | null = null;
  let remote: RemoteHost = DEFAULT_REMOTE;
  let daemonOnly = false;
  let restart = false;
  let watch = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: assistant hatch [species] [options]");
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
        "  --remote <host>           Remote host (local, gcp, aws, custom)",
      );
      console.log(
        "  --daemon-only             Start assistant only, skip gateway",
      );
      console.log(
        "  --restart                 Restart processes without onboarding side effects",
      );
      console.log(
        "  --watch                   Run assistant and gateway in watch mode (hot reload on source changes)",
      );
      process.exit(0);
    } else if (arg === "-d") {
      detached = true;
    } else if (arg === "--daemon-only") {
      daemonOnly = true;
    } else if (arg === "--restart") {
      restart = true;
    } else if (arg === "--watch") {
      watch = true;
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
    } else if (VALID_SPECIES.includes(arg as Species)) {
      species = arg as Species;
    } else {
      console.error(
        `Error: Unknown argument '${arg}'. Valid options: ${VALID_SPECIES.join(", ")}, -d, --daemon-only, --restart, --watch, --name <name>, --remote <${VALID_REMOTE_HOSTS.join("|")}>`,
      );
      process.exit(1);
    }
  }

  return { species, detached, name, remote, daemonOnly, restart, watch };
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
        resolve({ success: true, errorContent: lastErrorContent });
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
        resolve({ success: true, errorContent: lastErrorContent });
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
  const preferredPath = "/usr/local/bin/assistant";
  if (trySymlink(cliBinary, preferredPath)) {
    console.log(`   Symlinked ${preferredPath} → ${cliBinary}`);
    return;
  }

  // Fallback — use ~/.local/bin which is user-writable and doesn't need root.
  // On some Macs /usr/local doesn't exist and creating it requires admin privileges.
  const localBinDir = join(homedir(), ".local", "bin");
  const fallbackPath = join(localBinDir, "assistant");
  if (trySymlink(cliBinary, fallbackPath)) {
    console.log(`   Symlinked ${fallbackPath} → ${cliBinary}`);
    ensureLocalBinInShellProfile(localBinDir);
    return;
  }

  console.log(
    `   ⚠ Could not create symlink for assistant CLI (tried ${preferredPath} and ${fallbackPath})`,
  );
}

async function waitForDaemonReady(
  runtimeUrl: string,
  bearerToken: string | undefined,
  timeoutMs = 15000,
): Promise<boolean> {
  const start = Date.now();
  const pollInterval = 1000;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${runtimeUrl}/v1/health`, {
        method: "GET",
        headers: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {},
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return true;
    } catch {
      // Daemon not ready yet
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }
  return false;
}

async function displayPairingQRCode(
  runtimeUrl: string,
  bearerToken: string | undefined,
): Promise<void> {
  try {
    const pairingRequestId = randomUUID();
    const pairingSecret = randomBytes(32).toString("hex");

    // The daemon's HTTP server may not be fully ready even though the gateway
    // health check passed (the gateway is up, but the upstream daemon HTTP
    // endpoint it proxies to may still be initializing). Poll the daemon's
    // health endpoint through the gateway to ensure it's reachable.
    const daemonReady = await waitForDaemonReady(runtimeUrl, bearerToken);
    if (!daemonReady) {
      console.warn(
        "⚠ Assistant health check did not pass within 15s. Run `assistant pair` to try again.\n",
      );
      return;
    }

    const registerRes = await fetch(`${runtimeUrl}/pairing/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
      },
      body: JSON.stringify({
        pairingRequestId,
        pairingSecret,
        gatewayUrl: runtimeUrl,
      }),
    });

    if (!registerRes.ok) {
      const body = await registerRes.text().catch(() => "");
      console.warn(
        `⚠ Could not register pairing request: ${registerRes.status} ${registerRes.statusText}${body ? ` — ${body}` : ""}. Run \`assistant pair\` to try again.\n`,
      );
      return;
    }

    const hostId = createHash("sha256")
      .update(hostname() + userInfo().username)
      .digest("hex");
    const payload = JSON.stringify({
      type: "vellum-daemon",
      v: 4,
      id: hostId,
      g: runtimeUrl,
      pairingRequestId,
      pairingSecret,
    });

    const qrString = await new Promise<string>((resolve) => {
      qrcode.generate(payload, { small: true }, (code: string) => {
        resolve(code);
      });
    });

    // Save QR code as PNG to a well-known location so it can be retrieved
    // (e.g. via SCP) for pairing through the Desktop app.
    const qrDir = join(homedir(), ".vellum", "pairing-qr");
    mkdirSync(qrDir, { recursive: true });
    const qrPngPath = join(qrDir, "initial.png");
    try {
      const pngBuffer = await QRCode.toBuffer(payload, {
        type: "png",
        width: 512,
      });
      writeFileSync(qrPngPath, pngBuffer);
      console.log(`QR code PNG saved to ${qrPngPath}\n`);
    } catch (pngErr) {
      const pngReason =
        pngErr instanceof Error ? pngErr.message : String(pngErr);
      console.warn(`\u26A0 Could not save QR code PNG: ${pngReason}\n`);
    }

    console.log("Scan this QR code with the Vellum iOS app to pair:\n");
    console.log(qrString);
    console.log("This pairing request expires in 5 minutes.");
    console.log("Run `assistant pair` to generate a new one.\n");
  } catch (err) {
    // Non-fatal — pairing is optional
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `⚠ Could not generate pairing QR code: ${reason}. Run \`assistant pair\` to try again.\n`,
    );
  }
}

async function hatchLocal(
  species: Species,
  name: string | null,
  daemonOnly: boolean = false,
  restart: boolean = false,
  watch: boolean = false,
): Promise<void> {
  if (restart && !name && !process.env.VELLUM_ASSISTANT_NAME) {
    console.error(
      "Error: Cannot restart without a known assistant ID. Provide --name or ensure VELLUM_ASSISTANT_NAME is set.",
    );
    process.exit(1);
  }

  const instanceName =
    name ??
    process.env.VELLUM_ASSISTANT_NAME ??
    `${species}-${generateRandomSuffix()}`;

  // Clean up stale local state: if daemon/gateway processes are running but
  // the lock file has no entries, stop them before starting fresh.
  const vellumDir = join(homedir(), ".vellum");
  const existingAssistants = loadAllAssistants();
  const localAssistants = existingAssistants.filter((a) => a.cloud === "local");
  if (localAssistants.length === 0) {
    const daemonPid = isProcessAlive(join(vellumDir, "vellum.pid"));
    const gatewayPid = isProcessAlive(join(vellumDir, "gateway.pid"));
    if (daemonPid.alive || gatewayPid.alive) {
      console.log(
        "🧹 Cleaning up stale local processes (no lock file entry)...\n",
      );
      await stopLocalProcesses();
    }

    // Verify required ports are available before starting any services.
    // Only check when no local assistants exist — if there are existing local
    // assistants, their daemon/gateway/qdrant legitimately own these ports.
    const RUNTIME_HTTP_PORT = Number(process.env.RUNTIME_HTTP_PORT) || 7821;
    const QDRANT_PORT = 6333;
    const requiredPorts = [
      { name: "daemon", port: RUNTIME_HTTP_PORT },
      { name: "gateway", port: GATEWAY_PORT },
      { name: "qdrant", port: QDRANT_PORT },
    ];
    const conflicts: string[] = [];
    await Promise.all(
      requiredPorts.map(async ({ name, port }) => {
        if (await probePort(port)) {
          conflicts.push(`  - Port ${port} (${name}) is already in use`);
        }
      }),
    );
    if (conflicts.length > 0) {
      throw new Error(
        `Cannot hatch — required ports are already in use:\n${conflicts.join("\n")}\n\n` +
          "Stop the conflicting processes or use environment variables to configure alternative ports " +
          "(RUNTIME_HTTP_PORT, GATEWAY_PORT).",
      );
    }
  }

  const baseDataDir = join(
    process.env.BASE_DATA_DIR?.trim() ||
      (process.env.HOME ?? userInfo().homedir),
    ".vellum",
  );

  console.log(`🥚 Hatching local assistant: ${instanceName}`);
  console.log(`   Species: ${species}`);
  console.log("");

  await startLocalDaemon(watch);

  let runtimeUrl: string;
  try {
    runtimeUrl = await startGateway(instanceName, watch);
  } catch (error) {
    // Gateway failed — stop the daemon we just started so we don't leave
    // orphaned processes with no lock file entry.
    console.error(
      `\n❌ Gateway startup failed — stopping assistant to avoid orphaned processes.`,
    );
    await stopLocalProcesses();
    throw error;
  }

  // Read the bearer token (JWT) written by the daemon so the CLI can
  // authenticate with the gateway.
  let bearerToken: string | undefined;
  try {
    const token = readFileSync(join(baseDataDir, "http-token"), "utf-8").trim();
    if (token) bearerToken = token;
  } catch {
    // Token file may not exist if daemon started without HTTP server
  }

  const localEntry: AssistantEntry = {
    assistantId: instanceName,
    runtimeUrl,
    baseDataDir,
    bearerToken,
    cloud: "local",
    species,
    hatchedAt: new Date().toISOString(),
  };
  if (!daemonOnly && !restart) {
    saveAssistantEntry(localEntry);
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

    // Generate and display pairing QR code
    await displayPairingQRCode(runtimeUrl, bearerToken);
  }
}

function getCliVersion(): string {
  return cliPkg.version ?? "unknown";
}

export async function hatch(): Promise<void> {
  const cliVersion = getCliVersion();
  console.log(`@vellumai/cli v${cliVersion}`);

  const { species, detached, name, remote, daemonOnly, restart, watch } =
    parseArgs();

  if (restart && remote !== "local") {
    console.error(
      "Error: --restart is only supported for local hatch targets.",
    );
    process.exit(1);
  }

  if (watch && remote !== "local") {
    console.error("Error: --watch is only supported for local hatch targets.");
    process.exit(1);
  }

  if (remote === "local") {
    await hatchLocal(species, name, daemonOnly, restart, watch);
    return;
  }

  if (remote === "gcp") {
    await hatchGcp(species, detached, name, buildStartupScript, watchHatching);
    return;
  }

  if (remote === "aws") {
    await hatchAws(species, detached, name);
    return;
  }

  console.error(`Error: Remote host '${remote}' is not yet supported.`);
  process.exit(1);
}
