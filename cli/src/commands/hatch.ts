import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { tmpdir, userInfo } from "os";
import { dirname, join } from "path";

import { buildOpenclawStartupScript } from "../adapters/openclaw";
import { saveAssistantEntry } from "../lib/assistant-config";
import type { AssistantEntry } from "../lib/assistant-config";
import { hatchAws } from "../lib/aws";
import {
  FIREWALL_TAG,
  GATEWAY_PORT,
  SPECIES_CONFIG,
  VALID_REMOTE_HOSTS,
  VALID_SPECIES,
} from "../lib/constants";
import type { RemoteHost, Species } from "../lib/constants";
import type { FirewallRuleSpec } from "../lib/gcp";
import { fetchAndDisplayStartupLogs, getActiveProject, instanceExists, syncFirewallRules } from "../lib/gcp";
import { buildInterfacesSeed } from "../lib/interfaces-seed";
import { generateRandomSuffix } from "../lib/random-name";
import { exec, execOutput } from "../lib/step-runner";

const _require = createRequire(import.meta.url);

const INSTALL_SCRIPT_REMOTE_PATH = "/tmp/vellum-install.sh";
const INSTALL_SCRIPT_PATH = join(import.meta.dir, "..", "adapters", "install.sh");
const MACHINE_TYPE = "e2-standard-4"; // 4 vCPUs, 16 GB memory
const HATCH_TIMEOUT_MS: Record<Species, number> = {
  vellum: 2 * 60 * 1000,
  openclaw: 10 * 60 * 1000,
};
const DEFAULT_SPECIES: Species = "vellum";

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

export async function buildStartupScript(
  species: Species,
  bearerToken: string,
  sshUser: string,
  anthropicApiKey: string,
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

  const interfacesSeed = buildInterfacesSeed();

  return `#!/bin/bash
set -e

${timestampRedirect}

trap 'EXIT_CODE=\$?; if [ \$EXIT_CODE -ne 0 ]; then echo "Startup script failed with exit code \$EXIT_CODE at line \$LINENO" > /var/log/startup-error; echo "Last 20 log lines:" >> /var/log/startup-error; tail -20 /var/log/startup-script.log >> /var/log/startup-error 2>/dev/null || true; fi' EXIT
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
RUNTIME_HTTP_PORT=7821
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
}

function parseArgs(): HatchArgs {
  const args = process.argv.slice(3);
  let species: Species = DEFAULT_SPECIES;
  let detached = false;
  let name: string | null = null;
  let remote: RemoteHost = DEFAULT_REMOTE;

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
        `Error: Unknown argument '${arg}'. Valid options: ${VALID_SPECIES.join(", ")}, -d, --name <name>, --remote <${VALID_REMOTE_HOSTS.join("|")}>`,
      );
      process.exit(1);
    }
  }

  return { species, detached, name, remote };
}

export interface PollResult {
  lastLine: string | null;
  done: boolean;
  failed: boolean;
  errorContent: string;
}

async function pollInstance(
  instanceName: string,
  project: string,
  zone: string,
  account?: string,
): Promise<PollResult> {
  try {
    const remoteCmd =
      "L=$(tail -1 /var/log/startup-script.log 2>/dev/null || true); " +
      "S=$(systemctl is-active google-startup-scripts.service 2>/dev/null || true); " +
      "E=$(cat /var/log/startup-error 2>/dev/null || true); " +
      'printf "%s\\n===HATCH_SEP===\\n%s\\n===HATCH_ERR===\\n%s" "$L" "$S" "$E"';
    const args = [
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
    ];
    if (account) args.push(`--account=${account}`);
    const output = await execOutput("gcloud", args);
    const sepIdx = output.indexOf("===HATCH_SEP===");
    if (sepIdx === -1) {
      return { lastLine: output.trim() || null, done: false, failed: false, errorContent: "" };
    }
    const errIdx = output.indexOf("===HATCH_ERR===");
    const lastLine = output.substring(0, sepIdx).trim() || null;
    const statusEnd = errIdx === -1 ? undefined : errIdx;
    const status = output.substring(sepIdx + "===HATCH_SEP===".length, statusEnd).trim();
    const errorContent =
      errIdx === -1 ? "" : output.substring(errIdx + "===HATCH_ERR===".length).trim();
    const done = lastLine !== null && status !== "active" && status !== "activating";
    const failed = errorContent.length > 0 || status === "failed";
    return { lastLine, done, failed, errorContent };
  } catch {
    return { lastLine: null, done: false, failed: false, errorContent: "" };
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
  account?: string,
): Promise<boolean> {
  try {
    const args = [
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
    ];
    if (account) args.push(`--account=${account}`);
    const output = await execOutput("gcloud", args);
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
  account?: string,
): Promise<void> {
  if (!existsSync(INSTALL_SCRIPT_PATH)) {
    throw new Error(`Install script not found at ${INSTALL_SCRIPT_PATH}`);
  }

  const scpArgs = [
    "compute",
    "scp",
    INSTALL_SCRIPT_PATH,
    `${instanceName}:${INSTALL_SCRIPT_REMOTE_PATH}`,
    `--zone=${zone}`,
    `--project=${project}`,
  ];
  if (account) scpArgs.push(`--account=${account}`);
  console.log("📋 Uploading install script to instance...");
  await exec("gcloud", scpArgs);

  const sshArgs = [
    "compute",
    "ssh",
    `${sshUser}@${instanceName}`,
    `--zone=${zone}`,
    `--project=${project}`,
    `--command=source ${INSTALL_SCRIPT_REMOTE_PATH}`,
  ];
  if (account) sshArgs.push(`--account=${account}`);
  console.log("🔧 Running install script on instance...");
  await exec("gcloud", sshArgs);
}

export interface WatchHatchingResult {
  success: boolean;
  errorContent: string;
}

export async function watchHatching(
  pollFn: () => Promise<PollResult>,
  instanceName: string,
  startTime: number,
  species: Species,
): Promise<WatchHatchingResult> {
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


async function hatchGcp(
  species: Species,
  detached: boolean,
  name: string | null,
): Promise<void> {
  const startTime = Date.now();
  const account = process.env.GCP_ACCOUNT_EMAIL;
  try {
    const project = process.env.GCP_PROJECT ?? (await getActiveProject());
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
    console.log(`   Project: ${project}`);
    const zone = process.env.GCP_DEFAULT_ZONE;
    if (!zone) {
      console.error("Error: GCP_DEFAULT_ZONE environment variable is not set.");
      process.exit(1);
    }

    console.log(`   Zone: ${zone}`);
    console.log(`   Machine type: ${MACHINE_TYPE}`);
    console.log("");

    if (name) {
      if (await instanceExists(name, project, zone, account)) {
        console.error(
          `Error: Instance name '${name}' is already taken. Please choose a different name.`,
        );
        process.exit(1);
      }
    } else {
      while (await instanceExists(instanceName, project, zone, account)) {
        console.log(`⚠️  Instance name ${instanceName} already exists, generating a new name...`);
        const suffix = generateRandomSuffix();
        instanceName = `${species}-${suffix}`;
      }
    }

    const sshUser = userInfo().username;
    const bearerToken = randomBytes(32).toString("hex");
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicApiKey) {
      console.error("Error: ANTHROPIC_API_KEY environment variable is not set.");
      process.exit(1);
    }
    const startupScript = await buildStartupScript(species, bearerToken, sshUser, anthropicApiKey);
    const startupScriptPath = join(tmpdir(), `${instanceName}-startup.sh`);
    writeFileSync(startupScriptPath, startupScript);

    console.log("🔨 Creating instance with startup script...");
    try {
      const createArgs = [
        "compute",
        "instances",
        "create",
        instanceName,
        `--project=${project}`,
        `--zone=${zone}`,
        `--machine-type=${MACHINE_TYPE}`,
        "--image-family=debian-11",
        "--image-project=debian-cloud",
        "--boot-disk-size=50GB",
        "--boot-disk-type=pd-standard",
        `--metadata-from-file=startup-script=${startupScriptPath}`,
        `--labels=species=${species},vellum-assistant=true`,
        "--tags=vellum-assistant",
      ];
      if (account) createArgs.push(`--account=${account}`);
      await exec("gcloud", createArgs);
    } finally {
      try {
        unlinkSync(startupScriptPath);
      } catch {}
    }

    console.log("🔒 Syncing firewall rules...");
    await syncFirewallRules(DESIRED_FIREWALL_RULES, project, FIREWALL_TAG, account);

    console.log(`✅ Instance ${instanceName} created successfully\n`);

    let externalIp: string | null = null;
    try {
      const describeArgs = [
        "compute",
        "instances",
        "describe",
        instanceName,
        `--project=${project}`,
        `--zone=${zone}`,
        "--format=get(networkInterfaces[0].accessConfigs[0].natIP)",
      ];
      if (account) describeArgs.push(`--account=${account}`);
      const ipOutput = await execOutput("gcloud", describeArgs);
      externalIp = ipOutput.trim() || null;
    } catch {
      console.log("⚠️  Could not retrieve external IP yet (instance may still be starting)");
    }

    const runtimeUrl = externalIp
      ? `http://${externalIp}:${GATEWAY_PORT}`
      : `http://${instanceName}:${GATEWAY_PORT}`;
    const gcpEntry: AssistantEntry = {
      assistantId: instanceName,
      runtimeUrl,
      bearerToken,
      cloud: "gcp",
      project,
      zone,
      species,
      sshUser,
      hatchedAt: new Date().toISOString(),
    };
    saveAssistantEntry(gcpEntry);

    if (detached) {
      console.log("🚀 Startup script is running on the instance...");
      console.log("");
      console.log("✅ Assistant is hatching!\n");
      console.log("Instance details:");
      console.log(`  Name: ${instanceName}`);
      console.log(`  Project: ${project}`);
      console.log(`  Zone: ${zone}`);
      if (externalIp) {
        console.log(`  External IP: ${externalIp}`);
      }
      console.log("");
    } else {
      console.log("   Press Ctrl+C to detach (instance will keep running)");
      console.log("");

      const result = await watchHatching(
        () => pollInstance(instanceName, project, zone, account),
        instanceName,
        startTime,
        species,
      );

      if (!result.success) {
        console.log("");
        if (result.errorContent) {
          console.log("📋 Startup error:");
          console.log(`   ${result.errorContent}`);
          console.log("");
        }

        await fetchAndDisplayStartupLogs(instanceName, project, zone, account);

        if (
          species === "vellum" &&
          (await checkCurlFailure(instanceName, project, zone, account))
        ) {
          const installScriptUrl = `${process.env.VELLUM_ASSISTANT_PLATFORM_URL ?? "https://assistant.vellum.ai"}/install.sh`;
          console.log(`🔄 Detected install script curl failure for ${installScriptUrl}, attempting recovery...`);
          await recoverFromCurlFailure(instanceName, project, zone, sshUser, account);
          console.log("✅ Recovery successful!");
        } else {
          process.exit(1);
        }
      }

      console.log("Instance details:");
      console.log(`  Name: ${instanceName}`);
      console.log(`  Project: ${project}`);
      console.log(`  Zone: ${zone}`);
      if (externalIp) {
        console.log(`  External IP: ${externalIp}`);
      }
    }
  } catch (error) {
    console.error("❌ Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
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

    const startupScript = await buildStartupScript(species, bearerToken, sshUser, anthropicApiKey);
    const startupScriptPath = join(tmpdir(), `${instanceName}-startup.sh`);
    writeFileSync(startupScriptPath, startupScript);

    try {
      console.log("📋 Uploading install script to instance...");
      await exec("scp", [
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR",
        INSTALL_SCRIPT_PATH,
        `${host}:${INSTALL_SCRIPT_REMOTE_PATH}`,
      ]);

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

function resolveGatewayDir(): string {
  const sourceDir = join(import.meta.dir, "..", "..", "..", "gateway");
  if (existsSync(sourceDir)) {
    return sourceDir;
  }

  try {
    const pkgPath = _require.resolve("@vellumai/vellum-gateway/package.json");
    return dirname(pkgPath);
  } catch {
    throw new Error(
      "Gateway not found. Ensure @vellumai/vellum-gateway is installed or run from the source tree.",
    );
  }
}

async function hatchLocal(species: Species, name: string | null): Promise<void> {
  const instanceName = name ?? `${species}-${generateRandomSuffix()}`;

  console.log(`🥚 Hatching local assistant: ${instanceName}`);
  console.log(`   Species: ${species}`);
  console.log("");

  console.log("🔨 Starting local daemon...");

  if (process.env.VELLUM_DESKTOP_APP) {
    const daemonBinary = join(dirname(process.execPath), "vellum-daemon");
    const child = spawn(daemonBinary, [], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();

    const homeDir = process.env.HOME ?? userInfo().homedir;
    const socketPath = join(homeDir, ".vellum", "vellum.sock");
    const maxWait = 10000;
    const pollInterval = 100;
    let waited = 0;
    while (waited < maxWait) {
      if (existsSync(socketPath)) {
        break;
      }
      await new Promise((r) => setTimeout(r, pollInterval));
      waited += pollInterval;
    }
    if (!existsSync(socketPath)) {
      console.warn("⚠️  Daemon socket did not appear within 10s — continuing anyway");
    }
  } else {
    const sourceTreeIndex = join(import.meta.dir, "..", "..", "..", "assistant", "src", "index.ts");
    let assistantIndex = sourceTreeIndex;

    if (!existsSync(assistantIndex)) {
      try {
        const vellumPkgPath = _require.resolve("vellum/package.json");
        assistantIndex = join(dirname(vellumPkgPath), "src", "index.ts");
      } catch {
        // resolve failed, will fall through to existsSync check below
      }
    }

    if (!existsSync(assistantIndex)) {
      throw new Error(
        "vellum-daemon binary not found and assistant source not available.\n" +
          "  Ensure the daemon binary is bundled alongside the CLI, or run from the source tree.",
      );
    }

    const child = spawn("bun", ["run", assistantIndex, "daemon", "start"], {
      stdio: "inherit",
      env: { ...process.env },
    });

    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Daemon start exited with code ${code}`));
        }
      });
      child.on("error", reject);
    });
  }

  console.log("🌐 Starting gateway...");
  const gatewayDir = resolveGatewayDir();
  const gateway = spawn("bun", ["run", "src/index.ts"], {
    cwd: gatewayDir,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      GATEWAY_RUNTIME_PROXY_ENABLED: "true",
      GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH: "false",
    },
  });
  gateway.unref();
  console.log("✅ Gateway started\n");

  const runtimeUrl = `http://localhost:${GATEWAY_PORT}`;
  const localEntry: AssistantEntry = {
    assistantId: instanceName,
    runtimeUrl,
    cloud: "local",
    species,
    hatchedAt: new Date().toISOString(),
  };
  saveAssistantEntry(localEntry);

  console.log("");
  console.log(`✅ Local assistant hatched!`);
  console.log("");
  console.log("Instance details:");
  console.log(`  Name: ${instanceName}`);
  console.log(`  Runtime: ${runtimeUrl}`);
  console.log("");
}

function getCliVersion(): string {
  try {
    const pkgPath = join(import.meta.dir, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export async function hatch(): Promise<void> {
  const cliVersion = getCliVersion();
  console.log(`@vellumai/cli v${cliVersion}`);

  const { species, detached, name, remote } = parseArgs();

  if (remote === "local") {
    await hatchLocal(species, name);
    return;
  }

  if (remote === "gcp") {
    await hatchGcp(species, detached, name);
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
