#!/usr/bin/env bun
/**
 * SQLite insert-scaling benchmark: sequential vs. random primary key.
 *
 * Demonstrates how write performance depends on where a new row lands in the
 * table's B-tree. Two `messages` tables are built to the same on-disk size,
 * differing only in their primary key:
 *
 *   - sequential  INTEGER PRIMARY KEY. Monotonic ids always sort to the
 *                 rightmost leaf, so inserts append to one "hot" page.
 *   - random      TEXT PRIMARY KEY holding a UUID, WITHOUT ROWID so the UUID
 *                 clusters the table. New rows sort to random positions,
 *                 scattering writes across the tree (page splits, cache misses).
 *                 This mirrors the real `messages` table, which is keyed by a
 *                 UUID.
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

type Kind = "sequential" | "random";

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

function ddl(kind: Kind): string {
  // Both key `messages` by its primary key. Sequential uses a monotonic integer
  // rowid; random uses a UUID TEXT key with WITHOUT ROWID so the UUID (not a
  // hidden rowid) determines physical row placement — otherwise the table would
  // still append by rowid and the scatter effect would not show.
  return kind === "sequential"
    ? "CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT NOT NULL)"
    : "CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT NOT NULL) WITHOUT ROWID";
}

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
  db.exec(ddl(kind));

  const insert = db.prepare("INSERT INTO messages (id, content) VALUES (?, ?)");
  const insertTx = db.transaction((n: number) => {
    for (let i = 0; i < n; i++) {
      insert.run(kind === "sequential" ? nextSeq++ : crypto.randomUUID(), randomContent());
    }
  });

  let nextSeq = 1;
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
function benchmark(kind: Kind, path: string, startSeq: number): number[] {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  const insert = db.prepare("INSERT INTO messages (id, content) VALUES (?, ?)");
  const insertTx = db.transaction((batch: Array<[number | string, string]>) => {
    for (const [id, content] of batch) insert.run(id, content);
  });

  let seq = startSeq;
  const times: number[] = [];
  for (let b = 0; b < BATCH_COUNT; b++) {
    const batch: Array<[number | string, string]> = [];
    for (let i = 0; i < BATCH_ROWS; i++) {
      batch.push([kind === "sequential" ? seq++ : crypto.randomUUID(), randomContent()]);
    }
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
  console.log("SQLite insert-scaling benchmark");
  console.log(`  Output dir:   ${OUT_DIR}`);
  console.log(`  Target size:  ${fmtBytes(TARGET_BYTES)} per DB`);
  console.log(`  Row size:     ${fmtBytes(MIN_ROW)} – ${fmtBytes(MAX_ROW)}`);
  console.log(`  Benchmark:    ${BATCH_COUNT} batches × ${BATCH_ROWS} rows\n`);

  const seqPath = join(OUT_DIR, "sequential.db");
  const randPath = join(OUT_DIR, "random.db");

  console.log("Filling sequential.db ...");
  const seqFill = fill("sequential", seqPath);
  console.log("Filling random.db ...");
  const randFill = fill("random", randPath);
  console.log("");

  console.log("Benchmarking inserts ...");
  const seqTimes = benchmark("sequential", seqPath, seqFill.rows + 1);
  const randTimes = benchmark("random", randPath, 0);

  const seq = summary(seqTimes);
  const rand = summary(randTimes);

  const line = (label: string, s: ReturnType<typeof summary>) =>
    `  ${label.padEnd(12)} avg ${fmtMs(s.avg).padStart(11)} | median ${fmtMs(s.median).padStart(11)} | min ${fmtMs(s.min).padStart(11)} | max ${fmtMs(s.max).padStart(11)}`;

  console.log("\nPer-batch insert time (50 rows/batch):");
  console.log(line("sequential", seq));
  console.log(line("random", rand));

  const ratioAvg = rand.avg / seq.avg;
  const ratioMed = rand.median / seq.median;
  console.log(
    `\nRandom-key inserts were ${ratioAvg.toFixed(2)}× the sequential time on average (${ratioMed.toFixed(2)}× by median).`,
  );

  // GitHub Actions job summary
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    const rowsTable = seqTimes
      .map((t, i) => `| ${i + 1} | ${t.toFixed(2)} | ${randTimes[i].toFixed(2)} |`)
      .join("\n");
    const md = `## SQLite insert-scaling benchmark

Each DB filled to **${fmtBytes(seqFill.bytes)}** (sequential, ${seqFill.rows.toLocaleString()} rows) /
**${fmtBytes(randFill.bytes)}** (random, ${randFill.rows.toLocaleString()} rows) with JSON \`content\` rows of ${fmtBytes(MIN_ROW)}–${fmtBytes(MAX_ROW)},
then timed **${BATCH_COUNT} × ${BATCH_ROWS}-row** insert batches.

| Key type | Avg | Median | Min | Max |
|----------|-----|--------|-----|-----|
| Sequential (INTEGER PK) | ${fmtMs(seq.avg)} | ${fmtMs(seq.median)} | ${fmtMs(seq.min)} | ${fmtMs(seq.max)} |
| Random (UUID TEXT PK, WITHOUT ROWID) | ${fmtMs(rand.avg)} | ${fmtMs(rand.median)} | ${fmtMs(rand.min)} | ${fmtMs(rand.max)} |

**Random-key inserts were ${ratioAvg.toFixed(2)}× the sequential time on average (${ratioMed.toFixed(2)}× by median).**

<details><summary>Per-batch times (ms)</summary>

| Batch | Sequential | Random |
|-------|-----------|--------|
${rowsTable}

</details>
`;
    appendFileSync(summaryFile, md);
  }
}

main();
