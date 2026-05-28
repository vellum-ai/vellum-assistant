import { existsSync, readFileSync } from "fs";
import { join } from "path";

import {
  getDaemonPidPath,
  loadAllAssistantsAcrossEnvs,
  type AssistantEntry,
} from "./assistant-config.js";
import { execOutput } from "./step-runner";

export interface RemoteProcess {
  pid: string;
  ppid: string;
  command: string;
}

export function classifyProcess(command: string): string {
  if (/qdrant/.test(command)) return "qdrant";
  if (/vellum-gateway/.test(command)) return "gateway";
  if (
    /vellum-openclaw-adapter|openclaw-runtime-server|openclaw-http-server/.test(
      command,
    )
  )
    return "openclaw-adapter";
  if (/vellum-daemon/.test(command)) return "assistant";
  if (/daemon\s+(start|restart)/.test(command)) return "assistant";
  if (/vellum-cli/.test(command)) return "vellum";
  // Exclude macOS desktop app processes — their path contains .app/Contents/MacOS/
  // but they are not background service processes.
  if (/\.app\/Contents\/MacOS\//.test(command)) return "unknown";
  // Match vellum CLI commands (e.g. "vellum hatch", "vellum sleep") but NOT
  // unrelated processes whose working directory or repo path happens to contain
  // "vellum" (e.g. /Users/runner/work/vellum-assistant/vellum-assistant/...).
  // We require a word boundary before "vellum" to avoid matching repo paths.
  if (/(?:^|\/)vellum(?:\s|$)/.test(command)) return "vellum";
  return "unknown";
}

export function parseRemotePs(output: string): RemoteProcess[] {
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

export function readPidFile(pidFile: string): string | null {
  if (!existsSync(pidFile)) return null;
  const pid = readFileSync(pidFile, "utf-8").trim();
  return pid || null;
}

export function isPidAlive(pid: string): boolean {
  try {
    process.kill(parseInt(pid, 10), 0);
    return true;
  } catch {
    return false;
  }
}

export interface OrphanedProcess {
  name: string;
  pid: string;
  source: string;
}

/**
 * Collect PIDs that belong to a known assistant in any environment.
 *
 * For local entries this reads the daemon/gateway/qdrant/embed-worker PID
 * files under each entry's `instanceDir`. For docker entries we include the
 * `watcherPid` field when present (the file watcher runs as a host process,
 * unlike the containers themselves). Other cloud topologies don't have
 * host-side processes that show up in `ps ax`.
 *
 * This set is the basis for filtering the orphan list: if a running process
 * matches a recorded PID for *any* env's assistant, it's not an orphan.
 */
export function getKnownPidsFromAssistants(
  entries: AssistantEntry[],
): Set<string> {
  const pids = new Set<string>();
  for (const entry of entries) {
    if (entry.cloud === "local" && entry.resources) {
      const vellumDir = join(entry.resources.instanceDir, ".vellum");
      const candidates = [
        getDaemonPidPath(entry.resources),
        join(vellumDir, "gateway.pid"),
        join(vellumDir, "workspace", "data", "qdrant", "qdrant.pid"),
        join(vellumDir, "workspace", "embed-worker.pid"),
      ];
      for (const file of candidates) {
        const pid = readPidFile(file);
        if (pid) pids.add(pid);
      }
    }
    if (typeof entry.watcherPid === "number") {
      pids.add(String(entry.watcherPid));
    }
  }
  return pids;
}

export interface DetectOrphansOptions {
  /**
   * Set of PIDs to treat as known and exclude from the orphan list. When
   * omitted, defaults to the union of every env's recorded assistant PIDs
   * via {@link loadAllAssistantsAcrossEnvs} +
   * {@link getKnownPidsFromAssistants}. Tests can inject an explicit set to
   * avoid touching the real on-host lockfiles.
   */
  excludePids?: Set<string>;
}

export async function detectOrphanedProcesses(
  options: DetectOrphansOptions = {},
): Promise<OrphanedProcess[]> {
  const results: OrphanedProcess[] = [];
  const seenPids = new Set<string>();

  // PIDs that belong to a known assistant in *any* environment are not
  // orphans. Without this filter, running `vellum ps` from an env that has
  // no assistants — or `vellum clean` from any env — would flag (or kill)
  // another env's healthy services as orphans.
  const knownPids =
    options.excludePids ??
    getKnownPidsFromAssistants(loadAllAssistantsAcrossEnvs());

  // Process table scan — discover orphaned processes by scanning the OS
  // process table rather than reading PID files from the workspace.
  try {
    const output = await execOutput(
      "sh",
      [
        "-c",
        "ps ax -o pid=,ppid=,args= | grep -E 'vellum|qdrant|openclaw' | grep -v grep",
      ],
      { timeoutMs: 5_000 },
    );
    const procs = parseRemotePs(output);
    const ownPid = String(process.pid);

    for (const p of procs) {
      if (p.pid === ownPid || seenPids.has(p.pid)) continue;
      if (knownPids.has(p.pid)) continue;
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
