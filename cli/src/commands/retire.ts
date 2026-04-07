import {
  findAssistantByName,
  removeAssistantEntry,
} from "../lib/assistant-config";
import type { AssistantEntry } from "../lib/assistant-config";
import {
  authHeaders,
  getPlatformUrl,
  readPlatformToken,
} from "../lib/platform-client";
import { retireInstance as retireAwsInstance } from "../lib/aws";
import { retireDocker } from "../lib/docker";
import { retireInstance as retireGcpInstance } from "../lib/gcp";
import { retireLocal } from "../lib/retire-local";
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

export { retireLocal };

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

async function retireVellum(
  assistantId: string,
  runtimeUrl?: string,
): Promise<void> {
  console.log("\u{1F5D1}\ufe0f  Retiring platform-hosted instance...\n");

  const token = readPlatformToken();
  if (!token) {
    console.error(
      "Error: Not logged in. Run `vellum login --token <token>` first.",
    );
    process.exit(1);
  }

  const platformUrl = runtimeUrl || getPlatformUrl();
  const url = `${platformUrl}/v1/assistants/${encodeURIComponent(assistantId)}/retire/`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: await authHeaders(token, runtimeUrl),
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

  if (entry.runtimeBackend === "apple-containers") {
    console.error(
      `Error: '${name}' uses the apple-containers runtime. Its lifecycle is managed by the macOS app — use the app to retire it.`,
    );
    process.exit(1);
  }

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
    await retireVellum(entry.assistantId, entry.runtimeUrl);
  } else {
    console.error(`Error: Unknown cloud type '${cloud}'.`);
    process.exit(1);
  }

  removeAssistantEntry(name);
  console.log(`Removed ${name} from config.`);
}
