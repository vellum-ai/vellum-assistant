import { randomBytes } from "crypto";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { tmpdir, userInfo } from "os";
import { join } from "path";

import { buildOpenclawStartupScript } from "../adapters/openclaw";
import { saveAssistantEntry } from "../lib/assistant-config";
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
import { buildInterfacesSeed } from "../lib/interfaces-seed";
import { startLocalDaemon, startGateway } from "../lib/local";
import { generateRandomSuffix } from "../lib/random-name";
import { exec } from "../lib/step-runner";

export type { PollResult, WatchHatchingResult } from "../lib/gcp";

const INSTALL_SCRIPT_REMOTE_PATH = "/tmp/vellum-install.sh";

async function resolveInstallScriptPath(): Promise<string | null> {
  const sourcePath = join(import.meta.dir, "..", "adapters", "install.sh");
  if (existsSync(sourcePath)) {
    return sourcePath;
  }
  console.warn("⚠️  Install script not found at", sourcePath, "(expected in compiled binary)");
  return null;
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

function buildTimestampRedirect(): string {
  return `exec > >(while IFS= read -r line; do printf '[%s] %s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$line"; done > /var/log/startup-script.log) 2>&1`;
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
  const timestampRedirect = buildTimestampRedirect();
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

  const interfacesSeed = await buildInterfacesSeed();

  return `#!/bin/bash
set -e

${timestampRedirect}

trap 'EXIT_CODE=\$?; if [ \$EXIT_CODE -ne 0 ]; then echo "Startup script failed with exit code \$EXIT_CODE at line \$LINENO" > /var/log/startup-error; echo "Last 20 log lines:" >> /var/log/startup-error; tail -20 /var/log/startup-script.log >> /var/log/startup-error 2>/dev/null || true; fi' EXIT
${userSetup}
ANTHROPIC_API_KEY=${anthropicApiKey}
GATEWAY_RUNTIME_PROXY_ENABLED=true
RUNTIME_PROXY_BEARER_TOKEN=${bearerToken}
VELLUM_ASSISTANT_NAME=${instanceName}
VELLUM_CLOUD=${cloud}
${interfacesSeed}
mkdir -p "\$HOME/.vellum"
cat > "\$HOME/.vellum/.env" << DOTENV_EOF
ANTHROPIC_API_KEY=\$ANTHROPIC_API_KEY
GATEWAY_RUNTIME_PROXY_ENABLED=\$GATEWAY_RUNTIME_PROXY_ENABLED
RUNTIME_PROXY_BEARER_TOKEN=\$RUNTIME_PROXY_BEARER_TOKEN
INTERFACES_SEED_DIR=\$INTERFACES_SEED_DIR
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
  return [
    host,
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=10",
    "-o", "LogLevel=ERROR",
  ];
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

    try {
      const installScriptPath = await resolveInstallScriptPath();
      if (installScriptPath) {
        console.log("📋 Uploading install script to instance...");
        await exec("scp", [
          "-o", "StrictHostKeyChecking=no",
          "-o", "UserKnownHostsFile=/dev/null",
          "-o", "LogLevel=ERROR",
          installScriptPath,
          `${host}:${INSTALL_SCRIPT_REMOTE_PATH}`,
        ]);
      } else {
        console.warn("⚠️  Skipping install script upload (not available in compiled binary)");
      }

      console.log("📋 Uploading startup script to instance...");
      const remoteStartupPath = `/tmp/${instanceName}-startup.sh`;
      await exec("scp", [
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR",
        startupScriptPath,
        `${host}:${remoteStartupPath}`,
      ]);

      console.log("🔨 Running startup script on instance...");
      await exec("ssh", [
        ...buildSshArgs(host),
        `chmod +x ${remoteStartupPath} ${INSTALL_SCRIPT_REMOTE_PATH} && bash ${remoteStartupPath}`,
      ]);
    } finally {
      try {
        unlinkSync(startupScriptPath);
      } catch {}
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

async function hatchLocal(species: Species, name: string | null, daemonOnly: boolean = false): Promise<void> {
  const instanceName =
    name ?? process.env.VELLUM_ASSISTANT_NAME ?? `${species}-${generateRandomSuffix()}`;

  console.log(`🥚 Hatching local assistant: ${instanceName}`);
  console.log(`   Species: ${species}`);
  console.log("");

  await startLocalDaemon();

  // The desktop app communicates with the daemon directly via Unix socket,
  // so the HTTP gateway is only needed for non-desktop (CLI) usage.
  let runtimeUrl: string;

  if (process.env.VELLUM_DESKTOP_APP) {
    // No gateway needed — the macOS app uses DaemonClient over the Unix socket.
    runtimeUrl = "local";
  } else {
    runtimeUrl = await startGateway();
  }

  const baseDataDir = join(process.env.BASE_DATA_DIR?.trim() || (process.env.HOME ?? userInfo().homedir), ".vellum");
  const localEntry: AssistantEntry = {
    assistantId: instanceName,
    runtimeUrl,
    baseDataDir,
    cloud: "local",
    species,
    hatchedAt: new Date().toISOString(),
  };
  if (!daemonOnly) {
    saveAssistantEntry(localEntry);

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
  try {
    // Use createRequire for JSON import — works in both Bun dev and compiled binary.
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
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
