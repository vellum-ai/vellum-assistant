import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import {
  findAssistantByName,
  loadAllAssistants,
  type AssistantEntry,
} from "../lib/assistant-config";
import { checkHealth } from "../lib/health-check";
import { withStatusEmoji } from "../lib/status-emoji";
import { execOutput } from "../lib/step-runner";

// ── Table formatting helpers ────────────────────────────────────

interface TableRow {
  name: string;
  status: string;
  info: string;
}

interface ColWidths {
  name: number;
  status: number;
  info: number;
}

function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - s.length));
}

function computeColWidths(rows: TableRow[]): ColWidths {
  const headers: TableRow = { name: "NAME", status: "STATUS", info: "INFO" };
  const all = [headers, ...rows];
  return {
    name: Math.max(...all.map((r) => r.name.length)),
    status: Math.max(...all.map((r) => r.status.length), "checking...".length),
    info: Math.max(...all.map((r) => r.info.length)),
  };
}

function formatRow(r: TableRow, colWidths: ColWidths): string {
  return `  ${pad(r.name, colWidths.name)}  ${pad(r.status, colWidths.status)}  ${r.info}`;
}

function printTable(rows: TableRow[]): void {
  const colWidths = computeColWidths(rows);
  const headers: TableRow = { name: "PROCESS", status: "STATUS", info: "INFO" };
  console.log(formatRow(headers, colWidths));
  const sep = `  ${"-".repeat(colWidths.name)}  ${"-".repeat(colWidths.status)}  ${"-".repeat(colWidths.info)}`;
  console.log(sep);
  for (const row of rows) {
    console.log(formatRow(row, colWidths));
  }
}

// ── Remote process listing via SSH ──────────────────────────────

const SSH_OPTS = [
  "-o", "StrictHostKeyChecking=no",
  "-o", "UserKnownHostsFile=/dev/null",
  "-o", "ConnectTimeout=10",
  "-o", "LogLevel=ERROR",
];

const REMOTE_PS_CMD = [
  // List vellum-related processes: daemon, gateway, qdrant, and any bun children
  "ps ax -o pid=,ppid=,args=",
  "| grep -E 'vellum|gateway|qdrant|openclaw'",
  "| grep -v grep",
].join(" ");

interface RemoteProcess {
  pid: string;
  ppid: string;
  command: string;
}

function classifyProcess(command: string): string {
  if (/qdrant/.test(command)) return "qdrant";
  if (/gateway/.test(command)) return "gateway";
  if (/openclaw/.test(command)) return "openclaw-adapter";
  if (/daemon\s+(start|restart)/.test(command)) return "daemon";
  if (/vellum/.test(command)) return "vellum";
  return "unknown";
}

function parseRemotePs(output: string): RemoteProcess[] {
  return output
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const trimmed = line.trim();
      const parts = trimmed.split(/\s+/);
      const pid = parts[0];
      const ppid = parts[1];
      const command = parts.slice(2).join(" ");
      return { pid, ppid, command };
    });
}

function extractHostFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return url.replace(/^https?:\/\//, "").split(":")[0];
  }
}

function resolveCloud(entry: AssistantEntry): string {
  if (entry.cloud) return entry.cloud;
  if (entry.project) return "gcp";
  if (entry.sshUser) return "custom";
  return "local";
}

async function getRemoteProcessesGcp(
  entry: AssistantEntry,
): Promise<string> {
  return execOutput("gcloud", [
    "compute",
    "ssh",
    `${entry.sshUser ?? entry.assistantId}@${entry.assistantId}`,
    `--zone=${entry.zone}`,
    `--project=${entry.project}`,
    `--command=${REMOTE_PS_CMD}`,
    "--ssh-flag=-o StrictHostKeyChecking=no",
    "--ssh-flag=-o UserKnownHostsFile=/dev/null",
    "--ssh-flag=-o ConnectTimeout=10",
    "--ssh-flag=-o LogLevel=ERROR",
  ]);
}

async function getRemoteProcessesCustom(
  entry: AssistantEntry,
): Promise<string> {
  const host = extractHostFromUrl(entry.runtimeUrl);
  const sshUser = entry.sshUser ?? "root";
  return execOutput("ssh", [
    ...SSH_OPTS,
    `${sshUser}@${host}`,
    REMOTE_PS_CMD,
  ]);
}

async function getLocalProcesses(): Promise<TableRow[]> {
  const rows: TableRow[] = [];
  const vellumDir = join(homedir(), ".vellum");

  // Check daemon PID
  const pidFile = join(vellumDir, "vellum.pid");
  if (existsSync(pidFile)) {
    const pid = readFileSync(pidFile, "utf-8").trim();
    let status = "running";
    try {
      process.kill(parseInt(pid, 10), 0);
    } catch {
      status = "not running";
    }
    rows.push({ name: "daemon", status: withStatusEmoji(status), info: `PID ${pid}` });
  } else {
    rows.push({ name: "daemon", status: withStatusEmoji("not running"), info: "no PID file" });
  }

  // Check qdrant PID
  const qdrantPidFile = join(vellumDir, "workspace", "data", "qdrant", "qdrant.pid");
  if (existsSync(qdrantPidFile)) {
    const pid = readFileSync(qdrantPidFile, "utf-8").trim();
    let status = "running";
    try {
      process.kill(parseInt(pid, 10), 0);
    } catch {
      status = "not running";
    }
    rows.push({ name: "qdrant", status: withStatusEmoji(status), info: `PID ${pid} | port 6333` });
  } else {
    rows.push({ name: "qdrant", status: withStatusEmoji("not running"), info: "no PID file" });
  }

  // Check gateway via ps
  try {
    const output = await execOutput("ps", ["ax", "-o", "pid=,command="]);
    const gatewayLines = output
      .split("\n")
      .filter((l) => /gateway\/src\/index\.ts/.test(l) && !l.includes("grep"));
    if (gatewayLines.length > 0) {
      const trimmed = gatewayLines[0].trim();
      const pid = trimmed.split(/\s+/)[0];
      rows.push({ name: "gateway", status: withStatusEmoji("running"), info: `PID ${pid} | port 7830` });
    } else {
      rows.push({ name: "gateway", status: withStatusEmoji("not running"), info: "" });
    }
  } catch {
    rows.push({ name: "gateway", status: withStatusEmoji("unknown"), info: "" });
  }

  return rows;
}

async function showAssistantProcesses(entry: AssistantEntry): Promise<void> {
  const cloud = resolveCloud(entry);

  console.log(`Processes for ${entry.assistantId} (${cloud}):\n`);

  if (cloud === "local") {
    const rows = await getLocalProcesses();
    printTable(rows);
    return;
  }

  let output: string;
  try {
    if (cloud === "gcp") {
      output = await getRemoteProcessesGcp(entry);
    } else if (cloud === "custom") {
      output = await getRemoteProcessesCustom(entry);
    } else {
      console.error(`Unsupported cloud type '${cloud}' for process listing.`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Failed to list processes: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  const procs = parseRemotePs(output);

  if (procs.length === 0) {
    console.log("No vellum processes found on the remote instance.");
    return;
  }

  const rows: TableRow[] = procs.map((p) => ({
    name: classifyProcess(p.command),
    status: withStatusEmoji("running"),
    info: `PID ${p.pid} | ${p.command.slice(0, 80)}`,
  }));

  printTable(rows);
}

// ── List all assistants (no arg) ────────────────────────────────

async function listAllAssistants(): Promise<void> {
  const assistants = loadAllAssistants();

  if (assistants.length === 0) {
    console.log("No assistants found.");
    return;
  }

  const rows: TableRow[] = assistants.map((a) => {
    const infoParts = [a.runtimeUrl];
    if (a.cloud) infoParts.push(`cloud: ${a.cloud}`);
    if (a.species) infoParts.push(`species: ${a.species}`);

    return {
      name: a.assistantId,
      status: withStatusEmoji("checking..."),
      info: infoParts.join(" | "),
    };
  });

  const colWidths = computeColWidths(rows);

  const headers: TableRow = { name: "NAME", status: "STATUS", info: "INFO" };
  console.log(formatRow(headers, colWidths));
  const sep = `  ${"-".repeat(colWidths.name)}  ${"-".repeat(colWidths.status)}  ${"-".repeat(colWidths.info)}`;
  console.log(sep);
  for (const row of rows) {
    console.log(formatRow(row, colWidths));
  }

  const totalDataRows = rows.length;

  await Promise.all(
    assistants.map(async (a, rowIndex) => {
      const health = await checkHealth(a.runtimeUrl);

      const infoParts = [a.runtimeUrl];
      if (a.cloud) infoParts.push(`cloud: ${a.cloud}`);
      if (a.species) infoParts.push(`species: ${a.species}`);
      if (health.detail) infoParts.push(health.detail);

      const updatedRow: TableRow = {
        name: a.assistantId,
        status: withStatusEmoji(health.status),
        info: infoParts.join(" | "),
      };

      const linesUp = totalDataRows - rowIndex;
      process.stdout.write(
        `\x1b[${linesUp}A` +
          `\r\x1b[K` +
          formatRow(updatedRow, colWidths) +
          `\n` +
          (linesUp > 1 ? `\x1b[${linesUp - 1}B` : ""),
      );
    }),
  );
}

// ── Entry point ─────────────────────────────────────────────────

export async function ps(): Promise<void> {
  const assistantId = process.argv[3];

  if (!assistantId) {
    await listAllAssistants();
    return;
  }

  const entry = findAssistantByName(assistantId);
  if (!entry) {
    console.error(`No assistant found with name '${assistantId}'.`);
    process.exit(1);
  }

  await showAssistantProcesses(entry);
}
