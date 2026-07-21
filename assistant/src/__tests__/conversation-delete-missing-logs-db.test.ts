/**
 * Regression test for the memory worker's startup orphan sweep choking on a
 * not-yet-migrated logs/telemetry DB.
 *
 * The sweep runs in a separate process (`memory worker`) that can race ahead of
 * the daemon's async migrations. Its per-orphan delete clears `llm_request_logs`
 * (logs DB) and pending `telemetry_events` (telemetry DB). Before the fix,
 * opening either connection created an empty, table-less file on disk, so every
 * delete threw `no such table: llm_request_logs` (observed ~2,752×/boot).
 *
 * The sweep reaches `@vellumai/plugin-api.deleteConversation`, which routes to
 * `deleteConversationGently` — so BOTH delete variants are exercised here: the
 * synchronous `deleteConversation` (used by the HTTP route) and the off-loop
 * `deleteConversationGently` (used by the sweep). Both must skip the dedicated
 * sub-deletes when the file is absent (no file → no rows) and must not
 * fabricate an empty file. The conversation itself (main DB) still deletes.
 */

import { existsSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
}));

import type { Database } from "bun:sqlite";

import {
  createConversation,
  deleteConversation,
  deleteConversationGently,
  getConversation,
} from "../persistence/conversation-crud.js";
import {
  getDb,
  getLogsDb,
  getLogsSqlite,
  getTelemetryDb,
  getTelemetrySqlite,
} from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { getLogsDbPath } from "../util/logs-db-path.js";
import { getTelemetryDbPath } from "../util/telemetry-db-path.js";
import { removeTestDbFiles } from "./assert-not-live-db.js";
import { resetDbForTesting } from "./db-test-helpers.js";

await initializeDb();

// Capture the logs/telemetry schema up front so the module `afterAll` can
// rebuild it. `bun test` runs every file in one process against one shared
// workspace, and these tests physically remove the two dedicated files to
// simulate the race — so without a rebuild a later test file that touches
// `llm_request_logs` would hit the empty file this suite left behind. Replaying
// the captured DDL is schema-agnostic (no duplicated column lists to drift).
function captureSchemaDdl(db: Database): string[] {
  return db
    .query<{ sql: string }, []>(
      `SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid`,
    )
    .all()
    .map((r) => r.sql);
}

const logsSchemaDdl = captureSchemaDdl(getLogsSqlite()!);
const telemetrySchemaDdl = captureSchemaDdl(getTelemetrySqlite()!);

function getRawDb(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

/**
 * Simulate the pre-migration race: close every connection and remove the logs
 * and telemetry files so the next accessor sees them as not-yet-created.
 */
function dropDedicatedLogFiles(): void {
  resetDbForTesting();
  removeTestDbFiles(getLogsDbPath());
  removeTestDbFiles(getTelemetryDbPath());
}

beforeEach(() => {
  getRawDb().run("DELETE FROM messages");
  getRawDb().run("DELETE FROM conversations");
});

// Rebuild the logs/telemetry files (which these tests delete) with their
// original schema so later suites in the same process see healthy tables.
afterAll(() => {
  resetDbForTesting();
  const logs = getLogsSqlite()!;
  for (const sql of logsSchemaDdl) {
    logs.run(sql);
  }
  const telemetry = getTelemetrySqlite()!;
  for (const sql of telemetrySchemaDdl) {
    telemetry.run(sql);
  }
});

describe("synchronous deleteConversation with a missing logs/telemetry DB", () => {
  test("does not throw and deletes the conversation when the logs file is absent", () => {
    const conv = createConversation("orphan-retrospective");
    dropDedicatedLogFiles();

    expect(() => deleteConversation(conv.id)).not.toThrow();
    expect(getConversation(conv.id)).toBeNull();
  });

  test("does not fabricate an empty logs or telemetry file on delete", () => {
    const conv = createConversation("orphan-retrospective");
    dropDedicatedLogFiles();

    deleteConversation(conv.id);

    // The delete must not have re-created either dedicated file — recreating it
    // empty (no tables) is exactly what produced the `no such table` storm.
    expect(existsSync(getLogsDbPath())).toBe(false);
    expect(existsSync(getTelemetryDbPath())).toBe(false);
  });

  test("getLogsDb/getTelemetryDb return null for a missing file without creating it", () => {
    dropDedicatedLogFiles();

    expect(getLogsDb({ createIfMissing: false })).toBeNull();
    expect(getTelemetryDb({ createIfMissing: false })).toBeNull();
    expect(existsSync(getLogsDbPath())).toBe(false);
    expect(existsSync(getTelemetryDbPath())).toBe(false);

    // The default (open-or-create) path still creates the file — the migration
    // runner and write path depend on it.
    expect(getLogsDb()).not.toBeNull();
    expect(existsSync(getLogsDbPath())).toBe(true);
  });
});

describe("deleteConversationGently (sweep path) with a missing logs/telemetry DB", () => {
  test("does not throw and deletes the conversation when the logs file is absent", async () => {
    const conv = createConversation("orphan-retrospective");
    dropDedicatedLogFiles();

    await expect(deleteConversationGently(conv.id)).resolves.toBeDefined();
    expect(getConversation(conv.id)).toBeNull();
  });

  test("does not fabricate an empty logs or telemetry file on delete", async () => {
    const conv = createConversation("orphan-retrospective");
    dropDedicatedLogFiles();

    await deleteConversationGently(conv.id);

    // The batched logs drain (and the telemetry delete) must be skipped, not
    // run against a freshly-created empty file — the `no such table` storm was
    // the batch subprocess creating the file and then failing on it.
    expect(existsSync(getLogsDbPath())).toBe(false);
    expect(existsSync(getTelemetryDbPath())).toBe(false);
  });
});
