import { randomBytes } from "crypto";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir, userInfo } from "os";
import { join } from "path";

import { saveAssistantEntry } from "../lib/assistant-config";
import {
  FIREWALL_TAG,
  GATEWAY_PORT,
  GCP_PROJECT,
  SPECIES_CONFIG,
  VALID_SPECIES,
} from "../lib/constants";
import type { Species } from "../lib/constants";
import type { FirewallRuleSpec } from "../lib/gcp";
import { instanceExists, syncFirewallRules } from "../lib/gcp";
import { buildInterfacesSeed } from "../lib/interfaces-seed";
import { buildOpenclawRuntimeServer } from "../lib/openclaw-runtime-server";
import { generateRandomSuffix } from "../lib/random-name";
import { ensureAnthropicKey } from "../lib/secrets";
import { exec, execOutput } from "../lib/step-runner";

const DEFAULT_ZONE = "us-central1-a";
const INSTALL_SCRIPT_REMOTE_PATH = "/tmp/vellum-install.sh";
const INSTALL_SCRIPT_REPO_PATH = join("web", "public", "install.sh");
const MACHINE_TYPE = "e2-standard-4"; // 4 vCPUs, 16 GB memory
const DEFAULT_SPECIES: Species = "velly";

const DESIRED_FIREWALL_RULES: FirewallRuleSpec[] = [
  {
    name: "allow-vellum-assistant-gateway",
    direction: "INGRESS",
    action: "ALLOW",
    rules: `tcp:${GATEWAY_PORT}`,
    sourceRanges: "0.0.0.0/0",
    targetTags: FIREWALL_TAG,
    description: `Allow gateway ingress on port ${GATEWAY_PORT} for vellum-assistant instances`,
  },
  {
    name: "allow-vellum-assistant-egress",
    direction: "EGRESS",
    action: "ALLOW",
    rules: "all",
    destinationRanges: "0.0.0.0/0",
    targetTags: FIREWALL_TAG,
    description: "Allow all egress traffic for vellum-assistant instances",
  },
];

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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

function buildStartupScript(
  species: Species,
  bearerToken: string,
  sshUser: string,
  anthropicApiKey: string,
): string {
  const timestampRedirect = buildTimestampRedirect();
  const userSetup = buildUserSetup(sshUser);
  const ownershipFixup = buildOwnershipFixup();

  if (species === "openclaw") {
    const runtimeServer = buildOpenclawRuntimeServer();
    return `#!/bin/bash
set -e

${timestampRedirect}

trap 'EXIT_CODE=\$?; if [ \$EXIT_CODE -ne 0 ]; then echo "Startup script failed with exit code \$EXIT_CODE" > /var/log/startup-error; fi' EXIT
${userSetup}

export OPENCLAW_NPM_LOGLEVEL=verbose
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_NO_PROMPT=1

echo "=== Pre-install diagnostics ==="
echo "Date: $(date -u)"
echo "Disk:" && df -h / 2>&1 || true
echo "Memory:" && free -m 2>&1 || true
echo "DNS:" && nslookup registry.npmjs.org 2>&1 || true
echo "Registry ping:" && curl -sSf --max-time 10 https://registry.npmjs.org/-/ping 2>&1 || echo "WARN: npm registry unreachable"
echo "=== End pre-install diagnostics ==="

echo "=== Installing build dependencies ==="
apt-get update -y
apt-get install -y build-essential python3 python3-pip git
pip3 install cmake
echo "cmake version: $(cmake --version | head -1)"
echo "=== Build dependencies installed ==="

curl -fsSL https://openclaw.ai/install.sh -o /tmp/openclaw-install.sh
chmod +x /tmp/openclaw-install.sh

set +e
bash /tmp/openclaw-install.sh
INSTALL_EXIT_CODE=\$?
set -e

if [ \$INSTALL_EXIT_CODE -ne 0 ]; then
  echo "=== OpenClaw install failed (exit code: \$INSTALL_EXIT_CODE) ==="
  echo "=== npm debug logs ==="
  find \$HOME/.npm/_logs -name '*.log' -type f 2>/dev/null | sort | while read -r logfile; do
    echo "--- \$logfile ---"
    tail -n 200 "\$logfile" 2>/dev/null || true
  done
  echo "=== Post-failure diagnostics ==="
  echo "Disk:" && df -h / 2>&1 || true
  echo "Memory:" && free -m 2>&1 || true
  echo "node version:" && node --version 2>&1 || echo "node not found"
  echo "npm version:" && npm --version 2>&1 || echo "npm not found"
  echo "npm config:" && npm config list 2>&1 || true
  echo "cmake version:" && cmake --version 2>&1 || echo "cmake not found"
  echo "PATH: \$PATH"
  echo "=== End diagnostics ==="
  exit \$INSTALL_EXIT_CODE
fi

export PATH="\$HOME/.npm-global/bin:\$HOME/.local/bin:/usr/local/bin:\$PATH"

if ! command -v openclaw >/dev/null 2>&1; then
  echo "ERROR: openclaw CLI installation failed. The 'openclaw' command is not available."
  echo "PATH: \$PATH"
  echo "which openclaw:" && which openclaw 2>&1 || true
  echo "npm global bin:" && npm bin -g 2>&1 || true
  echo "npm global list:" && npm list -g --depth=0 2>&1 || true
  exit 1
fi

export XDG_RUNTIME_DIR="/run/user/\$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=\$XDG_RUNTIME_DIR/bus"
mkdir -p "\$XDG_RUNTIME_DIR"
loginctl enable-linger root 2>/dev/null || true
systemctl --user daemon-reexec 2>/dev/null || true

if ! command -v bun >/dev/null 2>&1; then
  echo "=== Installing bun ==="
  if ! command -v unzip >/dev/null 2>&1; then
    echo "Installing unzip (required by bun)..."
    apt-get install -y unzip
  fi
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="\$HOME/.bun"
  export PATH="\$BUN_INSTALL/bin:\$PATH"
  echo "bun version: $(bun --version)"
  echo "=== Bun installed ==="
else
  echo "bun already installed: $(bun --version)"
fi

openclaw gateway install --token ${bearerToken}

mkdir -p /root/.openclaw
openclaw config set env.ANTHROPIC_API_KEY "${anthropicApiKey}"
openclaw config set agents.defaults.model.primary "anthropic/claude-opus-4-6"
openclaw config set gateway.auth.token "${bearerToken}"

echo "=== Starting openclaw gateway at user level ==="
systemctl --user daemon-reload
systemctl --user enable --now openclaw-gateway.service

export PORT=${GATEWAY_PORT}

echo "=== Starting OpenClaw runtime server ==="
${runtimeServer}
echo "=== OpenClaw runtime server started ==="
${ownershipFixup}
`;
  }

  const interfacesSeed = buildInterfacesSeed();

  return `#!/bin/bash
set -e

${timestampRedirect}

trap 'EXIT_CODE=\$?; if [ \$EXIT_CODE -ne 0 ]; then echo "Startup script failed with exit code \$EXIT_CODE" > /var/log/startup-error; fi' EXIT
${userSetup}
ANTHROPIC_API_KEY=${anthropicApiKey}
GATEWAY_RUNTIME_PROXY_ENABLED=true
RUNTIME_PROXY_BEARER_TOKEN=${bearerToken}
${interfacesSeed}
mkdir -p "\$HOME/.vellum"
cat > "\$HOME/.vellum/.env" << DOTENV_EOF
ANTHROPIC_API_KEY=\$ANTHROPIC_API_KEY
GATEWAY_RUNTIME_PROXY_ENABLED=\$GATEWAY_RUNTIME_PROXY_ENABLED
RUNTIME_PROXY_BEARER_TOKEN=\$RUNTIME_PROXY_BEARER_TOKEN
INTERFACES_SEED_DIR=\$INTERFACES_SEED_DIR
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
curl -fsSL https://assistant.vellum.ai/install.sh -o ${INSTALL_SCRIPT_REMOTE_PATH}
chmod +x ${INSTALL_SCRIPT_REMOTE_PATH}
source ${INSTALL_SCRIPT_REMOTE_PATH}
`;
}

interface HatchArgs {
  species: Species;
  detached: boolean;
  name: string | null;
}

function parseArgs(): HatchArgs {
  const args = process.argv.slice(3);
  let species: Species = DEFAULT_SPECIES;
  let detached = false;
  let name: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-d") {
      detached = true;
    } else if (arg === "--name") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --name requires a value");
        process.exit(1);
      }
      name = next;
      i++;
    } else if (VALID_SPECIES.includes(arg as Species)) {
      species = arg as Species;
    } else {
      console.error(
        `Error: Unknown argument '${arg}'. Valid options: ${VALID_SPECIES.join(", ")}, -d, --name <name>`,
      );
      process.exit(1);
    }
  }

  return { species, detached, name };
}

interface PollResult {
  lastLine: string | null;
  done: boolean;
  failed: boolean;
}

async function pollInstance(
  instanceName: string,
  project: string,
  zone: string,
): Promise<PollResult> {
  try {
    const remoteCmd =
      "L=$(tail -1 /var/log/startup-script.log 2>/dev/null || true); " +
      "S=$(systemctl is-active google-startup-scripts.service 2>/dev/null || true); " +
      "E=$(cat /var/log/startup-error 2>/dev/null || true); " +
      'printf "%s\\n===HATCH_SEP===\\n%s\\n===HATCH_ERR===\\n%s" "$L" "$S" "$E"';
    const output = await execOutput("gcloud", [
      "compute",
      "ssh",
      instanceName,
      `--project=${project}`,
      `--zone=${zone}`,
      "--quiet",
      "--ssh-flag=-o StrictHostKeyChecking=no",
      "--ssh-flag=-o UserKnownHostsFile=/dev/null",
      "--ssh-flag=-o ConnectTimeout=10",
      "--ssh-flag=-o LogLevel=ERROR",
      `--command=${remoteCmd}`,
    ]);
    const sepIdx = output.indexOf("===HATCH_SEP===");
    if (sepIdx === -1) {
      return { lastLine: output.trim() || null, done: false, failed: false };
    }
    const errIdx = output.indexOf("===HATCH_ERR===");
    const lastLine = output.substring(0, sepIdx).trim() || null;
    const statusEnd = errIdx === -1 ? undefined : errIdx;
    const status = output.substring(sepIdx + "===HATCH_SEP===".length, statusEnd).trim();
    const errorContent =
      errIdx === -1 ? "" : output.substring(errIdx + "===HATCH_ERR===".length).trim();
    const done = lastLine !== null && status !== "active" && status !== "activating";
    const failed = errorContent.length > 0 || status === "failed";
    return { lastLine, done, failed };
  } catch {
    return { lastLine: null, done: false, failed: false };
  }
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

async function checkCurlFailure(
  instanceName: string,
  project: string,
  zone: string,
): Promise<boolean> {
  try {
    const output = await execOutput("gcloud", [
      "compute",
      "ssh",
      instanceName,
      `--project=${project}`,
      `--zone=${zone}`,
      "--quiet",
      "--ssh-flag=-o StrictHostKeyChecking=no",
      "--ssh-flag=-o UserKnownHostsFile=/dev/null",
      "--ssh-flag=-o ConnectTimeout=10",
      "--ssh-flag=-o LogLevel=ERROR",
      `--command=test -s ${INSTALL_SCRIPT_REMOTE_PATH} && echo EXISTS || echo MISSING`,
    ]);
    return output.trim() === "MISSING";
  } catch {
    return false;
  }
}

async function recoverFromCurlFailure(
  instanceName: string,
  project: string,
  zone: string,
  sshUser: string,
): Promise<void> {
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  const installScriptPath = join(repoRoot, INSTALL_SCRIPT_REPO_PATH);
  if (!existsSync(installScriptPath)) {
    throw new Error(`Install script not found at ${installScriptPath}`);
  }

  console.log("📋 Uploading install script to instance...");
  await exec("gcloud", [
    "compute",
    "scp",
    installScriptPath,
    `${instanceName}:${INSTALL_SCRIPT_REMOTE_PATH}`,
    `--zone=${zone}`,
    `--project=${project}`,
  ]);

  console.log("🔧 Running install script on instance...");
  await exec("gcloud", [
    "compute",
    "ssh",
    `${sshUser}@${instanceName}`,
    `--zone=${zone}`,
    `--project=${project}`,
    `--command=source ${INSTALL_SCRIPT_REMOTE_PATH}`,
  ]);
}

async function watchHatching(
  instanceName: string,
  project: string,
  zone: string,
  startTime: number,
  species: Species,
): Promise<boolean> {
  let spinnerIdx = 0;
  let lastLogLine: string | null = null;
  let linesDrawn = 0;
  let finished = false;
  let failed = false;
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
      const result = await pollInstance(instanceName, project, zone);
      if (result.lastLine) {
        lastLogLine = result.lastLine;
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

  return new Promise<boolean>((resolve) => {
    const interval = setInterval(() => {
      if (finished) {
        draw();
        clearInterval(interval);
        resolve(!failed);
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

export async function hatch(): Promise<void> {
  const startTime = Date.now();
  const { species, detached, name } = parseArgs();
  try {
    let instanceName: string;

    if (name) {
      instanceName = name;
    } else {
      const suffix = generateRandomSuffix();
      instanceName = `${species}-${suffix}`;
    }

    console.log(`🥚 Creating new assistant: ${instanceName}`);
    console.log(`   Species: ${species}`);
    console.log(`   Cloud: GCP`);
    console.log(`   Project: ${GCP_PROJECT}`);
    console.log(`   Zone: ${DEFAULT_ZONE}`);
    console.log(`   Machine type: ${MACHINE_TYPE}`);
    console.log("");

    if (name) {
      if (await instanceExists(name, GCP_PROJECT, DEFAULT_ZONE)) {
        console.error(
          `Error: Instance name '${name}' is already taken. Please choose a different name.`,
        );
        process.exit(1);
      }
    } else {
      while (await instanceExists(instanceName, GCP_PROJECT, DEFAULT_ZONE)) {
        console.log(`⚠️  Instance name ${instanceName} already exists, generating a new name...`);
        const suffix = generateRandomSuffix();
        instanceName = `${species}-${suffix}`;
      }
    }

    const sshUser = userInfo().username;
    const bearerToken = randomBytes(32).toString("hex");
    await ensureAnthropicKey();
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicApiKey) {
      console.error(
        "Error: ANTHROPIC_API_KEY could not be fetched from GCP Secret Manager. " +
          "Set it manually or check your gcloud configuration.",
      );
      process.exit(1);
    }
    const startupScript = buildStartupScript(species, bearerToken, sshUser, anthropicApiKey);
    const startupScriptPath = join(tmpdir(), `${instanceName}-startup.sh`);
    writeFileSync(startupScriptPath, startupScript);

    console.log("🔨 Creating instance with startup script...");
    try {
      await exec("gcloud", [
        "compute",
        "instances",
        "create",
        instanceName,
        `--project=${GCP_PROJECT}`,
        `--zone=${DEFAULT_ZONE}`,
        `--machine-type=${MACHINE_TYPE}`,
        "--image-family=debian-11",
        "--image-project=debian-cloud",
        "--boot-disk-size=50GB",
        "--boot-disk-type=pd-standard",
        `--metadata-from-file=startup-script=${startupScriptPath}`,
        `--labels=species=${species},vellum-assistant=true`,
        "--tags=vellum-assistant",
      ]);
    } finally {
      try {
        unlinkSync(startupScriptPath);
      } catch {}
    }

    console.log("🔒 Syncing firewall rules...");
    await syncFirewallRules(DESIRED_FIREWALL_RULES, GCP_PROJECT, FIREWALL_TAG);

    console.log(`✅ Instance ${instanceName} created successfully\n`);

    let externalIp: string | null = null;
    try {
      const ipOutput = await execOutput("gcloud", [
        "compute",
        "instances",
        "describe",
        instanceName,
        `--project=${GCP_PROJECT}`,
        `--zone=${DEFAULT_ZONE}`,
        "--format=get(networkInterfaces[0].accessConfigs[0].natIP)",
      ]);
      externalIp = ipOutput.trim() || null;
    } catch {
      console.log("⚠️  Could not retrieve external IP yet (instance may still be starting)");
    }

    const runtimeUrl = externalIp
      ? `http://${externalIp}:${GATEWAY_PORT}`
      : `http://${instanceName}:${GATEWAY_PORT}`;
    saveAssistantEntry({
      assistantId: instanceName,
      runtimeUrl,
      bearerToken,
      project: GCP_PROJECT,
      zone: DEFAULT_ZONE,
      species,
      sshUser,
      hatchedAt: new Date().toISOString(),
    });

    if (detached) {
      console.log("🚀 Startup script is running on the instance...");
      console.log("");
      console.log("✅ Assistant is hatching!\n");
      console.log("Instance details:");
      console.log(`  Name: ${instanceName}`);
      console.log(`  Project: ${GCP_PROJECT}`);
      console.log(`  Zone: ${DEFAULT_ZONE}`);
      if (externalIp) {
        console.log(`  External IP: ${externalIp}`);
      }
      console.log("");
      console.log("The startup script is running. To monitor progress:");
      console.log(`  vel logs ${instanceName}`);
      console.log("");
      console.log("To chat with the assistant once ready:");
      console.log(`  vel client ${instanceName}`);
      console.log("");
      console.log("To connect to the instance:");
      console.log(`  vel ssh ${instanceName}`);
      console.log("");
      console.log("To delete the instance when done:");
      console.log(`  vel retire ${instanceName}`);
      console.log("");
    } else {
      console.log("   Press Ctrl+C to detach (instance will keep running)");
      console.log("");

      const success = await watchHatching(
        instanceName,
        GCP_PROJECT,
        DEFAULT_ZONE,
        startTime,
        species,
      );

      if (!success) {
        if (
          species === "velly" &&
          (await checkCurlFailure(instanceName, GCP_PROJECT, DEFAULT_ZONE))
        ) {
          console.log("");
          console.log("🔄 Detected install script curl failure, attempting recovery...");
          await recoverFromCurlFailure(instanceName, GCP_PROJECT, DEFAULT_ZONE, sshUser);
          console.log("✅ Recovery successful!");
        } else {
          console.log("");
          console.log("To view startup logs:");
          console.log(`  vel logs ${instanceName}`);
          console.log("");
          console.log("To delete the instance:");
          console.log(`  vel retire ${instanceName}`);
          console.log("");
          process.exit(1);
        }
      }

      console.log("Instance details:");
      console.log(`  Name: ${instanceName}`);
      console.log(`  Project: ${GCP_PROJECT}`);
      console.log(`  Zone: ${DEFAULT_ZONE}`);
      if (externalIp) {
        console.log(`  External IP: ${externalIp}`);
      }
      console.log("");
      console.log("To chat with the assistant:");
      console.log(`  vel client ${instanceName}`);
      console.log("");
      console.log("To connect to the instance:");
      console.log(`  vel ssh ${instanceName}`);
      console.log("");
      console.log("To delete the instance when done:");
      console.log(`  vel retire ${instanceName}`);
      console.log("");
    }
  } catch (error) {
    console.error("❌ Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
