import { existsSync, unlinkSync } from "fs";
import { join } from "path";

import {
  extractHostFromUrl,
  formatAssistantLookupError,
  formatAssistantReference,
  getAssistantDisplayName,
  loadAllAssistants,
  lookupAssistantByIdentifier,
  removeAssistantEntry,
  resolveCloud,
  type AssistantEntry,
} from "../lib/assistant-config.js";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import {
  canPromptForConfirmation,
  confirmAction,
} from "../lib/confirm-action.js";
import { getConfigDir } from "../lib/environments/paths.js";
import { getCurrentEnvironment } from "../lib/environments/resolve.js";
import {
  authHeaders,
  getPlatformUrl,
  readPlatformToken,
} from "../lib/platform-client.js";
import { retireInstance as retireAwsInstance } from "../lib/aws.js";
import { retireDocker } from "../lib/docker.js";
import { retireInstance as retireGcpInstance } from "../lib/gcp.js";
import { retireLocal } from "../lib/retire-local.js";
import { retireAppleContainer } from "../lib/retire-apple-container.js";
import { exec } from "../lib/step-runner.js";
import {
  openLogFile,
  closeLogFile,
  resetLogFile,
  writeToLogFile,
} from "../lib/xdg-log.js";
import { loopbackSafeFetch } from "../lib/loopback-fetch.js";

export { retireLocal };

interface RetireArgs {
  name?: string;
  source?: string;
  yes: boolean;
}

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
  const response = await loopbackSafeFetch(url, {
    method: "DELETE",
    headers: await authHeaders(token, runtimeUrl),
  });

  // Treat 404 as success: the assistant is already gone from the platform
  // (previously retired, deleted from the web UI, or retired from another
  // device) so the caller's job is done. Falling through to the lockfile
  // cleanup avoids leaving a stale entry that would otherwise wedge the
  // macOS app in a permanent health-check loop.
  if (!response.ok && response.status !== 404) {
    const body = await response.text();
    console.error(
      `Error: Platform retire failed (${response.status}): ${body}`,
    );
    process.exit(1);
  }

  if (response.status === 404) {
    console.log(
      "\u2705 Platform-hosted instance already retired (404) — cleaning up local state.",
    );
  } else {
    console.log("\u2705 Platform-hosted instance retired.");
  }
}

function parseRetireArgs(args: string[]): RetireArgs {
  let source: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source" && args[i + 1]) {
      source = args[i + 1];
      i++;
    }
  }

  return {
    name: parseAssistantTargetArg(args, ["--source"]),
    source,
    yes: args.includes("--yes"),
  };
}

function formatRuntimeUrl(entry: AssistantEntry): string {
  return entry.localUrl ?? entry.runtimeUrl;
}

function printRetireTarget(entry: AssistantEntry, cloud: string): void {
  const displayName = getAssistantDisplayName(entry);

  console.log("Assistant to retire:");
  if (displayName !== entry.assistantId) {
    console.log(`  Name: ${displayName}`);
  }
  console.log(`  ID: ${entry.assistantId}`);
  console.log(`  Cloud: ${cloud}`);
  console.log(`  Runtime: ${formatRuntimeUrl(entry)}`);
  console.log("");
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
    console.log(
      "Usage: vellum retire <name-or-id> [--source <source>] [--yes]",
    );
    console.log("");
    console.log("Delete an assistant instance and archive its data.");
    console.log(
      "By default, retire prints the assistant name, ID, cloud, and runtime before asking for confirmation.",
    );
    console.log("");
    console.log("Arguments:");
    console.log(
      "  <name-or-id>         Assistant display name or ID to retire",
    );
    console.log("");
    console.log("Options:");
    console.log("  --source <source>    Source identifier for the retirement");
    console.log(
      "  --yes                Skip the interactive confirmation prompt",
    );
    process.exit(0);
  }

  const parsed = parseRetireArgs(args);
  const name = parsed.name;

  if (!name) {
    console.error("Error: Assistant name or ID is required.");
    console.error(
      "Usage: vellum retire <name-or-id> [--source <source>] [--yes]",
    );
    process.exit(1);
  }

  const lookup = lookupAssistantByIdentifier(name);
  if (lookup.status !== "found") {
    console.error(formatAssistantLookupError(name, lookup));
    console.error("Run 'vellum hatch' first, or check the instance name.");
    process.exit(1);
  }

  const entry = lookup.entry;
  const assistantId = entry.assistantId;
  const source = parsed.source;
  const cloud = resolveCloud(entry);

  if (cloud === "paired") {
    // A remote assistant paired from another machine. Retiring tears the
    // assistant down — that can only happen on its host machine, never from a
    // paired machine, which holds nothing but a pairing record. (Removing that
    // local record is `vellum unpair`'s job, not retire's.)
    console.error(
      `Error: '${assistantId}' is a remote assistant paired from another machine — it can't be retired from here. Retiring tears down the assistant, which can only be done on its host machine. To remove the local pairing record on this machine, run \`vellum unpair ${assistantId}\`.`,
    );
    process.exit(1);
  }

  printRetireTarget(entry, cloud);

  if (!parsed.yes) {
    if (!canPromptForConfirmation()) {
      console.error(
        "Error: Refusing to retire without confirmation in a non-interactive terminal.",
      );
      console.error("Re-run with --yes to confirm from automation.");
      process.exit(1);
    }

    const confirmed = await confirmAction(
      "Press Enter to retire, or Esc/q to cancel: ",
    );
    if (!confirmed) {
      console.log("Retire cancelled.");
      process.exit(1);
    }
  }

  if (cloud === "apple-container") {
    await retireAppleContainer(assistantId, entry);
  } else if (cloud === "gcp") {
    const project = entry.project;
    const zone = entry.zone;
    if (!project || !zone) {
      console.error(
        "Error: GCP project and zone not found in assistant config.",
      );
      process.exit(1);
    }
    await retireGcpInstance(assistantId, project, zone, source);
  } else if (cloud === "aws") {
    const region = entry.region;
    if (!region) {
      console.error("Error: AWS region not found in assistant config.");
      process.exit(1);
    }
    await retireAwsInstance(assistantId, region, source);
  } else if (cloud === "docker") {
    await retireDocker(assistantId);
  } else if (cloud === "local") {
    await retireLocal(assistantId, entry);
  } else if (cloud === "custom") {
    await retireCustom(entry);
  } else if (cloud === "vellum") {
    await retireVellum(assistantId, entry.runtimeUrl);
  } else {
    console.error(`Error: Unknown cloud type '${cloud}'.`);
    process.exit(1);
  }

  removeAssistantEntry(assistantId);
  console.log(`Removed ${formatAssistantReference(entry)} from config.`);

  // When no assistants remain, remove the dock-display-name sentinel so
  // the next build.sh run falls back to "Vellum" instead of using the
  // retired assistant's name.
  if (loadAllAssistants().length === 0) {
    const dockLabelFile = join(
      getConfigDir(getCurrentEnvironment()),
      "dock-display-name",
    );
    if (existsSync(dockLabelFile)) {
      try {
        unlinkSync(dockLabelFile);
      } catch {
        // Best-effort — the macOS app will also reset this on next launch.
      }
    }
  }
}
