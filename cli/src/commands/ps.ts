import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import {
  findAssistantByName,
  loadAllAssistants,
  type AssistantEntry,
} from "../lib/assistant-config";
import { GATEWAY_PORT } from "../lib/constants";
import { checkHealth } from "../lib/health-check";
import { pgrepExact } from "../lib/pgrep";
import { probePort } from "../lib/port-probe";
import { withStatusEmoji } from "../lib/status-emoji";
import { execOutput } from "../lib/step-runner";

const RUNTIME_HTTP_PORT = Number(process.env.RUNTIME_HTTP_PORT) || 7821;
const QDRANT_PORT = 6333;

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
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "LogLevel=ERROR",
];

const REMOTE_PS_CMD = [
  // List vellum-related processes: daemon, gateway, qdrant, and any bun children
  "ps ax -o pid=,ppid=,args=",
  "| grep -E 'vellum|vellum-gateway|qdrant|openclaw'",
  "| grep -v grep",
].join(" ");

interface RemoteProcess {
  pid: string;
  ppid: string;
  command: string;
}

function classifyProcess(command: string): string {
  if (/qdrant/.test(command)) return "qdrant";
  if (/vellum-gateway/.test(command)) return "gateway";
  if (/openclaw/.test(command)) return "openclaw-adapter";
  if (/vellum-daemon/.test(command)) return "assistant";
  if (/daemon\s+(start|restart)/.test(command)) return "assistant";
  // Exclude macOS desktop app processes — their path contains .app/Contents/MacOS/
  // but they are not background service processes.
  if (/\.app\/Contents\/MacOS\//.test(command)) return "unknown";
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

async function getRemoteProcessesGcp(entry: AssistantEntry): Promise<string> {
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
  return execOutput("ssh", [...SSH_OPTS, `${sshUser}@${host}`, REMOTE_PS_CMD]);
}

interface ProcessSpec {
  name: string;
  pgrepName: string;
  port: number;
  pidFile: string;
}

function readPidFile(pidFile: string): string | null {
  if (!existsSync(pidFile)) return null;
  const pid = readFileSync(pidFile, "utf-8").trim();
  return pid || null;
}

function isProcessAlive(pid: string): boolean {
  try {
    process.kill(parseInt(pid, 10), 0);
    return true;
  } catch {
    return false;
  }
}

interface DetectedProcess {
  name: string;
  pid: string | null;
  port: number;
  running: boolean;
}

async function detectProcess(spec: ProcessSpec): Promise<DetectedProcess> {
  // Tier 1: pgrep by process title
  const pids = await pgrepExact(spec.pgrepName);
  if (pids.length > 0) {
    return { name: spec.name, pid: pids[0], port: spec.port, running: true };
  }

  // Tier 2: TCP port probe (skip for processes without a port)
  const listening = spec.port > 0 && (await probePort(spec.port));
  if (listening) {
    const filePid = readPidFile(spec.pidFile);
    return {
      name: spec.name,
      pid: filePid,
      port: spec.port,
      running: true,
    };
  }

  // Tier 3: PID file fallback
  const filePid = readPidFile(spec.pidFile);
  if (filePid && isProcessAlive(filePid)) {
    return { name: spec.name, pid: filePid, port: spec.port, running: true };
  }

  return { name: spec.name, pid: null, port: spec.port, running: false };
}

function formatDetectionInfo(proc: DetectedProcess): string {
  const parts: string[] = [];
  if (proc.pid) parts.push(`PID ${proc.pid}`);
  if (proc.port > 0) parts.push(`port ${proc.port}`);
  return parts.join(" | ");
}

async function getLocalProcesses(entry: AssistantEntry): Promise<TableRow[]> {
  const vellumDir = entry.baseDataDir ?? join(homedir(), ".vellum");

  const specs: ProcessSpec[] = [
    {
      name: "assistant",
      pgrepName: "vellum-daemon",
      port: RUNTIME_HTTP_PORT,
      pidFile: join(vellumDir, "vellum.pid"),
    },
    {
      name: "qdrant",
      pgrepName: "qdrant",
      port: QDRANT_PORT,
      pidFile: join(vellumDir, "workspace", "data", "qdrant", "qdrant.pid"),
    },
    {
      name: "gateway",
      pgrepName: "vellum-gateway",
      port: GATEWAY_PORT,
      pidFile: join(vellumDir, "gateway.pid"),
    },
    {
      name: "embed-worker",
      pgrepName: "embed-worker",
      port: 0,
      pidFile: join(vellumDir, "embed-worker.pid"),
    },
  ];

  const results = await Promise.all(specs.map(detectProcess));

  return results.map((proc) => ({
    name: proc.name,
    status: withStatusEmoji(proc.running ? "running" : "not running"),
    info: proc.running ? formatDetectionInfo(proc) : "not detected",
  }));
}

async function showAssistantProcesses(entry: AssistantEntry): Promise<void> {
  const cloud = resolveCloud(entry);

  console.log(`Processes for ${entry.assistantId} (${cloud}):\n`);

  if (cloud === "local") {
    const rows = await getLocalProcesses(entry);
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
    console.error(
      `Failed to list processes: ${error instanceof Error ? error.message : error}`,
    );
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

// ── Orphaned process detection ──────────────────────────────────

interface OrphanedProcess {
  name: string;
  pid: string;
  source: string;
}

async function detectOrphanedProcesses(): Promise<OrphanedProcess[]> {
  const results: OrphanedProcess[] = [];
  const seenPids = new Set<string>();
  const vellumDir = join(homedir(), ".vellum");

  // Strategy 1: PID file scan
  const pidFiles: Array<{ file: string; name: string }> = [
    { file: join(vellumDir, "vellum.pid"), name: "assistant" },
    { file: join(vellumDir, "gateway.pid"), name: "gateway" },
    { file: join(vellumDir, "qdrant.pid"), name: "qdrant" },
  ];

  for (const { file, name } of pidFiles) {
    const pid = readPidFile(file);
    if (pid && isProcessAlive(pid)) {
      results.push({ name, pid, source: "pid file" });
      seenPids.add(pid);
    }
  }

  // Strategy 2: Process table scan
  try {
    const output = await execOutput("sh", [
      "-c",
      "ps ax -o pid=,ppid=,args= | grep -E 'vellum|vellum-gateway|qdrant|openclaw' | grep -v grep",
    ]);
    const procs = parseRemotePs(output);
    const ownPid = String(process.pid);

    for (const p of procs) {
      if (p.pid === ownPid || seenPids.has(p.pid)) continue;
      const type = classifyProcess(p.command);
      if (type === "unknown") continue;
      results.push({ name: type, pid: p.pid, source: "process table" });
      seenPids.add(p.pid);
    }
  } catch {
    // grep exits 1 when no matches found — ignore
  }

  return results;
}

// ── List all assistants (no arg) ────────────────────────────────

async function listAllAssistants(): Promise<void> {
  const assistants = loadAllAssistants();

  if (assistants.length === 0) {
    console.log("No assistants found.");

    const orphans = await detectOrphanedProcesses();
    if (orphans.length > 0) {
      console.log("\nOrphaned processes detected:\n");
      const rows: TableRow[] = orphans.map((o) => ({
        name: o.name,
        status: withStatusEmoji("running"),
        info: `PID ${o.pid} (from ${o.source})`,
      }));
      printTable(rows);
      const pids = orphans.map((o) => o.pid).join(" ");
      console.log(
        `\nHint: Run \`kill ${pids}\` to clean up orphaned processes.`,
      );
    }

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
      const health = await checkHealth(a.runtimeUrl, a.bearerToken);

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
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: assistant ps [<name>]");
    console.log("");
    console.log(
      "List all assistants, or show processes for a specific assistant.",
    );
    console.log("");
    console.log("Arguments:");
    console.log("  <name>    Show processes for the named assistant");
    process.exit(0);
  }

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
