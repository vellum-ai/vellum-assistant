import { join } from "path";

import {
  extractHostFromUrl,
  findAssistantByName,
  formatAssistantLookupError,
  formatAssistantReference,
  getActiveAssistant,
  getAssistantDisplayName,
  getDaemonPidPath,
  loadAllAssistants,
  lookupAssistantByIdentifier,
  type AssistantEntry,
} from "../lib/assistant-config";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import { resolveEnvironmentSource } from "../lib/environments/resolve";
import { loadGuardianToken } from "../lib/guardian-token";
import {
  checkHealth,
  checkManagedHealth,
  fetchManagedPs,
  type ManagedProcessEntry,
} from "../lib/health-check";
import { readPlatformToken } from "../lib/platform-client";
import { dockerResourceNames } from "../lib/docker";
import { existsSync } from "fs";
import {
  classifyProcess,
  detectOrphanedProcesses,
  isPidAlive,
  parseRemotePs,
  readPidFile,
} from "../lib/orphan-detection";
import { pgrepExact } from "../lib/pgrep";
import { probePort } from "../lib/port-probe";
import { withStatusEmoji } from "../lib/status-emoji";
import { execOutput } from "../lib/step-runner";
import {
  syncCloudAssistants,
  type SyncLogger,
} from "../lib/sync-cloud-assistants";

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

function computeColWidths(
  rows: TableRow[],
  headers: TableRow = { name: "NAME", status: "STATUS", info: "INFO" },
): ColWidths {
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

function printTable(
  rows: TableRow[],
  headers: TableRow = { name: "PROCESS", status: "STATUS", info: "INFO" },
): void {
  const colWidths = computeColWidths(rows, headers);
  console.log(formatRow(headers, colWidths));
  const sep = `  ${"-".repeat(colWidths.name)}  ${"-".repeat(colWidths.status)}  ${"-".repeat(colWidths.info)}`;
  console.log(sep);
  for (const row of rows) {
    console.log(formatRow(row, colWidths));
  }
}

// ── Managed process tree rendering ──────────────────────────────

const STATUS_LABELS: Record<ManagedProcessEntry["status"], string> = {
  running: "running",
  not_running: "not running",
  unreachable: "unreachable",
};

function flattenProcessTree(
  entries: ManagedProcessEntry[],
  depth = 0,
): TableRow[] {
  const rows: TableRow[] = [];
  for (const entry of entries) {
    const children = entry.children ?? [];

    rows.push({
      name:
        depth === 0 ? entry.name : `${"  ".repeat(depth - 1)}├─ ${entry.name}`,
      status: withStatusEmoji(STATUS_LABELS[entry.status]),
      info: entry.info ?? "",
    });

    for (let j = 0; j < children.length; j++) {
      const child = children[j];
      const isLast = j === children.length - 1;
      const prefix = `${"  ".repeat(depth)}${isLast ? "└─" : "├─"} ${child.name}`;
      rows.push({
        name: prefix,
        status: withStatusEmoji(STATUS_LABELS[child.status]),
        info: child.info ?? "",
      });

      // Recurse into grandchildren
      const grandchildren = child.children ?? [];
      if (grandchildren.length > 0) {
        rows.push(...flattenProcessTree(grandchildren, depth + 2));
      }
    }
  }
  return rows;
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

const REMOTE_SSH_TIMEOUT_MS = 30_000;

async function getRemoteProcessesGcp(entry: AssistantEntry): Promise<string> {
  return execOutput(
    "gcloud",
    [
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
    ],
    { timeoutMs: REMOTE_SSH_TIMEOUT_MS },
  );
}

async function getRemoteProcessesCustom(
  entry: AssistantEntry,
): Promise<string> {
  const host = extractHostFromUrl(entry.runtimeUrl);
  const sshUser = entry.sshUser ?? "root";
  return execOutput("ssh", [...SSH_OPTS, `${sshUser}@${host}`, REMOTE_PS_CMD], {
    timeoutMs: REMOTE_SSH_TIMEOUT_MS,
  });
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

const LOCAL_CMD_TIMEOUT_MS = 5_000;

async function isWatchMode(pid: string): Promise<boolean> {
  try {
    const args = await execOutput("ps", ["-p", pid, "-o", "args="], {
      timeoutMs: LOCAL_CMD_TIMEOUT_MS,
    });
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
  if (filePid && isPidAlive(filePid)) {
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

  const assistantSpec: ProcessSpec = {
    name: "assistant",
    pgrepName: "vellum-daemon",
    port: resources.daemonPort,
    pidFile: getDaemonPidPath(resources),
  };
  const subSpecs: ProcessSpec[] = [
    {
      name: "├─ qdrant",
      pgrepName: "qdrant",
      port: resources.qdrantPort,
      pidFile: join(vellumDir, "workspace", "data", "qdrant", "qdrant.pid"),
    },
    {
      name: "└─ embed-worker",
      pgrepName: "embed-worker",
      port: 0,
      pidFile: join(vellumDir, "workspace", "embed-worker.pid"),
    },
  ];
  const gatewaySpec: ProcessSpec = {
    name: "gateway",
    pgrepName: "vellum-gateway",
    port: resources.gatewayPort,
    pidFile: join(vellumDir, "gateway.pid"),
  };

  const allSpecs = [assistantSpec, ...subSpecs, gatewaySpec];
  const results = await Promise.all(allSpecs.map(detectProcess));

  return results.map((proc, i) => ({
    name: allSpecs[i].name,
    status: withStatusEmoji(proc.running ? "running" : "not running"),
    info: proc.running ? formatDetectionInfo(proc) : "not detected",
  }));
}

async function getDockerContainerState(
  containerName: string,
): Promise<string | null> {
  try {
    const output = await execOutput(
      "docker",
      ["inspect", "--format", "{{.State.Status}}", containerName],
      { timeoutMs: LOCAL_CMD_TIMEOUT_MS },
    );
    return output.trim() || "unknown";
  } catch {
    return null;
  }
}

function isLocalProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getDockerProcesses(entry: AssistantEntry): Promise<TableRow[]> {
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

  // Show the file watcher process if the instance was hatched with --watch.
  const watcherPid =
    typeof entry.watcherPid === "number" ? entry.watcherPid : null;
  if (watcherPid !== null) {
    const alive = isLocalProcessAlive(watcherPid);
    results.push({
      name: "file-watcher",
      status: withStatusEmoji(alive ? "running" : "not running"),
      info: alive ? `PID ${watcherPid}` : "not detected",
    });
  }

  return results;
}

async function showAssistantProcesses(entry: AssistantEntry): Promise<void> {
  const cloud = entry.cloud;

  console.log(`Processes for ${formatAssistantReference(entry)} (${cloud}):\n`);

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

  if (cloud === "vellum") {
    console.log(`  Platform ID: ${entry.assistantId}\n`);

    const psData = await fetchManagedPs(entry.runtimeUrl, entry.assistantId);

    if (!psData) {
      const rows: TableRow[] = [
        {
          name: "assistant",
          status: withStatusEmoji("unreachable"),
          info: "could not reach platform API — run `vellum login`",
        },
      ];
      printTable(rows);
      return;
    }

    const rows = flattenProcessTree(psData.processes);
    printTable(rows);
    return;
  }

  if (cloud === "apple-container") {
    const mgmtSocket = entry.mgmtSocket as string | undefined;
    const socketAlive = mgmtSocket ? existsSync(mgmtSocket) : false;
    const rows: TableRow[] = [
      {
        name: "container",
        status: withStatusEmoji(socketAlive ? "running" : "not running"),
        info: socketAlive
          ? `mgmt ${mgmtSocket}`
          : "management socket not found",
      },
    ];
    if (entry.runtimeUrl) {
      const token = loadGuardianToken(entry.assistantId)?.accessToken;
      const health = await checkHealth(entry.runtimeUrl, token);
      rows.push({
        name: "gateway",
        status: withStatusEmoji(health.status),
        info: entry.runtimeUrl + (health.detail ? ` | ${health.detail}` : ""),
      });
    }
    printTable(rows);
    return;
  }

  if (cloud === "paired") {
    // A remote assistant paired from another machine: no local process to
    // list — probe the remote gateway's health over the bearer token instead.
    const token = loadGuardianToken(entry.assistantId)?.accessToken;
    const health = await checkHealth(entry.runtimeUrl, token);
    const rows: TableRow[] = [
      {
        name: "gateway",
        status: withStatusEmoji(health.status),
        info: entry.runtimeUrl + (health.detail ? ` | ${health.detail}` : ""),
      },
    ];
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
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("timed out")) {
      console.warn(`Warning: remote process listing timed out — ${msg}`);
      return;
    }
    console.error(`Failed to list processes: ${msg}`);
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

type AssistantHealth = {
  status: string;
  detail: string | null;
  version?: string;
};

async function getAssistantListHealth(
  entry: AssistantEntry,
): Promise<AssistantHealth> {
  const resources = entry.resources;
  if (entry.cloud === "local" && resources) {
    // TODO(ATL-306): Remove readPidFile/getDaemonPidPath in favor of
    // fetching daemon PIDs via the health API (Gateway Security Migration).
    const pid = readPidFile(getDaemonPidPath(resources));
    const alive = pid !== null && isPidAlive(pid);
    if (!alive) {
      return { status: "sleeping", detail: null };
    }
    const token = loadGuardianToken(entry.assistantId)?.accessToken;
    return checkHealth(entry.localUrl ?? entry.runtimeUrl, token);
  }

  if (entry.cloud === "docker") {
    const res = dockerResourceNames(entry.assistantId);
    const state = await getDockerContainerState(res.assistantContainer);
    if (!state || state !== "running") {
      return { status: "sleeping", detail: null };
    }
    const token = loadGuardianToken(entry.assistantId)?.accessToken;
    return checkHealth(entry.localUrl ?? entry.runtimeUrl, token);
  }

  if (entry.cloud === "apple-container") {
    // Apple containers are managed by the macOS app. Probe the gateway
    // (runtimeUrl is always written to the lockfile during hatch).
    const token = loadGuardianToken(entry.assistantId)?.accessToken;
    return entry.runtimeUrl
      ? checkHealth(entry.runtimeUrl, token)
      : { status: "unknown", detail: "no runtime URL" };
  }

  if (entry.cloud === "vellum") {
    return checkManagedHealth(entry.runtimeUrl, entry.assistantId);
  }

  const token = loadGuardianToken(entry.assistantId)?.accessToken;
  return checkHealth(entry.localUrl ?? entry.runtimeUrl, token);
}

function formatAssistantListRow(
  entry: AssistantEntry,
  activeAssistantId: string | null,
  health: AssistantHealth,
): TableRow {
  const infoParts: string[] = [];
  infoParts.push(`id: ${entry.assistantId}`);
  if (entry.runtimeUrl) infoParts.push(entry.runtimeUrl);
  if (entry.cloud) infoParts.push(`cloud: ${entry.cloud}`);
  if (entry.species) infoParts.push(`species: ${entry.species}`);
  if (health.detail) infoParts.push(health.detail);

  const prefix = entry.assistantId === activeAssistantId ? "* " : "  ";
  return {
    name: prefix + getAssistantDisplayName(entry),
    status: withStatusEmoji(health.status),
    info: infoParts.join(" | "),
  };
}

export async function listAllAssistants(verbose: boolean): Promise<void> {
  const { name: envName, source: envSource } = resolveEnvironmentSource();
  const sourceLabels: Record<typeof envSource, string> = {
    flag: "--environment flag",
    env: "VELLUM_ENVIRONMENT",
    config: "~/.config/vellum/environment",
    default: "default",
  };
  console.log(`Environment: ${envName} (${sourceLabels[envSource]})`);

  const log: SyncLogger | undefined = verbose
    ? (msg) => console.log(`  [verbose] ${msg}`)
    : undefined;

  // Decide platform login status FIRST, before touching the network. With no
  // local token we never enter the platform fetch path — so unreachable-host
  // errors from the org-ID/user lookups can't leak onto stderr ahead of the
  // "Platform: not logged in" line.
  const platformToken = readPlatformToken();
  if (!platformToken) {
    log?.("No platform token found — skipping cloud sync");
    console.log("Platform: not logged in");
  } else {
    const syncResult = await syncCloudAssistants(platformToken, { log });
    if (syncResult) {
      const parts = [`Platform: logged in`];
      if (syncResult.email) parts[0] += ` as ${syncResult.email}`;
      if (syncResult.added > 0 || syncResult.removed > 0) {
        const changes: string[] = [];
        if (syncResult.added > 0) changes.push(`${syncResult.added} added`);
        if (syncResult.removed > 0)
          changes.push(`${syncResult.removed} removed`);
        parts.push(`(${changes.join(", ")})`);
      }
      console.log(parts.join(" "));
    } else {
      // We had a token but the platform fetch failed (offline, expired, etc.).
      // Treat it the same as "not logged in" from a UX perspective — the user
      // can't reach cloud-managed assistants right now either way.
      console.log("Platform: not logged in");
    }
  }
  console.log("");

  const assistants = loadAllAssistants();
  const activeId = getActiveAssistant();
  const activeAssistantId = activeId
    ? (findAssistantByName(activeId)?.assistantId ?? activeId)
    : null;

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

  const rows = await Promise.all(
    assistants.map(async (entry) =>
      formatAssistantListRow(
        entry,
        activeAssistantId,
        await getAssistantListHealth(entry),
      ),
    ),
  );

  printTable(rows, { name: "NAME", status: "STATUS", info: "INFO" });
}

// ── Entry point ─────────────────────────────────────────────────

export async function ps(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum ps [<name-or-id>] [--verbose]");
    console.log("");
    console.log(
      "List all assistants, or show processes for a specific assistant.",
    );
    console.log("");
    console.log("Arguments:");
    console.log(
      "  <name-or-id> Show processes for the assistant display name or ID",
    );
    console.log("");
    console.log("Options:");
    console.log(
      "  --verbose    Show diagnostic logs (platform sync, auth issues)",
    );
    process.exit(0);
  }

  const verbose = args.includes("--verbose");
  const assistantIdentifier = parseAssistantTargetArg(args);

  if (!assistantIdentifier) {
    await listAllAssistants(verbose);
    return;
  }

  const result = lookupAssistantByIdentifier(assistantIdentifier);
  if (result.status !== "found") {
    console.error(formatAssistantLookupError(assistantIdentifier, result));
    process.exit(1);
  }

  await showAssistantProcesses(result.entry);
}
