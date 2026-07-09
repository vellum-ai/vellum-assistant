/**
 * Native OS process-tree enumeration for the `ps` route.
 *
 * `listProcesses()` reads the live process table — preferring Linux `/proc`
 * (no subprocess, always present in our containers) and falling back to the
 * `ps` command on macOS / wherever `/proc` is unavailable. `buildProcessTree()`
 * is a pure function that turns a flat `(pid, ppid, command)` list into the
 * subtree rooted at a given PID, so the daemon can report every descendant
 * process that is actually parented to it.
 */

import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProcInfo {
  pid: number;
  ppid: number;
  /**
   * Safe process descriptor derived from the raw command line via
   * {@link deriveName}. The raw command line is never stored because it can
   * contain secrets (bearer tokens, API keys, database URLs) passed as
   * process arguments. This redacted descriptor preserves diagnostic
   * utility (identifying what is running) without leaking secrets into
   * snapshot files.
   */
  command: string;
}

export interface ProcTreeNode {
  pid: number;
  /** Friendly process name derived from the command. */
  name: string;
  /** Safe process descriptor (redacted via deriveName at collection time). */
  command: string;
  children: ProcTreeNode[];
}

/** Interpreters whose script argument is more descriptive than argv[0]. */
const RUNTIMES = new Set([
  "bun",
  "node",
  "deno",
  "python",
  "python3",
  "sh",
  "bash",
  "env",
]);

const basename = (p: string): string => p.split("/").pop() || p;

/** Script extensions whose path we summarize as `<parent>-<file>`. */
const SCRIPT_EXT_RE = /\.(ts|js|mjs|cjs|py)$/;

/**
 * Summarize a script path as `<parent-dir>-<filename-without-ext>` so the worker
 * at `…/memory/worker.ts` reads as `memory-worker` and the daemon entry
 * `…/daemon/main.ts` as `daemon-main`. Falls back to the bare extensionless
 * filename when the script sits at the filesystem root.
 */
function scriptName(scriptPath: string): string {
  const parts = scriptPath.split("/").filter(Boolean);
  const file = parts[parts.length - 1].replace(SCRIPT_EXT_RE, "");
  const parent = parts.length >= 2 ? parts[parts.length - 2] : "";
  return parent ? `${parent}-${file}` : file;
}

/**
 * Derive a readable name from a command line. For interpreter invocations
 * (`bun run /…/memory/worker.ts`) the script path is far more useful than the
 * interpreter name, so prefer the first script-looking argument and summarize it
 * as `<parent-dir>-<filename>` (e.g. `memory-worker`). When an interpreter is run
 * without a script file (`bun run dev`, `bun x prettier`, `bun repl`) the bare
 * interpreter name says nothing about what is running, so surface the arguments
 * — what was actually run — alongside it (e.g. `bun run dev`). Plain binaries
 * (`/…/vellum-qdrant`) keep their bare executable name.
 */
export function deriveName(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {return "(unknown)";}

  const argv0 = basename(tokens[0]);
  if (RUNTIMES.has(argv0)) {
    const args = tokens.slice(1);
    const script = args.find((t) => SCRIPT_EXT_RE.test(t));
    if (script) {return scriptName(script);}
    // No script to summarize: show the non-flag arguments so the entry reads as
    // "what was run" rather than an opaque `bun`. Flags are dropped as noise.
    const meaningful = args.filter((t) => !t.startsWith("-"));
    if (meaningful.length > 0) {return `${argv0} ${meaningful.join(" ")}`;}
  }
  return argv0;
}

/**
 * Parse a `/proc/<pid>/stat` line into its leading fields. `comm` (the
 * executable name) may itself contain spaces and parentheses, so the fixed
 * fields are read relative to the final `)` rather than by naive splitting.
 * Returns null if the line is malformed.
 */
function parseProcStat(content: string): { comm: string; ppid: number } | null {
  const lparen = content.indexOf("(");
  const rparen = content.lastIndexOf(")");
  if (lparen === -1 || rparen === -1 || rparen < lparen) {return null;}
  const comm = content.slice(lparen + 1, rparen);
  // After ")" come: " <state> <ppid> …" — split the remainder on spaces.
  const rest = content.slice(rparen + 2).split(" ");
  const ppid = Number(rest[1]);
  if (!Number.isInteger(ppid)) {return null;}
  return { comm, ppid };
}

/** Read the live process table from Linux `/proc`. Throws if `/proc` is absent. */
function listProcessesFromProc(): ProcInfo[] {
  const entries = readdirSync("/proc");
  const procs: ProcInfo[] = [];
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0) {continue;}

    let ppid: number;
    let comm: string;
    try {
      const parsed = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
      if (!parsed) {continue;}
      ({ ppid, comm } = parsed);
    } catch {
      // Process exited between readdir and read — skip.
      continue;
    }

    // `/proc/<pid>/cmdline` is NUL-delimited and empty for kernel threads.
    // Redact the raw command line via deriveName to strip secrets (tokens,
    // API keys, database URLs) that are commonly passed as process arguments.
    // The raw command line is read here but never stored — only the derived
    // safe descriptor is kept.
    let command = comm;
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const joined = raw.split("\0").filter(Boolean).join(" ");
      if (joined) {command = deriveName(joined);}
    } catch {
      // Fall back to comm.
    }

    procs.push({ pid, ppid, command });
  }
  return procs;
}

/** Read the live process table via the `ps` command (macOS / no `/proc`). */
async function listProcessesFromPs(): Promise<ProcInfo[]> {
  const { stdout } = await execFileAsync(
    "ps",
    ["-A", "-o", "pid=,ppid=,command="],
    { maxBuffer: 8 * 1024 * 1024 },
  );

  const procs: ProcInfo[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) {continue;}
    procs.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      command: deriveName(m[3].trim()),
    });
  }
  return procs;
}

/**
 * Enumerate the live process table as `(pid, ppid, command)` rows. Prefers
 * Linux `/proc`; falls back to `ps` when `/proc` is unavailable (e.g. macOS).
 */
export async function listProcesses(): Promise<ProcInfo[]> {
  try {
    return listProcessesFromProc();
  } catch {
    return listProcessesFromPs();
  }
}

/**
 * Build the process subtree rooted at `rootPid` from a flat process list.
 * Children are ordered by PID. Self-references and already-visited PIDs are
 * skipped so a malformed table cannot produce an infinite tree.
 */
export function buildProcessTree(
  procs: ProcInfo[],
  rootPid: number,
): ProcTreeNode {
  const byPid = new Map<number, ProcInfo>();
  const childrenOf = new Map<number, number[]>();
  for (const p of procs) {
    byPid.set(p.pid, p);
    const siblings = childrenOf.get(p.ppid);
    if (siblings) {siblings.push(p.pid);}
    else {childrenOf.set(p.ppid, [p.pid]);}
  }

  const visited = new Set<number>();
  const build = (pid: number): ProcTreeNode => {
    visited.add(pid);
    const info = byPid.get(pid);
    const command = info?.command ?? "";
    const children = (childrenOf.get(pid) ?? [])
      .filter((child) => child !== pid && !visited.has(child))
      .sort((a, b) => a - b)
      .map(build);
    return {
      pid,
      name: info ? deriveName(command) : "assistant",
      command,
      children,
    };
  };

  return build(rootPid);
}
