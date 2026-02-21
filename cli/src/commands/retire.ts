import { spawn } from "child_process";
import { rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { findAssistantByName, removeAssistantEntry } from "../lib/assistant-config";
import type { AssistantEntry } from "../lib/assistant-config";
import { retireInstance as retireAwsInstance } from "../lib/aws";
import { retireInstance as retireGcpInstance } from "../lib/gcp";
import { stopProcessByPidFile } from "../lib/process";
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

  const vellumDir = join(homedir(), ".vellum");
  const isDesktopApp = !!process.env.VELLUM_DESKTOP_APP;

  // Stop daemon via PID file
  const daemonPidFile = join(vellumDir, "vellum.pid");
  const socketFile = join(vellumDir, "vellum.sock");
  await stopProcessByPidFile(daemonPidFile, "daemon", [socketFile]);

  // Stop gateway via PID file
  const gatewayPidFile = join(vellumDir, "gateway.pid");
  await stopProcessByPidFile(gatewayPidFile, "gateway");

  if (!isDesktopApp) {
    // Non-desktop: also stop daemon via bunx (fallback)
    try {
      const child = spawn("bunx", ["vellum", "daemon", "stop"], {
        stdio: "inherit",
      });

      await new Promise<void>((resolve) => {
        child.on("close", () => resolve());
        child.on("error", () => resolve());
      });
    } catch {}

    // Only delete ~/.vellum in non-desktop mode
    rmSync(vellumDir, { recursive: true, force: true });
  }

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

function parseSource(): string | undefined {
  const args = process.argv.slice(4);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source" && args[i + 1]) {
      return args[i + 1];
    }
  }
  return undefined;
}

function debug(msg: string): void {
  console.error(`[retire-debug] ${msg}`);
}

export async function retire(): Promise<void> {
  const name = process.argv[3];
  debug(`argv: ${JSON.stringify(process.argv)}`);
  debug(`HOME=${process.env.HOME}, VELLUM_DESKTOP_APP=${process.env.VELLUM_DESKTOP_APP}`);
  debug(`PATH=${process.env.PATH}`);
  debug(`CLOUDSDK_CONFIG=${process.env.CLOUDSDK_CONFIG}, GOOGLE_APPLICATION_CREDENTIALS=${process.env.GOOGLE_APPLICATION_CREDENTIALS}, GCP_ACCOUNT_EMAIL=${process.env.GCP_ACCOUNT_EMAIL}`);

  if (!name) {
    console.error("Error: Instance name is required.");
    console.error("Usage: vellum-cli retire <name> [--source <source>]");
    process.exit(1);
  }

  debug(`Looking up assistant entry for name='${name}' in lockfile at ${join(homedir(), ".vellum.lock.json")}`);
  const entry = findAssistantByName(name);
  if (!entry) {
    debug(`No entry found in lockfile for '${name}'`);
    console.error(`No assistant found with name '${name}'.`);
    console.error("Run 'vellum-cli hatch' first, or check the instance name.");
    process.exit(1);
  }
  debug(`Found entry: ${JSON.stringify(entry)}`);

  const source = parseSource();
  const cloud = resolveCloud(entry);
  debug(`Resolved cloud='${cloud}', source='${source}'`);

  if (cloud === "gcp") {
    const project = entry.project;
    const zone = entry.zone;
    if (!project || !zone) {
      console.error("Error: GCP project and zone not found in assistant config.");
      process.exit(1);
    }
    debug(`Calling retireGcpInstance(name='${name}', project='${project}', zone='${zone}', source='${source}')`);
    await retireGcpInstance(name, project, zone, source);
    debug(`retireGcpInstance completed successfully`);
  } else if (cloud === "aws") {
    const region = entry.region;
    if (!region) {
      console.error("Error: AWS region not found in assistant config.");
      process.exit(1);
    }
    await retireAwsInstance(name, region, source);
  } else if (cloud === "local") {
    await retireLocal();
  } else if (cloud === "custom") {
    await retireCustom(entry);
  } else {
    console.error(`Error: Unknown cloud type '${cloud}'.`);
    process.exit(1);
  }

  removeAssistantEntry(name);
  debug(`Removed '${name}' from lockfile, exiting 0`);
  console.log(`Removed ${name} from config.`);
}
