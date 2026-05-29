/**
 * Indexed / positional reader for LongMemEval-V2 `trajectories.jsonl`.
 *
 * The V2 small-tier trajectories file is ~1 GB packed with 1,870
 * records. The runner needs random access into it — one slice per
 * question, where the slice is between 1 and ~10 trajectory ids out
 * of the full 1,870. PR-6 shipped with the placeholder
 * `loadTrajectories(dataRoot): Promise<Map<...>>` that ate the whole
 * file every `evals run` invocation; Phase 2's 451-Q run × multiple
 * profiles can't tolerate a gigabyte of resident memory plus a
 * multi-second cold start per invocation. PR-7 (this module)
 * replaces that path with:
 *
 *   `openTrajectories(dataRoot): Promise<TrajectoryReader>`
 *
 * returning a positional-read handle over `trajectories.jsonl`,
 * backed by a persistent sibling index file
 * (`trajectories.index.json`) keyed by trajectory id.
 *
 * # On-disk index format
 *
 *     {
 *       "version": 1,
 *       "source": {
 *         "filename": "trajectories.jsonl",
 *         "size":     <bytes>,
 *         "mtimeMs":  <epoch ms>
 *       },
 *       "entries": {
 *         "<trajectory_id>": { "offset": <bytes>, "length": <bytes> },
 *         ...
 *       }
 *     }
 *
 * `length` excludes the trailing newline. At ~80 bytes per entry ×
 * 1,870 entries the index is ~150 KB — small enough to read with a
 * single `JSON.parse` on reopen.
 *
 * # Build vs. reuse
 *
 * On `openTrajectories`:
 *
 *   1. Stat the JSONL file (helpful "missing — run `data/download.sh`"
 *      error if absent).
 *   2. If a sibling index exists AND its recorded `source.filename`,
 *      `source.size` and `source.mtimeMs` match the JSONL's actual
 *      values, load it. The size+mtime guard catches operators who
 *      re-ran `data/download.sh` and got a fresh file under the same
 *      name.
 *   3. Otherwise scan the JSONL once: parse + validate every line
 *      with the same Zod schema the original loader used, record
 *      `{ offset, length }` per id, and atomically write the index
 *      via `.tmp + rename` so a crashed mid-build never leaves a
 *      partial index that the next run mistakes for valid.
 *
 * # Reads
 *
 * `reader.get(id)` does a positional `fd.read` for the recorded byte
 * range, parses the line, and stashes the record in a small LRU.
 * Positional reads against a `FileHandle` use `pread()` under the
 * hood, so concurrent `get` calls don't race on a shared cursor —
 * the materializer can `Promise.all` ten ids without worrying.
 */
import {
  open as fsOpen,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { z } from "zod";

import { type TrajectoryRecord, TrajectoryRecordSchema } from "./trajectories";

/* -- constants --------------------------------------------------- */

const TRAJECTORIES_FILENAME = "trajectories.jsonl";
const INDEX_FILENAME = "trajectories.index.json";
const INDEX_VERSION = 1;

/**
 * Cap on the resident parsed-record cache. ~256 records × a few KB
 * each ≈ at most a few MB — negligible next to the workspace files
 * we materialize from them, and large enough that the hot loop of a
 * single question (which re-reads its haystack across multiple
 * profiles in a single `evals run`) hits cache after the first
 * profile.
 */
const READ_CACHE_CAPACITY = 256;

/** Stream chunk size while scanning JSONL for the index build. */
const BUILD_CHUNK_BYTES = 1024 * 1024;

/* -- index file schema ------------------------------------------ */

const IndexEntrySchema = z.object({
  offset: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
});
const IndexFileSchema = z.object({
  version: z.literal(INDEX_VERSION),
  source: z.object({
    filename: z.string(),
    size: z.number().int().nonnegative(),
    mtimeMs: z.number().nonnegative(),
  }),
  entries: z.record(z.string(), IndexEntrySchema),
});

export type IndexEntry = z.infer<typeof IndexEntrySchema>;
export type IndexFile = z.infer<typeof IndexFileSchema>;

/* -- public reader interface ------------------------------------ */

export interface TrajectoryReader {
  /** O(1) presence check against the index. No I/O. */
  has(id: string): boolean;
  /**
   * Resolve a trajectory id to its parsed record. Throws if the id
   * is unknown to the index; check `has(id)` first if you want to
   * report missing ids in bulk.
   */
  get(id: string): Promise<TrajectoryRecord>;
  /** Release the underlying file handle. Idempotent. */
  close(): Promise<void>;
}

/* -- LRU --------------------------------------------------------- */

class LRU<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly capacity: number) {}
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v === undefined) return undefined;
    // Refresh recency by re-inserting at the tail.
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  set(k: K, v: V): void {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.capacity) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
  }
  get size(): number {
    return this.map.size;
  }
}

/* -- public entry points ---------------------------------------- */

/**
 * Open a `TrajectoryReader` rooted at `dataRoot`.
 *
 * The first call after a fresh `data/download.sh` scans the JSONL
 * once to build a sibling index. Subsequent calls reuse the index
 * unless the JSONL's size or mtime has changed.
 */
export async function openTrajectories(
  dataRoot: string,
): Promise<TrajectoryReader> {
  const root = resolve(dataRoot);
  const jsonlPath = join(root, TRAJECTORIES_FILENAME);
  const indexPath = join(root, INDEX_FILENAME);

  let jsonlStat: { size: number; mtimeMs: number };
  try {
    const s = await stat(jsonlPath);
    jsonlStat = { size: s.size, mtimeMs: s.mtimeMs };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `LongMemEval-V2 trajectories.jsonl not found at ${jsonlPath}. ` +
          "Run `bash data/download.sh` from the benchmark directory.",
      );
    }
    throw err;
  }

  const index = await loadOrBuildIndex({ jsonlPath, indexPath, jsonlStat });
  const fd = await fsOpen(jsonlPath, "r");
  const cache = new LRU<string, TrajectoryRecord>(READ_CACHE_CAPACITY);
  let closed = false;

  return {
    has(id: string): boolean {
      return Object.prototype.hasOwnProperty.call(index.entries, id);
    },
    async get(id: string): Promise<TrajectoryRecord> {
      if (closed) {
        throw new Error("TrajectoryReader is closed");
      }
      const hit = cache.get(id);
      if (hit !== undefined) return hit;

      const entry = index.entries[id];
      if (entry === undefined) {
        throw new Error(
          `Trajectory id "${id}" not present in ${INDEX_FILENAME}. ` +
            "If the dataset was updated under the same filename, delete " +
            "the index and rerun to force a rebuild.",
        );
      }
      const buf = Buffer.alloc(entry.length);
      if (entry.length > 0) {
        await fd.read(buf, 0, entry.length, entry.offset);
      }
      const line = buf.toString("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        throw new Error(
          `Failed to parse trajectories.jsonl line for id "${id}" at ` +
            `offset ${entry.offset}: ${(err as Error).message}`,
        );
      }
      // Light shape check — the build pass already validated this
      // line with the full schema; if it disagrees now without
      // size/mtime changing the file has been corrupted at the byte
      // level. Surface that loudly rather than silently hand the
      // runner an `any`.
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as Record<string, unknown>)["id"] !== "string"
      ) {
        throw new Error(
          `trajectories.jsonl line for id "${id}" at offset ${entry.offset} ` +
            "lost its shape since the index was built — delete the index and rerun.",
        );
      }
      const record = parsed as TrajectoryRecord;
      cache.set(id, record);
      return record;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await fd.close().catch(() => undefined);
    },
  };
}

/**
 * A test-friendly `TrajectoryReader` backed by an in-memory list of
 * records. No disk I/O, no index. Used by the runner test and
 * available to anyone composing a unit-test harness without staging
 * a fixture JSONL on disk.
 */
export function createInMemoryTrajectoryReader(
  records: readonly TrajectoryRecord[],
): TrajectoryReader {
  const map = new Map<string, TrajectoryRecord>();
  for (const r of records) {
    if (map.has(r.id)) {
      throw new Error(`Duplicate trajectory id "${r.id}" in in-memory reader`);
    }
    map.set(r.id, r);
  }
  return {
    has(id: string): boolean {
      return map.has(id);
    },
    async get(id: string): Promise<TrajectoryRecord> {
      const r = map.get(id);
      if (r === undefined) {
        throw new Error(
          `Trajectory id "${id}" not present in in-memory reader`,
        );
      }
      return r;
    },
    async close(): Promise<void> {
      // No file handle to release.
    },
  };
}

/* -- index build / load ----------------------------------------- */

interface LoadOrBuildInput {
  jsonlPath: string;
  indexPath: string;
  jsonlStat: { size: number; mtimeMs: number };
}

async function loadOrBuildIndex(input: LoadOrBuildInput): Promise<IndexFile> {
  const { jsonlPath, indexPath, jsonlStat } = input;
  const existing = await tryLoadIndex(indexPath);
  if (
    existing !== null &&
    existing.source.filename === basename(jsonlPath) &&
    existing.source.size === jsonlStat.size &&
    existing.source.mtimeMs === jsonlStat.mtimeMs
  ) {
    return existing;
  }
  const fresh = await buildIndex(jsonlPath, jsonlStat);
  await writeIndexAtomic(indexPath, fresh);
  return fresh;
}

async function tryLoadIndex(indexPath: string): Promise<IndexFile | null> {
  let raw: string;
  try {
    raw = await readFile(indexPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt index file (e.g. half-written by an earlier crash that
    // somehow bypassed the .tmp+rename atomicity) — silently treat
    // as "no index" and force a rebuild.
    return null;
  }
  const result = IndexFileSchema.safeParse(parsed);
  if (!result.success) {
    // Wrong shape, wrong version, or any other schema mismatch —
    // also force a rebuild rather than guess at recovery.
    return null;
  }
  return result.data;
}

/**
 * Stream the JSONL file once, recording each line's byte offset and
 * length keyed by `record.id`. Validates each line through the
 * canonical Zod schema so corruption surfaces at build time rather
 * than at the first `get` call deep inside a run.
 */
async function buildIndex(
  jsonlPath: string,
  jsonlStat: { size: number; mtimeMs: number },
): Promise<IndexFile> {
  const fd = await fsOpen(jsonlPath, "r");
  const entries: Record<string, IndexEntry> = {};

  // Streaming-scan bookkeeping. `pendingStartOffset + pending.length`
  // is always the total byte count pulled from the stream so far,
  // so the absolute file offset of a line that starts at index `k`
  // of `combined` is `pendingStartOffset + k`. `pending` widens to
  // `Buffer<ArrayBufferLike>` to match the stream's chunk type;
  // `Buffer.alloc(0)` would otherwise pin the binding to the
  // narrower `Buffer<ArrayBuffer>` and refuse the chunk-derived
  // values further down.
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let pendingStartOffset = 0;
  let lineNumber = 0;

  const stream = fd.createReadStream({ highWaterMark: BUILD_CHUNK_BYTES });
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const combined =
        pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let cursor = 0;
      while (true) {
        const nlIndex = combined.indexOf(0x0a /* \n */, cursor);
        if (nlIndex === -1) break;
        const lineBytes = combined.subarray(cursor, nlIndex);
        const absoluteOffset = pendingStartOffset + cursor;
        lineNumber += 1;
        recordLine(lineBytes, absoluteOffset, lineNumber, entries);
        cursor = nlIndex + 1;
      }
      // Whatever remains after the last newline becomes the new tail.
      pending = combined.subarray(cursor);
      pendingStartOffset += cursor;
    }
    // Trailing partial line (no terminating newline).
    if (pending.length > 0) {
      lineNumber += 1;
      recordLine(pending, pendingStartOffset, lineNumber, entries);
    }
  } finally {
    await fd.close();
  }

  return {
    version: INDEX_VERSION,
    source: {
      filename: basename(jsonlPath),
      size: jsonlStat.size,
      mtimeMs: jsonlStat.mtimeMs,
    },
    entries,
  };
}

function recordLine(
  lineBytes: Buffer,
  absoluteOffset: number,
  lineNumber: number,
  entries: Record<string, IndexEntry>,
): void {
  const text = lineBytes.toString("utf8");
  if (text.trim() === "") return; // skip blank lines

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Failed to parse trajectories.jsonl at line ${lineNumber}: ${(err as Error).message}`,
    );
  }
  const result = TrajectoryRecordSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `trajectories.jsonl line ${lineNumber} failed schema validation: ${issues}`,
    );
  }
  const record = result.data;
  if (Object.prototype.hasOwnProperty.call(entries, record.id)) {
    throw new Error(
      `Duplicate trajectory id "${record.id}" at line ${lineNumber} of trajectories.jsonl`,
    );
  }
  entries[record.id] = {
    offset: absoluteOffset,
    length: lineBytes.length,
  };
}

/**
 * Write the index file atomically: stage to `<path>.tmp`, fsync via
 * the close handle, then rename. This guarantees that a crash mid-
 * build never leaves a half-valid index that `tryLoadIndex` would
 * later parse and accept.
 */
async function writeIndexAtomic(
  indexPath: string,
  index: IndexFile,
): Promise<void> {
  const tmpPath = `${indexPath}.tmp`;
  // Pretty-printed for `cat`-ability — the file is ~150 KB at the
  // small tier, so the overhead is negligible.
  const payload = `${JSON.stringify(index, null, 2)}\n`;
  await writeFile(tmpPath, payload, "utf8");
  try {
    await rename(tmpPath, indexPath);
  } catch (err) {
    // Best-effort cleanup of the temp file if the rename failed
    // (rare — same-filesystem rename is atomic on POSIX). Don't mask
    // the original error.
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}
