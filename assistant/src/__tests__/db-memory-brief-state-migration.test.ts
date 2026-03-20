import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

const testDir = mkdtempSync(join(tmpdir(), "memory-brief-state-"));
const dbPath = join(testDir, "test.db");
const originalBunTest = process.env.BUN_TEST;

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => dbPath,
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { initializeDb, resetDb } from "../memory/db.js";
import { getSqliteFrom } from "../memory/db-connection.js";
import { migrateMemoryBriefState } from "../memory/migrations/185-memory-brief-state.js";
import * as schema from "../memory/schema.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function hasTable(raw: Database, tableName: string): boolean {
  const row = raw
    .query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
  return row != null;
}

function hasIndex(raw: Database, indexName: string): boolean {
  const row = raw
    .query(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(indexName);
  return row != null;
}

function getColumnNames(raw: Database, tableName: string): string[] {
  return (
    raw.query(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);
}

function removeTestDbFiles(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

describe("memory brief state migration", () => {
  beforeEach(() => {
    process.env.BUN_TEST = "0";
    resetDb();
    removeTestDbFiles();
  });

  afterEach(() => {
    resetDb();
    removeTestDbFiles();
  });

  afterAll(() => {
    if (originalBunTest === undefined) {
      delete process.env.BUN_TEST;
    } else {
      process.env.BUN_TEST = originalBunTest;
    }
    resetDb();
    removeTestDbFiles();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      /* best effort */
    }
  });

  test("fresh DB initialization creates both tables and their indexes", () => {
    initializeDb();

    const raw = new Database(dbPath);

    // time_contexts table
    expect(hasTable(raw, "time_contexts")).toBe(true);
    expect(getColumnNames(raw, "time_contexts")).toEqual([
      "id",
      "scope_id",
      "summary",
      "source",
      "active_from",
      "active_until",
      "created_at",
      "updated_at",
    ]);
    expect(hasIndex(raw, "idx_time_contexts_scope_active_until")).toBe(true);

    // open_loops table
    expect(hasTable(raw, "open_loops")).toBe(true);
    expect(getColumnNames(raw, "open_loops")).toEqual([
      "id",
      "scope_id",
      "summary",
      "status",
      "source",
      "due_at",
      "surfaced_at",
      "created_at",
      "updated_at",
    ]);
    expect(hasIndex(raw, "idx_open_loops_scope_status_due")).toBe(true);

    raw.close();
  });

  test("migration on an empty DB creates tables and indexes", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    migrateMemoryBriefState(db);

    expect(hasTable(raw, "time_contexts")).toBe(true);
    expect(hasTable(raw, "open_loops")).toBe(true);
    expect(hasIndex(raw, "idx_time_contexts_scope_active_until")).toBe(true);
    expect(hasIndex(raw, "idx_open_loops_scope_status_due")).toBe(true);
  });

  test("re-running the migration preserves existing rows and does not throw", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    const now = Date.now();

    migrateMemoryBriefState(db);

    // Insert rows into both tables
    raw.exec(/*sql*/ `
      INSERT INTO time_contexts (
        id, scope_id, summary, source, active_from, active_until, created_at, updated_at
      ) VALUES (
        'tc-1', 'default', 'User traveling next week', 'conversation', ${now}, ${now + 604800000}, ${now}, ${now}
      )
    `);

    raw.exec(/*sql*/ `
      INSERT INTO open_loops (
        id, scope_id, summary, status, source, due_at, surfaced_at, created_at, updated_at
      ) VALUES (
        'ol-1', 'default', 'Waiting for Bob reply', 'open', 'conversation', ${now + 86400000}, ${now}, ${now}, ${now}
      )
    `);

    // Re-run migration — should not throw
    expect(() => migrateMemoryBriefState(db)).not.toThrow();

    // Verify rows are intact
    const tcRow = raw
      .query(
        `SELECT id, scope_id, summary FROM time_contexts WHERE id = 'tc-1'`,
      )
      .get() as { id: string; scope_id: string; summary: string } | null;

    expect(tcRow).toEqual({
      id: "tc-1",
      scope_id: "default",
      summary: "User traveling next week",
    });

    const olRow = raw
      .query(
        `SELECT id, scope_id, summary, status FROM open_loops WHERE id = 'ol-1'`,
      )
      .get() as {
      id: string;
      scope_id: string;
      summary: string;
      status: string;
    } | null;

    expect(olRow).toEqual({
      id: "ol-1",
      scope_id: "default",
      summary: "Waiting for Bob reply",
      status: "open",
    });
  });
});
