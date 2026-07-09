#!/usr/bin/env bun
/**
 * SQLite insert-scaling benchmark: UUIDv7 vs. UUIDv4 primary key.
 *
 * Demonstrates how write performance depends on where a new row lands in the
 * table's B-tree. Two `messages` tables are built to the same on-disk size with
 * identical schema — `id TEXT PRIMARY KEY ... WITHOUT ROWID` so the UUID
 * clusters the table — differing only in how the id is generated:
 *
 *   - uuidv7  Time-ordered (RFC 9562). The 48-bit millisecond timestamp in the
 *             high bits makes ids monotonic, so inserts append to the rightmost
 *             leaf, hitting one "hot" page.
 *   - uuidv4  Fully random. Ids sort to random positions, scattering writes
 *             across the whole tree (page splits, cache misses).
 *
 * Both store `content` as JSON text in the same shape as the real
 * `messages.content` column: a stringified array of content blocks
 * (`[{ "type": "text", "text": ... }]`), sized between MIN_ROW and MAX_ROW.
 *
 * Both are filled to TARGET_BYTES first, then we time BATCH_COUNT transactions
 * of BATCH_ROWS inserts against each and compare.
 *
 * Usage:
 *   bun run benchmarking/sqlite/bench-insert-scaling.ts
 *
 * Options (env vars):
 *   OUT_DIR         - Directory for the .db files (default: cwd)
 *   TARGET_BYTES    - Fill each DB to this size    (default: 5 GiB)
 *   MIN_ROW_BYTES   - Smallest content payload      (default: 5 KiB)
 *   MAX_ROW_BYTES   - Largest content payload       (default: 50 KiB)
 *   BATCH_ROWS      - Rows per measured batch        (default: 50)
 *   BATCH_COUNT     - Measured batches per DB        (default: 10)
 *   FILL_TX_ROWS    - Rows per fill transaction      (default: 500)
 */

import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = process.env.OUT_DIR ?? process.cwd();
const TARGET_BYTES = Number(process.env.TARGET_BYTES ?? 5 * 1024 * 1024 * 1024);
const MIN_ROW = Number(process.env.MIN_ROW_BYTES ?? 5 * 1024);
const MAX_ROW = Number(process.env.MAX_ROW_BYTES ?? 50 * 1024);
const BATCH_ROWS = Number(process.env.BATCH_ROWS ?? 50);
const BATCH_COUNT = Number(process.env.BATCH_COUNT ?? 10);
const FILL_TX_ROWS = Number(process.env.FILL_TX_ROWS ?? 500);

type Kind = "uuidv7" | "uuidv4";

function toUuid(b: Uint8Array): string {
  let h = "";
  for (let i = 0; i < 16; i++) h += b[i].toString(16).padStart(2, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Monotonic UUIDv7 (RFC 9562): 48-bit ms timestamp, then a 12-bit per-ms
// counter in rand_a so ids stay strictly increasing even within a single
// millisecond (a fast insert burst), then a random tail. Bun/Node have no
// native v7 generator, so we build it here rather than pull in a dependency.
let v7LastMs = 0;
let v7Seq = 0;
function uuidv7(): string {
  let ts = Date.now();
  if (ts <= v7LastMs) {
    ts = v7LastMs;
    v7Seq += 1;
    if (v7Seq > 0xfff) {
      ts = v7LastMs + 1; // borrow into the next ms if the counter overflows
      v7Seq = 0;
    }
  } else {
    v7Seq = 0;
  }
  v7LastMs = ts;

  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[0] = Math.floor(ts / 2 ** 40) % 256;
  b[1] = Math.floor(ts / 2 ** 32) % 256;
  b[2] = Math.floor(ts / 2 ** 24) % 256;
  b[3] = Math.floor(ts / 2 ** 16) % 256;
  b[4] = Math.floor(ts / 2 ** 8) % 256;
  b[5] = ts % 256;
  b[6] = 0x70 | ((v7Seq >> 8) & 0x0f); // version 7 + high nibble of counter
  b[7] = v7Seq & 0xff; // low byte of counter
  b[8] = 0x80 | (b[8] & 0x3f); // variant
  return toUuid(b);
}

function keyFor(kind: Kind): string {
  return kind === "uuidv7" ? uuidv7() : crypto.randomUUID(); // randomUUID() is v4
}

// A pool of JSON-safe characters to draw content-block text from. Content is
// irrelevant to the benchmark (SQLite does not dedupe); only the size and shape
// of the JSON matter, so we slice this pool instead of generating fresh text.
const CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,";
const POOL_LEN = MAX_ROW * 2;
const poolBytes = new Uint8Array(POOL_LEN);
crypto.getRandomValues(poolBytes);
let TEXT_POOL = "";
for (let i = 0; i < POOL_LEN; i++) TEXT_POOL += CHARS[poolBytes[i] % CHARS.length];

// Overhead of the JSON wrapper around the text, so a payload lands near target.
const WRAP = JSON.stringify([{ type: "text", text: "" }]).length;

/** A JSON content-block payload, matching the `messages.content` schema. */
function randomContent(): string {
  const target = MIN_ROW + Math.floor(Math.random() * (MAX_ROW - MIN_ROW + 1));
  const textLen = Math.max(0, target - WRAP);
  const offset = Math.floor(Math.random() * (TEXT_POOL.length - textLen));
  const text = TEXT_POOL.slice(offset, offset + textLen);
  return JSON.stringify([{ type: "text", text }]);
}

function fmtBytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(2)} ${units[u]}`;
}

function fmtMs(n: number): string {
  return `${n.toFixed(2)} ms`;
}

// Identical schema for both tables — `id` is a UUID TEXT primary key and
// WITHOUT ROWID makes that UUID (not a hidden rowid) determine physical row
// placement. The only variable is how the UUID is generated.
const DDL = "CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT NOT NULL) WITHOUT ROWID";

/** Fill a fresh DB to TARGET_BYTES. Uses fast, non-durable pragmas — the fill
 *  is setup, not part of the measurement. */
function fill(kind: Kind, path: string): { rows: number; bytes: number } {
  if (existsSync(path)) rmSync(path);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) rmSync(path + suffix);
  }

  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = OFF");
  db.exec("PRAGMA synchronous = OFF");
  db.exec("PRAGMA cache_size = -1048576"); // 1 GiB cache to keep the fill quick
  db.exec(DDL);

  const insert = db.prepare("INSERT INTO messages (id, content) VALUES (?, ?)");
  const insertTx = db.transaction((n: number) => {
    for (let i = 0; i < n; i++) insert.run(keyFor(kind), randomContent());
  });

  let rows = 0;
  let bytes = 0;
  let nextLog = 512 * 1024 * 1024;
  const started = performance.now();

  while (bytes < TARGET_BYTES) {
    insertTx(FILL_TX_ROWS);
    rows += FILL_TX_ROWS;
    bytes = statSync(path).size;
    if (bytes >= nextLog) {
      const secs = (performance.now() - started) / 1000;
      console.log(
        `  [${kind}] filled ${fmtBytes(bytes)} (${rows.toLocaleString()} rows, ${secs.toFixed(0)}s)`,
      );
      nextLog += 512 * 1024 * 1024;
    }
  }

  db.close();
  return { rows, bytes };
}

/** Time BATCH_COUNT transactions of BATCH_ROWS inserts against an already-filled
 *  DB. Reopened with default (small) cache and realistic durability pragmas so
 *  the page-locality effect is visible. */
function benchmark(kind: Kind, path: string): number[] {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  const insert = db.prepare("INSERT INTO messages (id, content) VALUES (?, ?)");
  const insertTx = db.transaction((batch: Array<[string, string]>) => {
    for (const [id, content] of batch) insert.run(id, content);
  });

  const times: number[] = [];
  for (let b = 0; b < BATCH_COUNT; b++) {
    const batch: Array<[string, string]> = [];
    for (let i = 0; i < BATCH_ROWS; i++) batch.push([keyFor(kind), randomContent()]);
    const t0 = performance.now();
    insertTx(batch);
    times.push(performance.now() - t0);
  }

  db.close();
  return times;
}

function summary(times: number[]) {
  const sorted = [...times].sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  return {
    avg: sum / times.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: sorted[Math.floor(sorted.length / 2)],
  };
}

function main() {
  console.log("SQLite insert-scaling benchmark — UUIDv7 vs UUIDv4");
  console.log(`  Output dir:   ${OUT_DIR}`);
  console.log(`  Target size:  ${fmtBytes(TARGET_BYTES)} per DB`);
  console.log(`  Row size:     ${fmtBytes(MIN_ROW)} – ${fmtBytes(MAX_ROW)}`);
  console.log(`  Benchmark:    ${BATCH_COUNT} batches × ${BATCH_ROWS} rows\n`);

  const v7Path = join(OUT_DIR, "uuidv7.db");
  const v4Path = join(OUT_DIR, "uuidv4.db");

  console.log("Filling uuidv7.db ...");
  const v7Fill = fill("uuidv7", v7Path);
  console.log("Filling uuidv4.db ...");
  const v4Fill = fill("uuidv4", v4Path);
  console.log("");

  console.log("Benchmarking inserts ...");
  const v7Times = benchmark("uuidv7", v7Path);
  const v4Times = benchmark("uuidv4", v4Path);

  const v7 = summary(v7Times);
  const v4 = summary(v4Times);

  const line = (label: string, s: ReturnType<typeof summary>) =>
    `  ${label.padEnd(8)} avg ${fmtMs(s.avg).padStart(11)} | median ${fmtMs(s.median).padStart(11)} | min ${fmtMs(s.min).padStart(11)} | max ${fmtMs(s.max).padStart(11)}`;

  console.log("\nPer-batch insert time (50 rows/batch):");
  console.log(line("uuidv7", v7));
  console.log(line("uuidv4", v4));

  const ratioAvg = v4.avg / v7.avg;
  const ratioMed = v4.median / v7.median;
  console.log(
    `\nUUIDv4 (random) inserts were ${ratioAvg.toFixed(2)}× the UUIDv7 time on average (${ratioMed.toFixed(2)}× by median).`,
  );

  // GitHub Actions job summary
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    const rowsTable = v7Times
      .map((t, i) => `| ${i + 1} | ${t.toFixed(2)} | ${v4Times[i].toFixed(2)} |`)
      .join("\n");
    const md = `## SQLite insert-scaling benchmark — UUIDv7 vs UUIDv4

Each DB filled to **${fmtBytes(v7Fill.bytes)}** (uuidv7, ${v7Fill.rows.toLocaleString()} rows) /
**${fmtBytes(v4Fill.bytes)}** (uuidv4, ${v4Fill.rows.toLocaleString()} rows) with JSON \`content\` rows of ${fmtBytes(MIN_ROW)}–${fmtBytes(MAX_ROW)}.
Identical \`messages\` schema (\`id TEXT PRIMARY KEY ... WITHOUT ROWID\`); only the id generator differs.
Then timed **${BATCH_COUNT} × ${BATCH_ROWS}-row** insert batches.

| Key type | Avg | Median | Min | Max |
|----------|-----|--------|-----|-----|
| UUIDv7 (time-ordered) | ${fmtMs(v7.avg)} | ${fmtMs(v7.median)} | ${fmtMs(v7.min)} | ${fmtMs(v7.max)} |
| UUIDv4 (random) | ${fmtMs(v4.avg)} | ${fmtMs(v4.median)} | ${fmtMs(v4.min)} | ${fmtMs(v4.max)} |

**UUIDv4 inserts were ${ratioAvg.toFixed(2)}× the UUIDv7 time on average (${ratioMed.toFixed(2)}× by median).**

<details><summary>Per-batch times (ms)</summary>

| Batch | UUIDv7 | UUIDv4 |
|-------|--------|--------|
${rowsTable}

</details>
`;
    appendFileSync(summaryFile, md);
  }
}

main();
