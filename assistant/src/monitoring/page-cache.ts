/**
 * Page-cache residency attribution for the assistant's large data files, for
 * high-memory snapshots. The memory.stat `file` number says how much page
 * cache the cgroup holds; this says *which files* it is — e.g. "1.3 GB of the
 * cache is assistant.db" — via `fincore(1)` (util-linux), which reports the
 * cached page count per file without touching the file's contents.
 *
 * Reads are best-effort: when the fincore binary is missing or fails, the
 * snapshot records null rather than failing.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { getDataDir, getDbPath } from "../util/platform.js";

const execFileAsync = promisify(execFile);

/** Cap on directory entries visited when hunting for large qdrant files. */
const MAX_WALK_ENTRIES = 20_000;

export interface FileResidency {
  path: string;
  sizeBytes: number;
  /** Bytes of this file currently resident in the page cache. */
  residentBytes: number;
  /** residentBytes / sizeBytes, or null for an empty file. */
  residentRatio: number | null;
}

/**
 * Parse `fincore --bytes --json` output. util-linux emits
 * `{"fincore": [{"res": ..., "pages": ..., "size": ..., "file": ...}]}`;
 * numeric columns are strings on older versions, so values go through
 * Number().
 */
export function parseFincoreJson(stdout: string): FileResidency[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const rows = (parsed as { fincore?: unknown[] })?.fincore;
  if (!Array.isArray(rows)) {
    return [];
  }

  const out: FileResidency[] = [];
  for (const row of rows) {
    const { res, size, file } = row as {
      res?: unknown;
      size?: unknown;
      file?: unknown;
    };
    const residentBytes = Number(res);
    const sizeBytes = Number(size);
    if (
      typeof file !== "string" ||
      !Number.isFinite(residentBytes) ||
      !Number.isFinite(sizeBytes)
    ) {
      continue;
    }
    out.push({
      path: file,
      sizeBytes,
      residentBytes,
      residentRatio: sizeBytes > 0 ? residentBytes / sizeBytes : null,
    });
  }
  return out;
}

/** The largest `limit` regular files under `root`, bounded-walk, largest first. */
function largestFilesUnder(
  root: string,
  limit: number,
): Array<{ path: string; sizeBytes: number }> {
  const found: Array<{ path: string; sizeBytes: number }> = [];
  const queue = [root];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_WALK_ENTRIES) {
    const dir = queue.shift()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visited > MAX_WALK_ENTRIES) {
        break;
      }
      const path = join(dir, entry);
      try {
        const stat = statSync(path);
        if (stat.isDirectory()) {
          queue.push(path);
        } else if (stat.isFile()) {
          found.push({ path, sizeBytes: stat.size });
        }
      } catch {
        // Removed mid-walk — skip.
      }
    }
  }
  found.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return found.slice(0, limit);
}

/**
 * The data files worth attributing cache to: the SQLite database (plus its
 * WAL/shm sidecars) and the largest files under the qdrant storage directory.
 * Only files that currently exist are returned.
 */
export function getTrackedDataFiles(qdrantLimit = 10): string[] {
  const dbPath = getDbPath();
  const candidates = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter((p) =>
    existsSync(p),
  );
  const qdrantFiles = largestFilesUnder(
    join(getDataDir(), "qdrant"),
    qdrantLimit,
  );
  return [...candidates, ...qdrantFiles.map((f) => f.path)];
}

/**
 * Page-cache residency for `paths` via fincore. Null when fincore is
 * unavailable or fails (the binary ships in util-linux-extra); an empty input
 * yields an empty result.
 */
export async function readFileResidency(
  paths: string[],
): Promise<FileResidency[] | null> {
  if (paths.length === 0) {
    return [];
  }
  try {
    const { stdout } = await execFileAsync(
      "fincore",
      ["--bytes", "--json", ...paths],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return parseFincoreJson(stdout);
  } catch {
    return null;
  }
}
