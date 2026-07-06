/**
 * Per-process memory accounting for high-memory snapshots, read from
 * `/proc/<pid>/smaps_rollup` with a `/proc/<pid>/statm` RSS fallback.
 *
 * PSS (proportional set size) divides each shared page's cost across the
 * processes mapping it, so summing PSS over all processes reconciles against
 * the cgroup total — summing RSS double-counts every page the runtime
 * processes share and cannot be added up. The per-process anon vs file split
 * separates heap owned by that process from page cache mapped into it.
 */

import { readdirSync, readFileSync } from "node:fs";

/** Linux page size assumed when converting `/proc/<pid>/statm` pages to bytes. */
const PAGE_SIZE_BYTES = 4096;

export interface SmapsRollup {
  rssBytes: number | null;
  pssBytes: number | null;
  pssAnonBytes: number | null;
  pssFileBytes: number | null;
  pssShmemBytes: number | null;
}

export interface ProcessMemory extends SmapsRollup {
  pid: number;
  command: string;
}

/**
 * Parse `/proc/<pid>/smaps_rollup` content (`Key:  <n> kB` lines). Fields the
 * kernel doesn't expose (the Pss_* split needs Linux ≥ 5.4) are null.
 */
export function parseSmapsRollup(raw: string): SmapsRollup {
  const kb: Record<string, number> = {};
  for (const line of raw.split("\n")) {
    const match = /^(\w+):\s+(\d+)\s+kB/.exec(line.trim());
    if (match) {
      kb[match[1]] = parseInt(match[2], 10);
    }
  }
  const bytes = (key: string) => (kb[key] != null ? kb[key] * 1024 : null);
  return {
    rssBytes: bytes("Rss"),
    pssBytes: bytes("Pss"),
    pssAnonBytes: bytes("Pss_Anon"),
    pssFileBytes: bytes("Pss_File"),
    pssShmemBytes: bytes("Pss_Shmem"),
  };
}

/** PSS when available, else RSS — the sort key for the top-process list. */
export function effectiveSizeBytes(mem: SmapsRollup): number {
  return mem.pssBytes ?? mem.rssBytes ?? 0;
}

function readProcessMemory(pid: number): SmapsRollup | null {
  try {
    return parseSmapsRollup(readFileSync(`/proc/${pid}/smaps_rollup`, "utf-8"));
  } catch {
    // smaps_rollup needs ptrace read access; fall back to statm RSS.
  }
  try {
    const statm = readFileSync(`/proc/${pid}/statm`, "utf-8").trim();
    const residentPages = parseInt(statm.split(/\s+/)[1], 10);
    if (!Number.isFinite(residentPages)) {
      return null;
    }
    return {
      rssBytes: residentPages * PAGE_SIZE_BYTES,
      pssBytes: null,
      pssAnonBytes: null,
      pssFileBytes: null,
      pssShmemBytes: null,
    };
  } catch {
    return null;
  }
}

/**
 * Best-effort snapshot of the top `limit` processes by PSS (RSS when PSS is
 * unavailable), largest first. Empty when `/proc` is unavailable (e.g. macOS)
 * — the high-memory snapshot's process *tree* still captures what was running
 * in that case.
 */
export function topProcessesByMemory(limit: number): ProcessMemory[] {
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((e) => /^\d+$/.test(e));
  } catch {
    return [];
  }

  const rows: ProcessMemory[] = [];
  for (const entry of pids) {
    const pid = Number(entry);
    const mem = readProcessMemory(pid);
    if (mem == null) {
      continue;
    }
    let command: string;
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
      command = raw.split("\0").filter(Boolean).join(" ") || `pid ${pid}`;
    } catch {
      // Process exited between readdir and read — skip.
      continue;
    }
    rows.push({ pid, command, ...mem });
  }

  rows.sort((a, b) => effectiveSizeBytes(b) - effectiveSizeBytes(a));
  return rows.slice(0, limit);
}
