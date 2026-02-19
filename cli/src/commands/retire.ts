import { spawn } from "child_process";
import { rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { findAssistantByName, removeAssistantEntry } from "../lib/assistant-config";
import type { AssistantEntry } from "../lib/assistant-config";
import { retireInstance as retireAwsInstance } from "../lib/aws";
import { retireInstance as retireGcpInstance } from "../lib/gcp";
import { exec } from "../lib/step-runner";

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

async function retireLocal(): Promise<void> {
  console.log("\u{1F5D1}\ufe0f  Stopping local daemon...\n");

  try {
    const child = spawn("bunx", ["vellum", "daemon", "stop"], {
      stdio: "inherit",
    });

    await new Promise<void>((resolve) => {
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });
  } catch {}

  try {
    const killGateway = spawn("pkill", ["-f", "gateway/src/index.ts"], {
      stdio: "ignore",
    });

    await new Promise<void>((resolve) => {
      killGateway.on("close", () => resolve());
      killGateway.on("error", () => resolve());
    });
  } catch {}

  const vellumDir = join(homedir(), ".vellum");
  rmSync(vellumDir, { recursive: true, force: true });
  console.log("\u2705 Local instance retired.");
}

async function retireCustom(entry: AssistantEntry): Promise<void> {
  const host = extractHostFromUrl(entry.runtimeUrl);
  const sshUser = entry.sshUser ?? "root";
  const sshHost = `${sshUser}@${host}`;

  console.log(`\u{1F5D1}\ufe0f  Retiring custom instance on ${sshHost}...\n`);

  const remoteCmd = [
    "bunx vellum daemon stop 2>/dev/null || true",
    "pkill -f gateway 2>/dev/null || true",
    "rm -rf ~/.vellum",
  ].join(" && ");

  try {
    await exec("ssh", [
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=10",
      "-o", "LogLevel=ERROR",
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

export async function retire(): Promise<void> {
  const name = process.argv[3];

  if (!name) {
    console.error("Error: Instance name is required.");
    console.error("Usage: vellum-cli retire <name>");
    process.exit(1);
  }

  const entry = findAssistantByName(name);
  if (!entry) {
    console.error(`No assistant found with name '${name}'.`);
    console.error("Run 'vellum-cli hatch' first, or check the instance name.");
    process.exit(1);
  }

  const cloud = resolveCloud(entry);

  if (cloud === "gcp") {
    const project = entry.project;
    const zone = entry.zone;
    if (!project || !zone) {
      console.error("Error: GCP project and zone not found in assistant config.");
      process.exit(1);
    }
    await retireGcpInstance(name, project, zone);
  } else if (cloud === "aws") {
    const region = entry.region;
    if (!region) {
      console.error("Error: AWS region not found in assistant config.");
      process.exit(1);
    }
    await retireAwsInstance(name, region);
  } else if (cloud === "local") {
    await retireLocal();
  } else if (cloud === "custom") {
    await retireCustom(entry);
  } else {
    console.error(`Error: Unknown cloud type '${cloud}'.`);
    process.exit(1);
  }

  removeAssistantEntry(name);
  console.log(`Removed ${name} from config.`);
}
