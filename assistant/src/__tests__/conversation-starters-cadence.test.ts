import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { v4 as uuid } from "uuid";

const testDir = mkdtempSync(
  join(tmpdir(), "conversation-starters-cadence-test-"),
);

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { maybeEnqueueConversationStartersJob } from "../memory/conversation-starters-cadence.js";
import {
  CK_CONVERSATION_STARTERS_ITEM_COUNT,
  CK_CONVERSATION_STARTERS_LAST_GEN_AT,
  CONVERSATION_STARTERS_MIN_REGEN_INTERVAL_MS,
  conversationStartersCheckpointKey,
} from "../memory/conversation-starters-policy.js";
import { getSqlite, initializeDb, resetDb } from "../memory/db.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

function clearTables() {
  getSqlite().run("DELETE FROM memory_items");
  getSqlite().run("DELETE FROM memory_jobs");
  getSqlite().run("DELETE FROM memory_checkpoints");
}

function insertMemoryItem(scopeId = "default", firstSeenAt = Date.now()) {
  getSqlite().run(
    `INSERT INTO memory_items (
      id, kind, subject, statement, status, confidence, fingerprint, scope_id, first_seen_at, last_seen_at
    ) VALUES (?, 'fact', 'test', 'test statement', 'active', 0.9, ?, ?, ?, ?)`,
    [uuid(), `fingerprint-${uuid()}`, scopeId, firstSeenAt, firstSeenAt],
  );
}

function insertCheckpoint(key: string, value: string, updatedAt = Date.now()) {
  getSqlite().run(
    `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES (?, ?, ?)`,
    [key, value, updatedAt],
  );
}

function countStarterJobs(): number {
  return (
    getSqlite()
      .query(
        `SELECT COUNT(*) AS count
         FROM memory_jobs
         WHERE type = 'generate_conversation_starters'
           AND status IN ('pending', 'running')`,
      )
      .get() as { count: number }
  ).count;
}

beforeEach(() => {
  clearTables();
});

describe("maybeEnqueueConversationStartersJob", () => {
  test("requires at least five memories before the first generation", () => {
    for (let i = 0; i < 4; i++) {
      insertMemoryItem();
    }

    maybeEnqueueConversationStartersJob("default", 1_000_000);
    expect(countStarterJobs()).toBe(0);

    insertMemoryItem("default", 1_000_001);
    maybeEnqueueConversationStartersJob("default", 1_000_001);
    expect(countStarterJobs()).toBe(1);
  });

  test("uses the bumped thresholds for larger memory sets", () => {
    for (let i = 0; i < 18; i++) {
      insertMemoryItem();
    }

    insertCheckpoint(
      conversationStartersCheckpointKey(
        CK_CONVERSATION_STARTERS_ITEM_COUNT,
        "default",
      ),
      "9",
    );
    maybeEnqueueConversationStartersJob("default", 2_000_000);
    expect(countStarterJobs()).toBe(0);

    clearTables();
    for (let i = 0; i < 18; i++) {
      insertMemoryItem();
    }
    insertCheckpoint(
      conversationStartersCheckpointKey(
        CK_CONVERSATION_STARTERS_ITEM_COUNT,
        "default",
      ),
      "8",
    );
    maybeEnqueueConversationStartersJob("default", 2_000_001);
    expect(countStarterJobs()).toBe(1);
  });

  test("respects the minimum interval after a successful generation", () => {
    for (let i = 0; i < 25; i++) {
      insertMemoryItem();
    }

    insertCheckpoint(
      conversationStartersCheckpointKey(
        CK_CONVERSATION_STARTERS_ITEM_COUNT,
        "default",
      ),
      "0",
    );
    insertCheckpoint(
      conversationStartersCheckpointKey(
        CK_CONVERSATION_STARTERS_LAST_GEN_AT,
        "default",
      ),
      String(3_000_000),
    );

    maybeEnqueueConversationStartersJob(
      "default",
      3_000_000 + CONVERSATION_STARTERS_MIN_REGEN_INTERVAL_MS - 1,
    );
    expect(countStarterJobs()).toBe(0);
  });
});
