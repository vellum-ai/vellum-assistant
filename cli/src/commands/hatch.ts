import { randomBytes } from "crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { homedir, tmpdir, userInfo } from "os";
import { join } from "path";

// Direct import — bun embeds this at compile time so it works in compiled binaries.
import cliPkg from "../../package.json";

import { buildOpenclawStartupScript } from "../adapters/openclaw";
import { loadAllAssistants, saveAssistantEntry } from "../lib/assistant-config";
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
import { startLocalDaemon, startGateway, stopLocalProcesses } from "../lib/local";
import { isProcessAlive } from "../lib/process";
import { generateRandomSuffix } from "../lib/random-name";
import { validateAssistantName } from "../lib/retire-archive";
import { exec } from "../lib/step-runner";

export type { PollResult, WatchHatchingResult } from "../lib/gcp";

const INSTALL_SCRIPT_REMOTE_PATH = "/tmp/vellum-install.sh";

// Embedded install script — bun --compile doesn't bundle non-JS assets,
// so we inline it to ensure it's available in the compiled binary.
import INSTALL_SCRIPT_CONTENT from "../adapters/install.sh" with { type: "text" };

function resolveInstallScriptPath(): string {
  const tmpPath = join(tmpdir(), `vellum-install-${process.pid}.sh`);
  writeFileSync(tmpPath, INSTALL_SCRIPT_CONTENT, { mode: 0o755 });
  return tmpPath;
}
const HATCH_TIMEOUT_MS: Record<Species, number> = {
  vellum: 2 * 60 * 1000,
  openclaw: 10 * 60 * 1000,
};
const DEFAULT_SPECIES: Species = "vellum";

const SPINNER_FRAMES= ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
  const platformUrl = process.env.VELLUM_ASSISTANT_PLATFORM_URL ?? "https://assistant.vellum.ai";
  const logPath = cloud === "custom" ? "/tmp/vellum-startup.log" : "/var/log/startup-script.log";
  const errorPath = cloud === "custom" ? "/tmp/vellum-startup-error" : "/var/log/startup-error";
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
}

function parseArgs(): HatchArgs {
  const args = process.argv.slice(3);
  let species: Species = DEFAULT_SPECIES;
  let detached = false;
  let name: string | null = null;
  let remote: RemoteHost = DEFAULT_REMOTE;
  let daemonOnly = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-d") {
      detached = true;
    } else if (arg === "--daemon-only") {
      daemonOnly = true;
    } else if (arg === "--name") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --name requires a value");
        process.exit(1);
      }
      try {
        validateAssistantName(next);
      } catch {
        console.error(`Error: --name contains invalid characters (path separators or traversal segments are not allowed)`);
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
        `Error: Unknown argument '${arg}'. Valid options: ${VALID_SPECIES.join(", ")}, -d, --daemon-only, --name <name>, --remote <${VALID_REMOTE_HOSTS.join("|")}>`,
      );
      process.exit(1);
    }
  }

  return { species, detached, name, remote, daemonOnly };
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

function getPhaseIcon(hasLogs: boolean, elapsedMs: number, species: Species): string {
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

    const lines = ["", `   ${icon} ${spinner}  ${message}  ⏱  ${formatElapsed(elapsed)}`, ""];

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
        console.log(`   ⏰ Timed out after ${formatElapsed(elapsed)}. Instance is still running.`);
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
        desktopLog(`Timed out after ${formatElapsed(elapsed)}. Instance is still running.`);
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

function buildSshArgs(host: string): string[] {
  const args: string[] = [host];
  const keyPath = process.env.VELLUM_SSH_KEY_PATH;
  if (keyPath) {
    args.push("-i", keyPath);
  }
  args.push(
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=10",
    "-o", "LogLevel=ERROR",
  );
  return args;
}

function buildScpArgs(keyPath?: string): string[] {
  const args: string[] = [];
  if (keyPath) {
    args.push("-i", keyPath);
  }
  args.push(
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
  );
  return args;
}

function extractHostname(host: string): string {
  return host.includes("@") ? host.split("@")[1] : host;
}

async function hatchCustom(
  species: Species,
  detached: boolean,
  name: string | null,
): Promise<void> {
  const host = process.env.VELLUM_CUSTOM_HOST;
  if (!host) {
    console.error("Error: VELLUM_CUSTOM_HOST environment variable is required when using --remote custom (e.g., user@hostname)");
    process.exit(1);
  }

  try {
    const hostname = extractHostname(host);
    const instanceName = name ?? `${species}-${generateRandomSuffix()}`;

    console.log(`🥚 Creating new assistant: ${instanceName}`);
    console.log(`   Species: ${species}`);
    console.log(`   Cloud: Custom`);
    console.log(`   Host: ${host}`);
    console.log("");

    const sshUser = host.includes("@") ? host.split("@")[0] : userInfo().username;
    const bearerToken = randomBytes(32).toString("hex");
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicApiKey) {
      console.error("Error: ANTHROPIC_API_KEY environment variable is not set.");
      process.exit(1);
    }

    const startupScript = await buildStartupScript(
      species,
      bearerToken,
      sshUser,
      anthropicApiKey,
      instanceName,
      "custom",
    );
    const startupScriptPath = join(tmpdir(), `${instanceName}-startup.sh`);
    writeFileSync(startupScriptPath, startupScript);

    const sshKeyPath = process.env.VELLUM_SSH_KEY_PATH;

    const installScriptPath = resolveInstallScriptPath();

    try {
      console.log("📋 Uploading install script to instance...");
      await exec("scp", [
        ...buildScpArgs(sshKeyPath),
        installScriptPath,
        `${host}:${INSTALL_SCRIPT_REMOTE_PATH}`,
      ]);

      console.log("📋 Uploading startup script to instance...");
      const remoteStartupPath = `/tmp/${instanceName}-startup.sh`;
      await exec("scp", [
        ...buildScpArgs(sshKeyPath),
        startupScriptPath,
        `${host}:${remoteStartupPath}`,
      ]);

      console.log("🔨 Running startup script on instance...");
      await exec("ssh", [
        ...buildSshArgs(host),
        `chmod +x ${remoteStartupPath} ${INSTALL_SCRIPT_REMOTE_PATH} && bash ${remoteStartupPath}`,
      ]);
    } finally {
      try { unlinkSync(startupScriptPath); } catch {}
      try { unlinkSync(installScriptPath); } catch {}
    }

    const runtimeUrl = `http://${hostname}:${GATEWAY_PORT}`;
    const customEntry: AssistantEntry = {
      assistantId: instanceName,
      runtimeUrl,
      bearerToken,
      cloud: "custom",
      species,
      sshUser,
      hatchedAt: new Date().toISOString(),
    };
    saveAssistantEntry(customEntry);

    if (detached) {
      console.log("");
      console.log("✅ Assistant is hatching!\n");
    } else {
      console.log("");
      console.log("✅ Assistant has been set up!");
    }
    console.log("Instance details:");
    console.log(`  Name: ${instanceName}`);
    console.log(`  Host: ${host}`);
    console.log(`  Runtime URL: ${runtimeUrl}`);
    console.log("");
  } catch (error) {
    console.error("❌ Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

function installCLISymlink(): void {
  const cliBinary = process.execPath;
  if (!cliBinary || !existsSync(cliBinary)) return;

  const symlinkPath = "/usr/local/bin/vellum";

  try {
    // If path exists, check whether it's our symlink or something else
    if (existsSync(symlinkPath)) {
      const stats = lstatSync(symlinkPath);
      if (!stats.isSymbolicLink()) {
        // Real file — don't overwrite (developer's local install)
        return;
      }
      // Already a symlink — skip if it already points to our binary
      const dest = readlinkSync(symlinkPath);
      if (dest === cliBinary) return;
      // Stale symlink — remove before creating new one
      unlinkSync(symlinkPath);
    }

    const dir = "/usr/local/bin";
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    symlinkSync(cliBinary, symlinkPath);
    console.log(`   Symlinked ${symlinkPath} → ${cliBinary}`);
  } catch {
    // Permission denied or other error — not critical
    console.log(`   ⚠ Could not create symlink at ${symlinkPath} (run with sudo or create manually)`);
  }
}

async function hatchLocal(species: Species, name: string | null, daemonOnly: boolean = false): Promise<void> {
  const instanceName =
    name ?? process.env.VELLUM_ASSISTANT_NAME ?? `${species}-${generateRandomSuffix()}`;

  // Clean up stale local state: if daemon/gateway processes are running but
  // the lock file has no entries, stop them before starting fresh.
  const vellumDir = join(homedir(), ".vellum");
  const existingAssistants = loadAllAssistants();
  const localAssistants = existingAssistants.filter((a) => a.cloud === "local");
  if (localAssistants.length === 0) {
    const daemonPid = isProcessAlive(join(vellumDir, "vellum.pid"));
    const gatewayPid = isProcessAlive(join(vellumDir, "gateway.pid"));
    if (daemonPid.alive || gatewayPid.alive) {
      console.log("🧹 Cleaning up stale local processes (no lock file entry)...\n");
      await stopLocalProcesses();
    }
  }

  const baseDataDir = join(process.env.BASE_DATA_DIR?.trim() || (process.env.HOME ?? userInfo().homedir), ".vellum");

  if (existsSync(baseDataDir)) {
    throw new Error(
      `Base data directory already exists: ${baseDataDir}\n` +
        "  Another assistant may already be using this directory.\n" +
        "  To use a different directory, set the BASE_DATA_DIR environment variable.",
    );
  }

  console.log(`🥚 Hatching local assistant: ${instanceName}`);
  console.log(`   Species: ${species}`);
  console.log("");

  await startLocalDaemon();

  let runtimeUrl: string;
  try {
    runtimeUrl = await startGateway(instanceName);
  } catch (error) {
    // Gateway failed — stop the daemon we just started so we don't leave
    // orphaned processes with no lock file entry.
    console.error(`\n❌ Gateway startup failed — stopping daemon to avoid orphaned processes.`);
    await stopLocalProcesses();
    throw error;
  }

  // Read the bearer token written by the daemon so the client can authenticate
  // with the gateway (which requires auth by default).
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
  if (!daemonOnly) {
    saveAssistantEntry(localEntry);

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
}

function getCliVersion(): string {
  return cliPkg.version ?? "unknown";
}

export async function hatch(): Promise<void> {
  const cliVersion = getCliVersion();
  console.log(`@vellumai/cli v${cliVersion}`);

  const { species, detached, name, remote, daemonOnly } = parseArgs();

  if (remote === "local") {
    await hatchLocal(species, name, daemonOnly);
    return;
  }

  if (remote === "gcp") {
    await hatchGcp(species, detached, name, buildStartupScript, watchHatching);
    return;
  }

  if (remote === "custom") {
    await hatchCustom(species, detached, name);
    return;
  }

  if (remote === "aws") {
    await hatchAws(species, detached, name);
    return;
  }

  console.error(`Error: Remote host '${remote}' is not yet supported.`);
  process.exit(1);
}
