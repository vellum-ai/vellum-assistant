import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import {
  type DurableProfileFields,
  resolveDurableProfile,
} from "../conversation-crud.js";

// The migration resolves through the shared schedule helpers, which read the
// workspace config. The default is stubbed so both of its outcomes can be
// driven: a named profile, and the code-owned anchor (null), which has no key
// to record. The wake seed keeps the real durable-pin reader so the
// session-backed vs. sticky distinction under test is the production one.
let resolvedDefault: string | null = "balanced";
mock.module("../../schedule/inference-profile.js", () => ({
  resolveDefaultScheduleInferenceProfile: () => resolvedDefault,
  resolveWakeScheduleInferenceProfile: (target: DurableProfileFields | null) =>
    resolveDurableProfile(target) ?? resolvedDefault,
}));

import * as schema from "../schema.js";
import { migrateBackfillScheduleInferenceProfile } from "./363-backfill-schedule-inference-profile.js";

function createTestDb(withProfileColumn = true) {
  const sqlite = new Database(":memory:");
  sqlite.exec(/*sql*/ `
    CREATE TABLE cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      message TEXT NOT NULL,
      next_run_at INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'execute',
      wake_conversation_id TEXT${withProfileColumn ? ",\n      inference_profile TEXT" : ""}
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      conversation_type TEXT,
      inference_profile TEXT,
      inference_profile_session_id TEXT,
      inference_profile_expires_at INTEGER
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function insertJob(
  sqlite: Database,
  id: string,
  inferenceProfile: string | null,
): void {
  sqlite
    .query(
      "INSERT INTO cron_jobs (id, name, message, next_run_at, inference_profile) VALUES (?, ?, ?, ?, ?)",
    )
    .run(id, id, "hi", 1000, inferenceProfile);
}

function insertWakeJob(
  sqlite: Database,
  id: string,
  wakeConversationId: string,
): void {
  sqlite
    .query(
      "INSERT INTO cron_jobs (id, name, message, next_run_at, mode, wake_conversation_id, inference_profile) VALUES (?, ?, ?, ?, 'wake', ?, NULL)",
    )
    .run(id, id, "hi", 1000, wakeConversationId);
}

function insertConversation(
  sqlite: Database,
  id: string,
  fields: {
    inferenceProfile?: string | null;
    sessionId?: string | null;
    expiresAt?: number | null;
  } = {},
): void {
  sqlite
    .query(
      "INSERT INTO conversations (id, conversation_type, inference_profile, inference_profile_session_id, inference_profile_expires_at) VALUES (?, 'chat', ?, ?, ?)",
    )
    .run(
      id,
      fields.inferenceProfile ?? null,
      fields.sessionId ?? null,
      fields.expiresAt ?? null,
    );
}

function profileOf(sqlite: Database, id: string): unknown {
  return (
    sqlite
      .query("SELECT inference_profile FROM cron_jobs WHERE id = ?")
      .get(id) as { inference_profile: unknown }
  ).inference_profile;
}

describe("migration 363: backfill cron_jobs.inference_profile", () => {
  beforeEach(() => {
    resolvedDefault = "balanced";
  });

  test("pins unpinned rows to the resolved default", () => {
    const { sqlite, db } = createTestDb();
    insertJob(sqlite, "unpinned-1", null);
    insertJob(sqlite, "unpinned-2", null);

    migrateBackfillScheduleInferenceProfile(db);

    expect(profileOf(sqlite, "unpinned-1")).toBe("balanced");
    expect(profileOf(sqlite, "unpinned-2")).toBe("balanced");
  });

  test("leaves an existing pin alone", () => {
    const { sqlite, db } = createTestDb();
    insertJob(sqlite, "pinned", "cost-optimized");

    migrateBackfillScheduleInferenceProfile(db);

    expect(profileOf(sqlite, "pinned")).toBe("cost-optimized");
  });

  test("is idempotent: a second run changes nothing", () => {
    const { sqlite, db } = createTestDb();
    insertJob(sqlite, "unpinned", null);

    migrateBackfillScheduleInferenceProfile(db);
    resolvedDefault = "cost-optimized";
    migrateBackfillScheduleInferenceProfile(db);

    // The row was pinned by the first run, so the later default does not
    // overwrite it. That is what makes a schedule's cost stable.
    expect(profileOf(sqlite, "unpinned")).toBe("balanced");
  });

  test("leaves rows null when no named profile resolves", () => {
    const { sqlite, db } = createTestDb();
    insertJob(sqlite, "unpinned", null);
    resolvedDefault = null;

    migrateBackfillScheduleInferenceProfile(db);

    expect(profileOf(sqlite, "unpinned")).toBeNull();
  });

  test("skips an install that has no inference_profile column yet", () => {
    const { sqlite, db } = createTestDb(false);
    sqlite
      .query(
        "INSERT INTO cron_jobs (id, name, message, next_run_at) VALUES ('legacy', 'legacy', 'hi', 1000)",
      )
      .run();

    expect(() => migrateBackfillScheduleInferenceProfile(db)).not.toThrow();
  });

  // A pending wake fires with no forced override today, so it resolves its
  // target conversation's pin live. The backfill has to preserve that, or a
  // reminder set inside a pinned conversation silently moves to the global
  // default.
  describe("wake rows seed from their target conversation", () => {
    test("takes the target's durable pin", () => {
      const { sqlite, db } = createTestDb();
      insertConversation(sqlite, "conv-pinned", {
        inferenceProfile: "cost-optimized",
      });
      insertWakeJob(sqlite, "wake-pinned", "conv-pinned");

      migrateBackfillScheduleInferenceProfile(db);

      expect(profileOf(sqlite, "wake-pinned")).toBe("cost-optimized");
    });

    test("takes the default when the target has no pin, as does an ordinary schedule", () => {
      const { sqlite, db } = createTestDb();
      insertConversation(sqlite, "conv-unpinned");
      insertWakeJob(sqlite, "wake-unpinned", "conv-unpinned");
      insertJob(sqlite, "ordinary", null);

      migrateBackfillScheduleInferenceProfile(db);

      expect(profileOf(sqlite, "wake-unpinned")).toBe("balanced");
      expect(profileOf(sqlite, "ordinary")).toBe("balanced");
    });

    test("ignores a session-backed pin on the target", () => {
      const { sqlite, db } = createTestDb();
      insertConversation(sqlite, "conv-session", {
        inferenceProfile: "cost-optimized",
        sessionId: "session-1",
        expiresAt: Date.now() + 600_000,
      });
      insertWakeJob(sqlite, "wake-session", "conv-session");

      migrateBackfillScheduleInferenceProfile(db);

      // The session lapses in minutes; the row it seeded would keep billing
      // that model for as long as the wake stays pending.
      expect(profileOf(sqlite, "wake-session")).toBe("balanced");
    });

    test("takes the default when the target conversation is gone", () => {
      const { sqlite, db } = createTestDb();
      insertWakeJob(sqlite, "wake-orphan", "conv-deleted");

      migrateBackfillScheduleInferenceProfile(db);

      expect(profileOf(sqlite, "wake-orphan")).toBe("balanced");
    });

    test("keeps the target's pin even when no default resolves", () => {
      const { sqlite, db } = createTestDb();
      resolvedDefault = null;
      insertConversation(sqlite, "conv-pinned", {
        inferenceProfile: "cost-optimized",
      });
      insertWakeJob(sqlite, "wake-pinned", "conv-pinned");
      insertJob(sqlite, "ordinary", null);

      migrateBackfillScheduleInferenceProfile(db);

      expect(profileOf(sqlite, "wake-pinned")).toBe("cost-optimized");
      expect(profileOf(sqlite, "ordinary")).toBeNull();
    });
  });
});
