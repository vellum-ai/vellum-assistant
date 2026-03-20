import { spawn } from "child_process";

import {
  findAssistantByName,
  loadLatestAssistant,
} from "../lib/assistant-config";
import type { AssistantEntry } from "../lib/assistant-config";
import { dockerResourceNames } from "../lib/docker";

const SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "LogLevel=ERROR",
];

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

export async function ssh(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum ssh [<name>]");
    console.log("");
    console.log("SSH into a remote assistant instance.");
    console.log("");
    console.log("Arguments:");
    console.log(
      "  <name>    Name of the assistant to connect to (defaults to latest)",
    );
    process.exit(0);
  }

  const name = process.argv[3];
  const entry = name ? findAssistantByName(name) : loadLatestAssistant();

  if (!entry) {
    if (name) {
      console.error(`No assistant instance found with name '${name}'.`);
    } else {
      console.error("No assistant instance found. Run `vellum hatch` first.");
    }
    process.exit(1);
  }

  const cloud = resolveCloud(entry);

  if (cloud === "local") {
    console.error(
      "Cannot SSH into a local assistant. Local assistants run directly on this machine.\n" +
        `Use 'vellum ps ${entry.assistantId}' to check its processes instead.`,
    );
    process.exit(1);
  }

  if (cloud === "aws") {
    console.error("SSH to AWS instances is not yet supported.");
    process.exit(1);
  }

  let child;

  if (cloud === "docker") {
    const res = dockerResourceNames(entry.assistantId);
    console.log(`🔗 Connecting to ${entry.assistantId} via docker exec...\n`);

    child = spawn(
      "docker",
      ["exec", "-it", res.assistantContainer, "/bin/sh"],
      { stdio: "inherit" },
    );
  } else if (cloud === "gcp") {
    const project = entry.project;
    const zone = entry.zone;
    if (!project || !zone) {
      console.error(
        "Error: GCP project and zone not found in assistant config.",
      );
      process.exit(1);
    }

    const sshTarget = entry.sshUser
      ? `${entry.sshUser}@${entry.assistantId}`
      : entry.assistantId;

    console.log(`🔗 Connecting to ${entry.assistantId} via gcloud...\n`);

    child = spawn(
      "gcloud",
      ["compute", "ssh", sshTarget, `--project=${project}`, `--zone=${zone}`],
      { stdio: "inherit" },
    );
  } else if (cloud === "vellum") {
    console.error("SSH to Vellum-managed instances is not yet supported.");
    process.exit(1);
  } else if (cloud === "custom") {
    const host = extractHostFromUrl(entry.runtimeUrl);
    const sshUser = entry.sshUser ?? "root";
    const sshTarget = `${sshUser}@${host}`;

    console.log(`🔗 Connecting to ${entry.assistantId} via ssh...\n`);

    child = spawn("ssh", [...SSH_OPTS, sshTarget], { stdio: "inherit" });
  } else {
    console.error(`Error: Unknown cloud type '${cloud}'.`);
    process.exit(1);
  }

  await new Promise<void>((resolve, reject) => {
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ssh exited with code ${code}`));
      }
    });
    child.on("error", reject);
  });
}
