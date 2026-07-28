/**
 * Tests for the quick_check probe. The corruption seed writes junk over a
 * b-tree page of a rollback-journal database (WAL would keep the data in the
 * -wal file, leaving the main file a bare header the check would pass).
 */

import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { assertNotLiveDb } from "../../__tests__/assert-not-live-db.js";
import {
  boundErrors,
  type IntegritySampleResult,
  runIntegrityCheck,
} from "../db-integrity-check.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "integrity-sample-"));
  dbPath = join(dir, "test.db");
});

afterEach(() => {
  assertNotLiveDb(dir);
  rmSync(dir, { recursive: true, force: true });
});

function seedDb(walMode: boolean): void {
  const db = new Database(dbPath);
  try {
    db.exec(`PRAGMA journal_mode=${walMode ? "WAL" : "DELETE"}`);
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)");
    const ins = db.prepare("INSERT INTO t (id, v) VALUES (?, ?)");
    for (let i = 0; i < 200; i++) {
      ins.run(`k-${i}`, `v-${i}`);
    }
  } finally {
    db.close();
  }
}

function corruptDb(): void {
  const fd = openSync(dbPath, "r+");
  try {
    writeSync(fd, Buffer.alloc(32 * 1024, 0xff), 0, 32 * 1024, 4096);
  } finally {
    closeSync(fd);
  }
}

test("returns null when the database does not exist", () => {
  expect(runIntegrityCheck(dbPath)).toBeNull();
});

test("reports ok on a healthy database", () => {
  seedDb(true);
  const result = runIntegrityCheck(dbPath);
  expect(result?.ok).toBe(true);
  expect(result?.errors).toEqual([]);
  expect(result?.pageCount).toBeGreaterThan(0);
});

test("reports corruption instead of throwing", () => {
  seedDb(false);
  corruptDb();
  const result = runIntegrityCheck(dbPath);
  expect(result?.ok).toBe(false);
  expect(result?.errors.length).toBeGreaterThan(0);
});

test("boundErrors caps by UTF-8 bytes without splitting code points", () => {
  const bounded = boundErrors(Array(20).fill("é".repeat(200)));
  expect(bounded.length).toBe(10);
  for (const msg of bounded) {
    expect(Buffer.byteLength(msg, "utf8")).toBeLessThanOrEqual(160);
    expect(msg.includes("�")).toBe(false);
  }
});

test("subprocess entry prints the JSON verdict", () => {
  seedDb(false);
  corruptDb();
  const entry = new URL("../db-integrity-check.ts", import.meta.url).pathname;
  const proc = Bun.spawnSync({ cmd: ["bun", "run", entry, dbPath] });
  expect(proc.exitCode).toBe(0);
  const result = JSON.parse(
    proc.stdout.toString(),
  ) as IntegritySampleResult | null;
  expect(result?.ok).toBe(false);
  expect(result?.errors.length).toBeGreaterThan(0);
});
