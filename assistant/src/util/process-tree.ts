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

import {
  listProcessTableAsync,
  type ProcessTableRow,
  readRawProcessCommand,
} from "./process-table.js";

/**
 * Whether a process runs plugin-owned code or is the daemon itself / one of its
 * workspace subsystems. Classified at collection time from the raw command line
 * via {@link deriveOrigin}. Plugin processes carry their plugin identity as
 * `plugin:<name>` — bundled defaults read as `plugin:default-<name>` (e.g.
 * `plugin:default-memory`), user plugins as `plugin:<name>` (e.g.
 * `plugin:cognee`).
 */
export type ProcessOrigin = "workspace" | `plugin:${string}`;

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
  /** Whether this process was spawned from a plugin or from the workspace. */
  origin: ProcessOrigin;
}

export interface ProcTreeNode {
  pid: number;
  /** Friendly process name derived from the command. */
  name: string;
  /** Safe process descriptor (redacted via deriveName at collection time). */
  command: string;
  /** Whether this process was spawned from a plugin or from the workspace. */
  origin: ProcessOrigin;
  children: ProcTreeNode[];
}

interface ProcessTreeBuilder {
  build: (pid: number) => ProcTreeNode;
  byPid: Map<number, ProcInfo>;
  visited: Set<number>;
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

const basename = (p: string): string => p.split(/[\\/]/).pop() || p;

function splitCommand(command: string): string[] {
  return Array.from(
    command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g),
    (match) => match[1] ?? match[2] ?? match[3],
  );
}

/** Script extensions whose path we summarize as `<parent>-<file>`. */
const SCRIPT_EXT_RE = /\.(ts|js|mjs|cjs|py)$/;

/**
 * Summarize a script path as `<parent-dir>-<filename-without-ext>` so the worker
 * at `…/memory/worker.ts` reads as `memory-worker` and the daemon entry
 * `…/daemon/main.ts` as `daemon-main`. Falls back to the bare extensionless
 * filename when the script sits at the filesystem root.
 */
function scriptName(scriptPath: string): string {
  const parts = scriptPath.split(/[\\/]/).filter(Boolean);
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
  const tokens = splitCommand(command.trim());
  if (tokens.length === 0) {
    return "(unknown)";
  }

  const argv0 = basename(tokens[0]);
  const runtimeName = argv0.replace(/\.exe$/i, "").toLowerCase();
  if (RUNTIMES.has(runtimeName)) {
    const args = tokens.slice(1);
    const script = args.find((t) => SCRIPT_EXT_RE.test(t));
    if (script) {
      return scriptName(script);
    }
    // No script to summarize: show the non-flag arguments so the entry reads as
    // "what was run" rather than an opaque `bun`. Flags are dropped as noise.
    const meaningful = args.filter((t) => !t.startsWith("-"));
    if (meaningful.length > 0) {
      return `${runtimeName} ${meaningful.join(" ")}`;
    }
  }
  return argv0;
}

/**
 * Redacted command descriptor for a live PID from `/proc/<pid>/cmdline`, or
 * null when the process is gone or its `/proc` entry is unreadable. Kernel
 * threads have an empty command line and read as `(unknown)`.
 *
 * The raw command line is read here but never returned: it can carry secrets
 * (bearer tokens, API keys, database URLs) passed as process arguments, so
 * callers that record process identity in snapshots or logs get only the
 * {@link deriveName} descriptor.
 */
export function readProcessCommand(pid: number): string | null {
  const command = readRawProcessCommand(pid);
  return command == null ? null : deriveName(command);
}

/**
 * Captures the plugin path segment(s) from a command whose executable/script
 * path lives under a `plugins/<name>/` directory. Group 1 is the first segment
 * after `plugins/`; group 2 is the next segment (present for bundled defaults,
 * where the layout is `plugins/defaults/<name>/`). Matches both user plugins
 * (`<workspaceDir>/plugins/<name>/`) and bundled defaults
 * (`.../plugins/defaults/<name>/`). The `plugins-data/` state directory is
 * deliberately not matched — the slash after `plugins` excludes it.
 */
const PLUGIN_PATH_RE =
  /(?:^|[\\/])plugins[\\/]([^\\/\s]+)(?:[\\/]([^\\/\s]+))?/;

/**
 * Classify whether a raw command line belongs to plugin-owned code, and if so
 * which plugin. A process spawned from a plugin runs an entry script that lives
 * under a `plugins/<name>/` directory; the daemon itself and its workspace
 * subsystems (qdrant, the embed worker, the resource monitor) do not.
 *
 * Plugin identity is folded into the origin:
 *   - bundled defaults at `…/plugins/defaults/memory/worker.ts` → `plugin:default-memory`
 *   - user plugins at `…/plugins/cognee/server.ts`             → `plugin:cognee`
 *
 * This is a best-effort heuristic on the command path — a plugin that shells
 * out to a bare binary with no plugin path in its argv reads as `workspace`.
 */
export function deriveOrigin(command: string): ProcessOrigin {
  const m = PLUGIN_PATH_RE.exec(command);
  if (!m) {
    return "workspace";
  }
  const [, first, second] = m;
  // Bundled defaults nest the plugin name one level deeper under `defaults/`.
  const name = first === "defaults" && second ? `default-${second}` : first;
  return `plugin:${name}`;
}

/**
 * Enumerate the live process table as `(pid, ppid, command)` rows. Prefers
 * Linux `/proc`, uses `ps` on macOS, and queries Win32_Process on Windows.
 */
export async function listProcesses(
  rows?: ProcessTableRow[],
): Promise<ProcInfo[]> {
  const processRows = rows ?? (await listProcessTableAsync());
  return processRows.map(({ pid, ppid, command }) => ({
    pid,
    ppid,
    command: deriveName(command),
    origin: deriveOrigin(command),
  }));
}

function createProcessTreeBuilder(procs: ProcInfo[]): ProcessTreeBuilder {
  const byPid = new Map<number, ProcInfo>();
  const childrenOf = new Map<number, number[]>();
  for (const p of procs) {
    byPid.set(p.pid, p);
    const siblings = childrenOf.get(p.ppid);
    if (siblings) {
      siblings.push(p.pid);
    } else {
      childrenOf.set(p.ppid, [p.pid]);
    }
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
      // A synthesized root (daemon PID absent from the table) is the workspace.
      origin: info?.origin ?? "workspace",
      children,
    };
  };

  return { build, byPid, visited };
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
  return createProcessTreeBuilder(procs).build(rootPid);
}

/** Build a synthetic system root containing every enumerated process once. */
export function buildSystemProcessTree(procs: ProcInfo[]): ProcTreeNode {
  const { build, byPid, visited } = createProcessTreeBuilder(procs);
  const children: ProcTreeNode[] = [];
  const orderedProcesses = [...byPid.values()].sort((a, b) => a.pid - b.pid);

  for (const processInfo of orderedProcesses) {
    if (
      processInfo.ppid !== processInfo.pid &&
      !byPid.has(processInfo.ppid) &&
      !visited.has(processInfo.pid)
    ) {
      children.push(build(processInfo.pid));
    }
  }

  // Malformed process tables can contain parent cycles with no natural root.
  for (const processInfo of orderedProcesses) {
    if (!visited.has(processInfo.pid)) {
      children.push(build(processInfo.pid));
    }
  }

  return {
    pid: 0,
    name: "system",
    command: "",
    origin: "workspace",
    children,
  };
}
