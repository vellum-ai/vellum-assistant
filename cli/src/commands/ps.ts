import { join } from "path";

import {
  findAssistantByName,
  getActiveAssistant,
  loadAllAssistants,
  type AssistantEntry,
} from "../lib/assistant-config";
import { loadGuardianToken } from "../lib/guardian-token";
import { checkHealth, checkManagedHealth } from "../lib/health-check";
import { dockerResourceNames } from "../lib/docker";
import {
  classifyProcess,
  detectOrphanedProcesses,
  isProcessAlive,
  parseRemotePs,
  readPidFile,
} from "../lib/orphan-detection";
import { pgrepExact } from "../lib/pgrep";
import { probePort } from "../lib/port-probe";
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

interface DetectedProcess {
  name: string;
  pid: string | null;
  port: number;
  running: boolean;
  watch: boolean;
}

async function isWatchMode(pid: string): Promise<boolean> {
  try {
    const args = await execOutput("ps", ["-p", pid, "-o", "args="]);
    return args.includes("--watch");
  } catch {
    return false;
  }
}

async function detectProcess(spec: ProcessSpec): Promise<DetectedProcess> {
  // Tier 1: pgrep by process title
  const pids = await pgrepExact(spec.pgrepName);
  if (pids.length > 0) {
    const watch = await isWatchMode(pids[0]);
    return {
      name: spec.name,
      pid: pids[0],
      port: spec.port,
      running: true,
      watch,
    };
  }

  // Tier 2: TCP port probe (skip for processes without a port)
  const listening = spec.port > 0 && (await probePort(spec.port));
  if (listening) {
    const filePid = readPidFile(spec.pidFile);
    const watch = filePid ? await isWatchMode(filePid) : false;
    return {
      name: spec.name,
      pid: filePid,
      port: spec.port,
      running: true,
      watch,
    };
  }

  // Tier 3: PID file fallback
  const filePid = readPidFile(spec.pidFile);
  if (filePid && isProcessAlive(filePid)) {
    const watch = await isWatchMode(filePid);
    return {
      name: spec.name,
      pid: filePid,
      port: spec.port,
      running: true,
      watch,
    };
  }

  return {
    name: spec.name,
    pid: null,
    port: spec.port,
    running: false,
    watch: false,
  };
}

function formatDetectionInfo(proc: DetectedProcess): string {
  const parts: string[] = [];
  if (proc.pid) parts.push(`PID ${proc.pid}`);
  if (proc.port > 0) parts.push(`port ${proc.port}`);
  if (proc.watch) parts.push("watch");
  return parts.join(" | ");
}

async function getLocalProcesses(entry: AssistantEntry): Promise<TableRow[]> {
  if (!entry.resources) {
    throw new Error(
      `Local assistant '${entry.assistantId}' is missing resource configuration. Re-hatch to fix.`,
    );
  }
  const resources = entry.resources;
  const vellumDir = join(resources.instanceDir, ".vellum");

  const specs: ProcessSpec[] = [
    {
      name: "assistant",
      pgrepName: "vellum-daemon",
      port: resources.daemonPort,
      pidFile: resources.pidFile,
    },
    {
      name: "qdrant",
      pgrepName: "qdrant",
      port: resources.qdrantPort,
      pidFile: join(vellumDir, "workspace", "data", "qdrant", "qdrant.pid"),
    },
    {
      name: "gateway",
      pgrepName: "vellum-gateway",
      port: resources.gatewayPort,
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

async function getDockerContainerState(
  containerName: string,
): Promise<string | null> {
  try {
    const output = await execOutput("docker", [
      "inspect",
      "--format",
      "{{.State.Status}}",
      containerName,
    ]);
    return output.trim() || "unknown";
  } catch {
    return null;
  }
}

async function getDockerProcesses(
  entry: AssistantEntry,
): Promise<TableRow[]> {
  const res = dockerResourceNames(entry.assistantId);

  const containers: { name: string; containerName: string }[] = [
    { name: "assistant", containerName: res.assistantContainer },
    { name: "gateway", containerName: res.gatewayContainer },
    { name: "credential-executor", containerName: res.cesContainer },
  ];

  const results = await Promise.all(
    containers.map(async ({ name, containerName }) => {
      const state = await getDockerContainerState(containerName);
      if (!state) {
        return {
          name,
          status: withStatusEmoji("not found"),
          info: `container ${containerName}`,
        };
      }
      return {
        name,
        status: withStatusEmoji(state === "running" ? "running" : state),
        info: `container ${containerName}`,
      };
    }),
  );

  return results;
}

async function showAssistantProcesses(entry: AssistantEntry): Promise<void> {
  const cloud = resolveCloud(entry);

  console.log(`Processes for ${entry.assistantId} (${cloud}):\n`);

  if (cloud === "local") {
    const rows = await getLocalProcesses(entry);
    printTable(rows);
    return;
  }

  if (cloud === "docker") {
    const rows = await getDockerProcesses(entry);
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

// ── List all assistants (no arg) ────────────────────────────────

async function listAllAssistants(): Promise<void> {
  const assistants = loadAllAssistants();
  const activeId = getActiveAssistant();

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
      console.log(
        `\nHint: Run \`vellum clean\` to clean up orphaned processes.`,
      );
    }

    return;
  }

  const rows: TableRow[] = assistants.map((a) => {
    const infoParts = [a.runtimeUrl];
    if (a.cloud) infoParts.push(`cloud: ${a.cloud}`);
    if (a.species) infoParts.push(`species: ${a.species}`);
    const prefix = a.assistantId === activeId ? "* " : "  ";

    return {
      name: prefix + a.assistantId,
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
      // For local assistants, check if the daemon process is alive before
      // hitting the health endpoint. If the PID file is missing or the
      // process isn't running, the assistant is sleeping — skip the
      // network health check to avoid a misleading "unreachable" status.
      let health: { status: string; detail: string | null };
      const resources = a.resources;
      if (a.cloud === "local" && resources) {
        const pid = readPidFile(resources.pidFile);
        const alive = pid !== null && isProcessAlive(pid);
        if (!alive) {
          health = { status: "sleeping", detail: null };
        } else {
          health = await checkHealth(a.localUrl ?? a.runtimeUrl, a.bearerToken);
        }
      } else if (a.cloud === "docker") {
        const res = dockerResourceNames(a.assistantId);
        const state = await getDockerContainerState(res.assistantContainer);
        if (!state || state !== "running") {
          health = { status: "sleeping", detail: null };
        } else {
          const token = a.bearerToken ?? loadGuardianToken(a.assistantId)?.accessToken;
          health = await checkHealth(a.localUrl ?? a.runtimeUrl, token);
        }
      } else if (a.cloud === "vellum") {
        health = await checkManagedHealth(a.runtimeUrl, a.assistantId);
      } else {
        const token = a.bearerToken ?? loadGuardianToken(a.assistantId)?.accessToken;
        health = await checkHealth(a.localUrl ?? a.runtimeUrl, token);
      }

      const infoParts = [a.runtimeUrl];
      if (a.cloud) infoParts.push(`cloud: ${a.cloud}`);
      if (a.species) infoParts.push(`species: ${a.species}`);
      if (health.detail) infoParts.push(health.detail);

      const prefix = a.assistantId === activeId ? "* " : "  ";
      const updatedRow: TableRow = {
        name: prefix + a.assistantId,
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
    console.log("Usage: vellum ps [<name>]");
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
