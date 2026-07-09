/**
 * A bounded, append-only JSONL ring buffer persisted to disk.
 *
 * The resource monitor writes one sample per tick here so that when the
 * container is OOM-SIGKILL'd — which resets every in-process buffer and cgroup
 * peak — the last samples leading up to the freeze are still on the workspace
 * volume for post-mortem inspection.
 *
 * Bounding is done by rotation rather than rewrite: the active file is appended
 * to until it reaches `capacity` lines, then renamed to `<name>.1` and a fresh
 * active file is started. At most two files exist (`<name>` + `<name>.1`), so
 * disk stays bounded at ~2× capacity while the most recent writes always land
 * in the active file (append is atomic per line and needs no read-modify-write,
 * so a SIGKILL mid-run can lose at most the in-flight line).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";

export class SampleRingBuffer<T> {
  private readonly activePath: string;
  private readonly rotatedPath: string;
  private readonly capacity: number;
  private lineCount: number;

  constructor(path: string, capacity: number) {
    this.activePath = path;
    this.rotatedPath = `${path}.1`;
    this.capacity = Math.max(1, capacity);
    mkdirSync(dirname(path), { recursive: true });
    // Resume line accounting from a prior run so an existing active file
    // rotates at the right point instead of growing unbounded.
    this.lineCount = countLines(this.activePath);
  }

  append(record: T): void {
    appendFileSync(this.activePath, `${JSON.stringify(record)}\n`);
    this.lineCount += 1;
    if (this.lineCount >= this.capacity) {
      renameSync(this.activePath, this.rotatedPath);
      this.lineCount = 0;
    }
  }

  /**
   * Return the most recent `limit` records (default: all retained), oldest
   * first. Reads the rotated file then the active file so ordering is
   * chronological across the rotation boundary. Malformed trailing lines (e.g.
   * a half-written line from a SIGKILL) are skipped.
   */
  readRecent(limit?: number): T[] {
    const records = [
      ...parseJsonl<T>(this.rotatedPath),
      ...parseJsonl<T>(this.activePath),
    ];
    if (limit != null && records.length > limit) {
      return records.slice(records.length - limit);
    }
    return records;
  }

  /** The most recent record, or null when the buffer is empty. */
  readLast(): T | null {
    const recent = this.readRecent(1);
    return recent.length > 0 ? recent[recent.length - 1] : null;
  }
}

function countLines(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const raw = readFileSync(path, "utf-8");
    if (raw.length === 0) return 0;
    let count = 0;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === "\n") count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

function parseJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // Skip a malformed (e.g. partially-written) line.
    }
  }
  return out;
}
