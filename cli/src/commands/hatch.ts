import { randomBytes } from "crypto";

// Direct import — bun embeds this at compile time so it works in compiled binaries.
import cliPkg from "../../package.json";

import { buildOpenclawStartupScript } from "../adapters/openclaw";
import {
  saveAssistantEntry,
  setActiveAssistant,
} from "../lib/assistant-config";
import { hatchAws } from "../lib/aws";
import {
  SPECIES_CONFIG,
  VALID_REMOTE_HOSTS,
  VALID_SPECIES,
} from "../lib/constants";
import type { RemoteHost, Species } from "../lib/constants";
import { buildNestedConfig } from "../lib/config-utils";
import { hatchDocker } from "../lib/docker";
import { hatchGcp } from "../lib/gcp";
import type { PollResult, WatchHatchingResult } from "../lib/gcp";
import { hatchLocal } from "../lib/hatch-local";
import {
  getPlatformUrl,
  hatchAssistant,
  readPlatformToken,
} from "../lib/platform-client";
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
  sshUser: string,
  providerApiKeys: Record<string, string>,
  instanceName: string,
  cloud: RemoteHost,
  configValues: Record<string, string> = {},
): Promise<{ script: string; laptopBootstrapSecret: string }> {
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
    const script = await buildOpenclawStartupScript(
      sshUser,
      providerApiKeys,
      timestampRedirect,
      userSetup,
      ownershipFixup,
    );
    return { script, laptopBootstrapSecret: "" };
  }

  // Generate a bootstrap secret for the laptop that initiated this remote
  // hatch. The startup script exports it as GUARDIAN_BOOTSTRAP_SECRET so
  // that when `vellum hatch --remote docker` runs on the VM, the docker
  // hatch detects the pre-set env var and appends its own secret.
  const laptopBootstrapSecret = randomBytes(32).toString("hex");

  // Build bash lines that set each provider API key as a shell variable
  // and corresponding dotenv lines for the env file.
  // Include the laptop bootstrap secret so that when the remote runs
  // `vellum hatch --remote docker`, the docker hatch detects the pre-set
  // env var and appends its own secret for multi-secret guardian init.
  const allEnvEntries: Record<string, string> = {
    ...providerApiKeys,
    GUARDIAN_BOOTSTRAP_SECRET: laptopBootstrapSecret,
  };
  const envSetLines = Object.entries(allEnvEntries)
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

  return {
    laptopBootstrapSecret,
    script: `#!/bin/bash
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
export GUARDIAN_BOOTSTRAP_SECRET
export VELLUM_SSH_USER="\$SSH_USER"
export VELLUM_ASSISTANT_NAME="\$VELLUM_ASSISTANT_NAME"
export VELLUM_CLOUD="${cloud}"
echo "Downloading install script from ${platformUrl}/install.sh..."
curl -fsSL ${platformUrl}/install.sh -o ${INSTALL_SCRIPT_REMOTE_PATH}
echo "Install script downloaded (\$(wc -c < ${INSTALL_SCRIPT_REMOTE_PATH}) bytes)"
chmod +x ${INSTALL_SCRIPT_REMOTE_PATH}
echo "Running install script..."
source ${INSTALL_SCRIPT_REMOTE_PATH}
`,
  };
}

const DEFAULT_REMOTE: RemoteHost = "local";

interface HatchArgs {
  species: Species;
  detached: boolean;
  keepAlive: boolean;
  name: string | null;
  remote: RemoteHost;
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
        "  --remote <host>           Remote host (local, gcp, aws, docker, custom, vellum)",
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
        `Error: Unknown argument '${arg}'. Valid options: ${VALID_SPECIES.join(", ")}, -d, --watch, --keep-alive, --name <name>, --remote <${VALID_REMOTE_HOSTS.join("|")}>, --config <key=value>`,
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

export { hatchLocal };

function getCliVersion(): string {
  return cliPkg.version ?? "unknown";
}

export async function hatch(): Promise<void> {
  const cliVersion = getCliVersion();
  console.log(`@vellumai/cli v${cliVersion}`);

  const { species, detached, keepAlive, name, remote, watch, configValues } =
    parseArgs();

  if (watch && remote !== "local" && remote !== "docker") {
    console.error(
      "Error: --watch is only supported for local and docker hatch targets.",
    );
    process.exit(1);
  }

  if (remote === "local") {
    await hatchLocal(species, name, watch, keepAlive, configValues);
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

  if (remote === "vellum") {
    await hatchVellumPlatform();
    return;
  }

  console.error(`Error: Remote host '${remote}' is not yet supported.`);
  process.exit(1);
}

async function hatchVellumPlatform(): Promise<void> {
  const token = readPlatformToken();
  if (!token) {
    console.error("Not logged in. Run `vellum login --token <token>` first.");
    process.exit(1);
  }

  const config = SPECIES_CONFIG.vellum;
  console.log("");
  for (const line of config.art) {
    console.log(`   ${line}`);
  }
  console.log("");
  console.log("   Hatching assistant on Vellum platform...");
  console.log("");

  const result = await hatchAssistant(token);

  const platformUrl = getPlatformUrl();

  saveAssistantEntry({
    assistantId: result.id,
    runtimeUrl: platformUrl,
    cloud: "vellum",
    species: "vellum",
    hatchedAt: new Date().toISOString(),
  });
  setActiveAssistant(result.id);

  console.log(`   ${config.hatchedEmoji}  Your assistant has hatched!`);
  console.log("");
  console.log(`   ID:     ${result.id}`);
  console.log(`   Name:   ${result.name}`);
  console.log(`   Status: ${result.status}`);
  console.log("");
}
