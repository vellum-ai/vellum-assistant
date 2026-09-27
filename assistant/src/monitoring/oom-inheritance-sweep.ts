/**
 * Resets OOM protection that daemon children inherit at fork.
 *
 * The daemon runs at a strongly negative `oom_score_adj` and every spawn path
 * is meant to reset its child, but a path that forgets leaves a child as
 * protected as the daemon. The monitor sees every process, so it walks the
 * daemon's descendants and writes 0 over any negative value it finds. Raising
 * a score needs no capability. The write is logged so the missed spawn path
 * can be fixed at its source.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseProcStat } from "./proc-wait-state.js";

export interface OomProtectionReset {
  pid: number;
  /** Kernel comm of the process; never the command line, which can carry secrets. */
  comm: string;
  previous: number;
}

export function sweepInheritedOomProtection(options: {
  daemonPid: number;
  /** Descendants allowed to stay negative, such as the monitor itself. */
  keepPids: ReadonlySet<number>;
  procRoot?: string;
}): OomProtectionReset[] {
  const procRoot = options.procRoot ?? "/proc";
  let pids: number[];
  try {
    pids = readdirSync(procRoot)
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number);
  } catch {
    return [];
  }

  const procs = new Map<number, { ppid: number; comm: string }>();
  for (const pid of pids) {
    try {
      const stat = parseProcStat(
        readFileSync(join(procRoot, String(pid), "stat"), "utf-8"),
      );
      if (stat) {
        procs.set(pid, { ppid: stat.ppid, comm: stat.comm });
      }
    } catch {
      // Exited between readdir and read.
    }
  }

  const descendsFromDaemon = (pid: number): boolean => {
    const seen = new Set<number>();
    for (
      let cur = procs.get(pid)?.ppid;
      cur != null && cur > 0 && !seen.has(cur);
      cur = procs.get(cur)?.ppid
    ) {
      if (cur === options.daemonPid) {
        return true;
      }
      seen.add(cur);
    }
    return false;
  };

  const resets: OomProtectionReset[] = [];
  for (const [pid, info] of procs) {
    if (
      pid === options.daemonPid ||
      options.keepPids.has(pid) ||
      !descendsFromDaemon(pid)
    ) {
      continue;
    }
    const path = join(procRoot, String(pid), "oom_score_adj");
    let previous: number;
    try {
      previous = parseInt(readFileSync(path, "utf-8"), 10);
    } catch {
      continue;
    }
    if (!(previous < 0)) {
      continue;
    }
    try {
      writeFileSync(path, "0");
      resets.push({ pid, comm: info.comm, previous });
    } catch {
      // Exited between read and write.
    }
  }
  return resets;
}
