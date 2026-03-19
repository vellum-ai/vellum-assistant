import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

const testDir = mkdtempSync(join(tmpdir(), "llm-request-log-provider-"));
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
import { migrateLlmRequestLogProvider } from "../memory/migrations/184-llm-request-log-provider.js";
import * as schema from "../memory/schema.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function getColumnInfo(raw: Database): Array<{ name: string; notnull: number }> {
  return raw.query(`PRAGMA table_info(llm_request_logs)`).all() as Array<{
    name: string;
    notnull: number;
  }>;
}

function bootstrapPreProviderLlmRequestLogs(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE llm_request_logs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      message_id TEXT,
      request_payload TEXT NOT NULL,
      response_payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
}

function removeTestDbFiles(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

describe("llm_request_logs provider migration", () => {
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

  test("fresh DB initialization includes llm_request_logs.provider", () => {
    initializeDb();

    const raw = new Database(dbPath);
    const columns = getColumnInfo(raw);

    expect(columns.some((column) => column.name === "provider")).toBe(true);
    expect(columns.find((column) => column.name === "provider")?.notnull).toBe(
      0,
    );

    raw.close();
  });

  test("migration upgrades the pre-provider schema without disturbing rows", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    bootstrapPreProviderLlmRequestLogs(raw);
    raw.exec(/*sql*/ `
      INSERT INTO llm_request_logs (
        id,
        conversation_id,
        message_id,
        request_payload,
        response_payload,
        created_at
      ) VALUES (
        'log-upgrade',
        'conv-1',
        'msg-1',
        '{}',
        '{"ok":true}',
        1000
      )
    `);

    migrateLlmRequestLogProvider(db);

    expect(getColumnInfo(raw).some((column) => column.name === "provider")).toBe(
      true,
    );

    const row = raw
      .query(
        `SELECT id, conversation_id, message_id, provider, request_payload, response_payload, created_at
         FROM llm_request_logs
         WHERE id = 'log-upgrade'`,
      )
      .get() as
      | {
          id: string;
          conversation_id: string;
          message_id: string | null;
          provider: string | null;
          request_payload: string;
          response_payload: string;
          created_at: number;
        }
      | null;

    expect(row).toEqual({
      id: "log-upgrade",
      conversation_id: "conv-1",
      message_id: "msg-1",
      provider: null,
      request_payload: "{}",
      response_payload: '{"ok":true}',
      created_at: 1000,
    });

    raw.close();
  });

  test("re-running the migration preserves populated provider values", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    bootstrapPreProviderLlmRequestLogs(raw);
    raw.exec(/*sql*/ `
      INSERT INTO llm_request_logs (
        id,
        conversation_id,
        message_id,
        request_payload,
        response_payload,
        created_at
      ) VALUES (
        'log-rerun',
        'conv-2',
        'msg-2',
        '{}',
        '{"ok":true}',
        2000
      )
    `);

    migrateLlmRequestLogProvider(db);
    raw.exec(/*sql*/ `
      UPDATE llm_request_logs
      SET provider = 'anthropic'
      WHERE id = 'log-rerun'
    `);

    expect(() => migrateLlmRequestLogProvider(db)).not.toThrow();

    const row = raw
      .query(
        `SELECT provider FROM llm_request_logs WHERE id = 'log-rerun'`,
      )
      .get() as { provider: string | null } | null;

    expect(row).toEqual({
      provider: "anthropic",
    });

    raw.close();
  });
});
