import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { getCurrentEnvironment, getDataDir } from "@vellumai/environments";

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

export function isProcessAlive(pid: string): boolean {
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

export async function detectOrphanedProcesses(): Promise<OrphanedProcess[]> {
  const results: OrphanedProcess[] = [];
  const seenPids = new Set<string>();
  const vellumDir = getDataDir(getCurrentEnvironment());

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
      "ps ax -o pid=,ppid=,args= | grep -E 'vellum|qdrant|openclaw' | grep -v grep",
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
