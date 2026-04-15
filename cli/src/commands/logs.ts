import { spawn } from "child_process";
import { createReadStream, existsSync, statSync } from "fs";
import { createInterface } from "readline";
import { watch } from "fs";
import { join } from "path";

import {
  findAssistantByName,
  loadLatestAssistant,
} from "../lib/assistant-config";
import type { AssistantEntry } from "../lib/assistant-config";
import { dockerResourceNames } from "../lib/docker";
import { getLogDir } from "../lib/xdg-log";
import { execOutput } from "../lib/step-runner";

// ── Arg parsing ─────────────────────────────────────────────────

interface LogsArgs {
  name?: string;
  follow: boolean;
  tail?: number;
  timestamps: boolean;
  since?: string;
  until?: string;
  service?: string;
}

function printHelp(): void {
  console.log("Usage: vellum logs [<name>] [options]");
  console.log("");
  console.log("View logs from an assistant instance.");
  console.log("");
  console.log("Arguments:");
  console.log(
    "  <name>                Name of the assistant (defaults to latest)",
  );
  console.log("");
  console.log("Options:");
  console.log("  -f, --follow          Follow log output (stream new lines)");
  console.log("  -n, --tail <N>        Show last N lines (default: all)");
  console.log("  -t, --timestamps      Show timestamps on each line");
  console.log(
    "  --since <time>        Show logs since timestamp or relative (e.g. 10m, 2h)",
  );
  console.log("  --until <time>        Show logs until timestamp or relative");
  console.log(
    "  -s, --service <name>  Filter to a specific service (e.g. assistant, gateway)",
  );
  console.log("  -h, --help            Show this help");
}

function parseArgs(): LogsArgs {
  const args = process.argv.slice(3);
  const result: LogsArgs = {
    follow: false,
    timestamps: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "-f" || arg === "--follow") {
      result.follow = true;
    } else if (arg === "-t" || arg === "--timestamps") {
      result.timestamps = true;
    } else if (arg === "-n" || arg === "--tail") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --tail requires a numeric value");
        process.exit(1);
      }
      const n = parseInt(next, 10);
      if (isNaN(n) || n < 0) {
        console.error("Error: --tail must be a non-negative integer");
        process.exit(1);
      }
      result.tail = n;
      i++;
    } else if (arg === "--since") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --since requires a value");
        process.exit(1);
      }
      result.since = next;
      i++;
    } else if (arg === "--until") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --until requires a value");
        process.exit(1);
      }
      result.until = next;
      i++;
    } else if (arg === "-s" || arg === "--service") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --service requires a value");
        process.exit(1);
      }
      result.service = next;
      i++;
    } else if (!arg.startsWith("-") && !result.name) {
      result.name = arg;
    } else {
      console.error(`Error: Unknown argument '${arg}'`);
      process.exit(1);
    }
  }

  return result;
}

// ── Helpers ─────────────────────────────────────────────────────

function resolveCloud(entry: AssistantEntry): string {
  if (entry.cloud) return entry.cloud;
  if (entry.project) return "gcp";
  if (entry.sshUser) return "custom";
  return "local";
}

/**
 * Parse a relative time string like "10m", "2h", "30s" into a Date.
 * Returns null if the string doesn't look like a relative time.
 */
function parseRelativeTime(input: string): Date | null {
  const match = input.match(/^(\d+)([smhd])$/);
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const now = Date.now();
  const ms: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return new Date(now - amount * (ms[unit] ?? 0));
}

/**
 * Parse a --since/--until value into a Date.
 * Accepts relative times (10m, 2h) or ISO timestamps.
 */
function parseTimeFilter(input: string): Date | null {
  const relative = parseRelativeTime(input);
  if (relative) return relative;
  const date = new Date(input);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Extract the ISO timestamp from a log line that starts with one.
 * Local log lines have format: `2024-01-15T10:30:00.000Z [tag] message`
 */
function extractTimestamp(line: string): Date | null {
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[\d.]*Z?)\s/);
  if (!match) return null;
  const date = new Date(match[1]);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Extract the service tag from a local log line.
 * Format: `2024-01-15T10:30:00.000Z [daemon] message` → "daemon"
 */
function extractServiceTag(line: string): string | null {
  const match = line.match(/^\S+\s+\[(\w+[-\w]*)\]\s/);
  return match ? match[1] : null;
}

// ── Local topology ──────────────────────────────────────────────

async function showLocalLogs(
  entry: AssistantEntry,
  opts: LogsArgs,
): Promise<void> {
  const logDir = getLogDir();
  const logFile = join(logDir, "hatch.log");

  if (!existsSync(logFile)) {
    console.error(
      `No log file found at ${logFile}. Has the assistant been started?`,
    );
    process.exit(1);
  }

  const sinceDate = opts.since ? parseTimeFilter(opts.since) : null;
  const untilDate = opts.until ? parseTimeFilter(opts.until) : null;

  if (opts.since && !sinceDate) {
    console.error(
      `Error: Could not parse --since value '${opts.since}'. Use relative (e.g. 10m, 2h) or ISO format.`,
    );
    process.exit(1);
  }
  if (opts.until && !untilDate) {
    console.error(
      `Error: Could not parse --until value '${opts.until}'. Use relative (e.g. 10m, 2h) or ISO format.`,
    );
    process.exit(1);
  }

  function matchesFilters(line: string): boolean {
    if (opts.service) {
      const tag = extractServiceTag(line);
      if (tag && tag !== opts.service) return false;
    }
    if (sinceDate || untilDate) {
      const ts = extractTimestamp(line);
      if (ts) {
        if (sinceDate && ts < sinceDate) return false;
        if (untilDate && ts > untilDate) return false;
      }
    }
    return true;
  }

  // Read existing file content
  const lines: string[] = [];
  const rl = createInterface({
    input: createReadStream(logFile, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!matchesFilters(line)) continue;
    lines.push(line);
  }

  // Apply --tail (explicit check for 0 since slice(-0) returns the whole array)
  const output =
    opts.tail != null
      ? opts.tail === 0
        ? []
        : lines.slice(-opts.tail)
      : lines;
  for (const line of output) {
    console.log(line);
  }

  // Follow mode: watch for changes
  if (opts.follow) {
    let fileSize = statSync(logFile).size;

    watch(logFile, () => {
      let newSize: number;
      try {
        newSize = statSync(logFile).size;
      } catch {
        return;
      }
      if (newSize <= fileSize) {
        fileSize = newSize;
        return;
      }

      const stream = createReadStream(logFile, {
        start: fileSize,
        encoding: "utf-8",
      });
      const followRl = createInterface({
        input: stream,
        crlfDelay: Infinity,
      });

      followRl.on("line", (line: string) => {
        if (matchesFilters(line)) {
          console.log(line);
        }
      });

      followRl.on("close", () => {
        try {
          fileSize = statSync(logFile).size;
        } catch {
          // File may have been removed
        }
      });
    });

    // Keep process alive
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        resolve();
      });
      process.on("SIGTERM", () => {
        resolve();
      });
    });
  }
}

// ── Docker topology ─────────────────────────────────────────────

async function showDockerLogs(
  entry: AssistantEntry,
  opts: LogsArgs,
): Promise<void> {
  const res = dockerResourceNames(entry.assistantId);

  const containers: { name: string; containerName: string }[] = [
    { name: "assistant", containerName: res.assistantContainer },
    { name: "gateway", containerName: res.gatewayContainer },
    { name: "credential-executor", containerName: res.cesContainer },
  ];

  // Filter to specific service if requested
  const targets = opts.service
    ? containers.filter((c) => c.name === opts.service)
    : containers;

  if (targets.length === 0) {
    console.error(
      `Unknown service '${opts.service}'. Available: ${containers.map((c) => c.name).join(", ")}`,
    );
    process.exit(1);
  }

  // Build docker logs args
  function buildDockerArgs(containerName: string): string[] {
    const args = ["logs"];
    if (opts.follow) args.push("--follow");
    if (opts.tail != null) args.push("--tail", String(opts.tail));
    if (opts.timestamps) args.push("--timestamps");
    if (opts.since) args.push("--since", opts.since);
    if (opts.until) args.push("--until", opts.until);
    args.push(containerName);
    return args;
  }

  if (targets.length === 1) {
    // Single container — stream directly to stdout/stderr
    const target = targets[0];
    const args = buildDockerArgs(target.containerName);
    const child = spawn("docker", args, { stdio: "inherit" });

    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code === 0 || (opts.follow && code === null)) {
          resolve();
        } else {
          reject(
            new Error(
              `docker logs for ${target.name} exited with code ${code}`,
            ),
          );
        }
      });
      child.on("error", (err) => {
        if (err.message.includes("ENOENT")) {
          console.error("Error: docker is not installed or not on PATH.");
        }
        reject(err);
      });
    });
  } else {
    // Multiple containers — prefix each line with service name
    const children = targets.map((target) => {
      const args = buildDockerArgs(target.containerName);
      const child = spawn("docker", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      const prefix = `[${target.name}] `;

      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
        const rl = createInterface({
          input: stream,
          crlfDelay: Infinity,
        });
        rl.on("line", (line: string) => {
          console.log(prefix + line);
        });
      }

      return { target, child };
    });

    // Wait for all children to exit and track failures
    const errors: string[] = [];
    await Promise.all(
      children.map(
        ({ target, child }) =>
          new Promise<void>((resolve) => {
            child.on("close", (code) => {
              if (code !== 0 && code !== null) {
                errors.push(
                  `docker logs for ${target.name} exited with code ${code}`,
                );
              }
              resolve();
            });
            child.on("error", (err) => {
              errors.push(
                `docker logs for ${target.name} failed: ${err.message}`,
              );
              resolve();
            });
          }),
      ),
    );
    if (errors.length > 0) {
      for (const msg of errors) {
        console.error(msg);
      }
      process.exit(1);
    }
  }
}

// ── Remote topologies (GCP / Custom / AWS) ──────────────────────

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

function buildRemoteLogCommand(opts: LogsArgs): string {
  const logFile = "/var/log/startup-script.log";
  const parts: string[] = [];

  if (opts.follow) {
    const tailN = opts.tail != null ? `-n ${opts.tail}` : "-n +1";
    parts.push(`tail ${tailN} -f ${logFile}`);
  } else if (opts.tail != null) {
    parts.push(`tail -n ${opts.tail} ${logFile}`);
  } else {
    parts.push(`cat ${logFile}`);
  }

  return parts.join(" ");
}

async function showGcpLogs(
  entry: AssistantEntry,
  opts: LogsArgs,
): Promise<void> {
  const project = entry.project;
  const zone = entry.zone;
  if (!project || !zone) {
    console.error("Error: GCP project and zone not found in assistant config.");
    process.exit(1);
  }

  const remoteCmd = buildRemoteLogCommand(opts);
  const sshTarget = entry.sshUser
    ? `${entry.sshUser}@${entry.assistantId}`
    : entry.assistantId;

  const args = [
    "compute",
    "ssh",
    sshTarget,
    `--project=${project}`,
    `--zone=${zone}`,
    "--ssh-flag=-o StrictHostKeyChecking=no",
    "--ssh-flag=-o UserKnownHostsFile=/dev/null",
    "--ssh-flag=-o ConnectTimeout=10",
    "--ssh-flag=-o LogLevel=ERROR",
    `--command=${remoteCmd}`,
  ];

  if (opts.follow) {
    // For follow mode, stream output directly to terminal
    const child = spawn("gcloud", args, { stdio: "inherit" });
    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`gcloud ssh exited with code ${code}`));
        } else {
          resolve();
        }
      });
      child.on("error", (err) => reject(err));
    });
  } else {
    try {
      const output = await execOutput("gcloud", args);
      console.log(output);
    } catch (err) {
      console.error(
        `Failed to fetch logs: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }
  }
}

function extractHostFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return url.replace(/^https?:\/\//, "").split(":")[0];
  }
}

async function showCustomLogs(
  entry: AssistantEntry,
  opts: LogsArgs,
): Promise<void> {
  const host = extractHostFromUrl(entry.runtimeUrl);
  const sshUser = entry.sshUser ?? "root";
  const sshTarget = `${sshUser}@${host}`;

  const remoteCmd = buildRemoteLogCommand(opts);

  if (opts.follow) {
    const child = spawn("ssh", [...SSH_OPTS, sshTarget, remoteCmd], {
      stdio: "inherit",
    });
    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`ssh exited with code ${code}`));
        } else {
          resolve();
        }
      });
      child.on("error", (err) => reject(err));
    });
  } else {
    try {
      const output = await execOutput("ssh", [
        ...SSH_OPTS,
        sshTarget,
        remoteCmd,
      ]);
      console.log(output);
    } catch (err) {
      console.error(
        `Failed to fetch logs: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }
  }
}

async function showAwsLogs(
  entry: AssistantEntry,
  opts: LogsArgs,
): Promise<void> {
  const host = extractHostFromUrl(entry.runtimeUrl);
  const sshUser = entry.sshUser ?? "admin";
  const sshTarget = `${sshUser}@${host}`;

  const remoteCmd = buildRemoteLogCommand(opts);

  if (opts.follow) {
    const child = spawn("ssh", [...SSH_OPTS, sshTarget, remoteCmd], {
      stdio: "inherit",
    });
    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`ssh exited with code ${code}`));
        } else {
          resolve();
        }
      });
      child.on("error", (err) => reject(err));
    });
  } else {
    try {
      const output = await execOutput("ssh", [
        ...SSH_OPTS,
        sshTarget,
        remoteCmd,
      ]);
      console.log(output);
    } catch (err) {
      console.error(
        `Failed to fetch logs: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }
  }
}

// ── Entry point ─────────────────────────────────────────────────

export async function logs(): Promise<void> {
  const opts = parseArgs();

  const entry = opts.name
    ? findAssistantByName(opts.name)
    : loadLatestAssistant();

  if (!entry) {
    if (opts.name) {
      console.error(`No assistant found with name '${opts.name}'.`);
    } else {
      console.error("No assistant found. Run `vellum hatch` first.");
    }
    process.exit(1);
  }

  const cloud = resolveCloud(entry);

  switch (cloud) {
    case "local":
      await showLocalLogs(entry, opts);
      break;

    case "docker":
      await showDockerLogs(entry, opts);
      break;

    case "gcp":
      await showGcpLogs(entry, opts);
      break;

    case "custom":
      await showCustomLogs(entry, opts);
      break;

    case "aws":
      await showAwsLogs(entry, opts);
      break;

    case "vellum":
      console.error(
        "Logs for Vellum-managed instances are not yet supported.\n" +
          "View logs in the Vellum platform dashboard.",
      );
      process.exit(1);
      break;

    case "apple-container":
      console.error(
        "Logs for Apple Container instances are not yet supported.\n" +
          `Use 'vellum ssh ${entry.assistantId}' to access the container directly.`,
      );
      process.exit(1);
      break;

    default:
      console.error(`Unsupported topology '${cloud}' for log viewing.`);
      process.exit(1);
  }
}
