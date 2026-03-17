import cliPkg from "../../package.json";

import {
  findAssistantByName,
  loadAllAssistants,
  getActiveAssistant,
} from "../lib/assistant-config";
import type { AssistantEntry } from "../lib/assistant-config";
import { dockerResourceNames } from "../lib/docker";
import {
  fetchOrganizationId,
  getPlatformUrl,
  readPlatformToken,
} from "../lib/platform-client";
import { exec } from "../lib/step-runner";

type ServiceName = "assistant" | "credential-executor" | "gateway";

const DOCKERHUB_ORG = "vellumai";
const DOCKERHUB_IMAGES: Record<ServiceName, string> = {
  assistant: `${DOCKERHUB_ORG}/vellum-assistant`,
  "credential-executor": `${DOCKERHUB_ORG}/vellum-credential-executor`,
  gateway: `${DOCKERHUB_ORG}/vellum-gateway`,
};

/** Internal ports exposed by each service's Dockerfile. */
const ASSISTANT_INTERNAL_PORT = 3001;
const GATEWAY_INTERNAL_PORT = 7830;

interface UpgradeArgs {
  name: string | null;
  version: string | null;
}

function parseArgs(): UpgradeArgs {
  const args = process.argv.slice(3);
  let name: string | null = null;
  let version: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: vellum upgrade [<name>] [options]");
      console.log("");
      console.log("Upgrade an assistant to the latest version.");
      console.log("");
      console.log("Arguments:");
      console.log(
        "  <name>               Name of the assistant to upgrade (default: active or only assistant)",
      );
      console.log("");
      console.log("Options:");
      console.log(
        "  --version <version>  Target version to upgrade to (default: latest)",
      );
      console.log("");
      console.log("Examples:");
      console.log(
        "  vellum upgrade                              # Upgrade the active assistant to the latest version",
      );
      console.log(
        "  vellum upgrade my-assistant                  # Upgrade a specific assistant by name",
      );
      console.log(
        "  vellum upgrade my-assistant --version v1.2.3 # Upgrade to a specific version",
      );
      process.exit(0);
    } else if (arg === "--version") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --version requires a value");
        process.exit(1);
      }
      version = next;
      i++;
    } else if (!arg.startsWith("-")) {
      name = arg;
    } else {
      console.error(`Error: Unknown option '${arg}'.`);
      process.exit(1);
    }
  }

  return { name, version };
}

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

/**
 * Resolve which assistant to target for the upgrade command. Priority:
 * 1. Explicit name argument
 * 2. Active assistant set via `vellum use`
 * 3. Sole assistant (when exactly one exists)
 */
function resolveTargetAssistant(nameArg: string | null): AssistantEntry {
  if (nameArg) {
    const entry = findAssistantByName(nameArg);
    if (!entry) {
      console.error(`No assistant found with name '${nameArg}'.`);
      process.exit(1);
    }
    return entry;
  }

  const active = getActiveAssistant();
  if (active) {
    const entry = findAssistantByName(active);
    if (entry) return entry;
  }

  const all = loadAllAssistants();
  if (all.length === 1) return all[0];

  if (all.length === 0) {
    console.error("No assistants found. Run 'vellum hatch' first.");
  } else {
    console.error(
      "Multiple assistants found. Specify a name or set an active assistant with 'vellum use <name>'.",
    );
  }
  process.exit(1);
}

async function upgradeDocker(
  entry: AssistantEntry,
  version: string | null,
): Promise<void> {
  const instanceName = entry.assistantId;
  const res = dockerResourceNames(instanceName);

  const versionTag =
    version ?? (cliPkg.version ? `v${cliPkg.version}` : "latest");
  const imageTags: Record<ServiceName, string> = {
    assistant: `${DOCKERHUB_IMAGES.assistant}:${versionTag}`,
    "credential-executor": `${DOCKERHUB_IMAGES["credential-executor"]}:${versionTag}`,
    gateway: `${DOCKERHUB_IMAGES.gateway}:${versionTag}`,
  };

  console.log(
    `🔄 Upgrading Docker assistant '${instanceName}' to ${versionTag}...\n`,
  );

  console.log("📦 Pulling new Docker images...");
  await exec("docker", ["pull", imageTags.assistant]);
  await exec("docker", ["pull", imageTags.gateway]);
  await exec("docker", ["pull", imageTags["credential-executor"]]);
  console.log("✅ Docker images pulled\n");

  console.log("🛑 Stopping existing containers...");
  for (const container of [
    res.cesContainer,
    res.gatewayContainer,
    res.assistantContainer,
  ]) {
    try {
      await exec("docker", ["stop", container]);
    } catch {
      // container may not be running
    }
    try {
      await exec("docker", ["rm", container]);
    } catch {
      // container may not exist
    }
  }
  console.log("✅ Containers stopped\n");

  console.log("🚀 Starting upgraded containers...");

  // Parse gateway port from entry's runtimeUrl, fall back to default
  let gatewayPort = GATEWAY_INTERNAL_PORT;
  try {
    const parsed = new URL(entry.runtimeUrl);
    const port = parseInt(parsed.port, 10);
    if (!isNaN(port)) {
      gatewayPort = port;
    }
  } catch {
    // use default
  }

  await exec("docker", [
    "run",
    "--init",
    "-d",
    "--name",
    res.assistantContainer,
    `--network=${res.network}`,
    "-v",
    `${res.dataVolume}:/data`,
    "-v",
    `${res.socketVolume}:/run/ces-bootstrap`,
    "-e",
    `VELLUM_ASSISTANT_NAME=${instanceName}`,
    "-e",
    "RUNTIME_HTTP_HOST=0.0.0.0",
    ...(process.env.ANTHROPIC_API_KEY
      ? ["-e", `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`]
      : []),
    ...(process.env.VELLUM_PLATFORM_URL
      ? ["-e", `VELLUM_PLATFORM_URL=${process.env.VELLUM_PLATFORM_URL}`]
      : []),
    imageTags.assistant,
  ]);

  await exec("docker", [
    "run",
    "--init",
    "-d",
    "--name",
    res.gatewayContainer,
    `--network=${res.network}`,
    "-p",
    `${gatewayPort}:${GATEWAY_INTERNAL_PORT}`,
    "-v",
    `${res.dataVolume}:/data`,
    "-e",
    "BASE_DATA_DIR=/data",
    "-e",
    `GATEWAY_PORT=${GATEWAY_INTERNAL_PORT}`,
    "-e",
    `ASSISTANT_HOST=${res.assistantContainer}`,
    "-e",
    `RUNTIME_HTTP_PORT=${ASSISTANT_INTERNAL_PORT}`,
    imageTags.gateway,
  ]);

  await exec("docker", [
    "run",
    "--init",
    "-d",
    "--name",
    res.cesContainer,
    `--network=${res.network}`,
    "-v",
    `${res.socketVolume}:/run/ces-bootstrap`,
    "-v",
    `${res.dataVolume}:/data:ro`,
    "-e",
    "CES_MODE=managed",
    "-e",
    "CES_BOOTSTRAP_SOCKET_DIR=/run/ces-bootstrap",
    "-e",
    "CES_ASSISTANT_DATA_MOUNT=/data",
    imageTags["credential-executor"],
  ]);

  console.log("✅ Containers started\n");
  console.log(
    `✅ Docker assistant '${instanceName}' upgraded to ${versionTag}.`,
  );
}

interface UpgradeApiResponse {
  detail: string;
  version: string | null;
}

async function upgradePlatform(
  entry: AssistantEntry,
  version: string | null,
): Promise<void> {
  console.log(
    `🔄 Upgrading platform-hosted assistant '${entry.assistantId}'...\n`,
  );

  const token = readPlatformToken();
  if (!token) {
    console.error(
      "Error: Not logged in. Run `vellum login --token <token>` first.",
    );
    process.exit(1);
  }

  const orgId = await fetchOrganizationId(token);

  const url = `${getPlatformUrl()}/v1/assistants/upgrade/`;
  const body: { version?: string } = {};
  if (version) {
    body.version = version;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": token,
      "Vellum-Organization-Id": orgId,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(
      `Error: Platform upgrade failed (${response.status}): ${text}`,
    );
    process.exit(1);
  }

  const result = (await response.json()) as UpgradeApiResponse;
  console.log(`✅ ${result.detail}`);
  if (result.version) {
    console.log(`   Version: ${result.version}`);
  }
}

export async function upgrade(): Promise<void> {
  const { name, version } = parseArgs();
  const entry = resolveTargetAssistant(name);
  const cloud = resolveCloud(entry);

  if (cloud === "docker") {
    await upgradeDocker(entry, version);
    return;
  }

  if (cloud === "vellum") {
    await upgradePlatform(entry, version);
    return;
  }

  console.error(
    `Error: Upgrade is not supported for '${cloud}' assistants. Only 'docker' and 'vellum' assistants can be upgraded via the CLI.`,
  );
  process.exit(1);
}
