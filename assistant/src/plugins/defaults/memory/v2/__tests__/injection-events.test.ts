/**
 * Tests for `assistant/src/memory/v2/injection-events.ts` and its sibling
 * migration `256-memory-v2-injection-events.ts`.
 *
 * Coverage matrix:
 *   - Migration creates the table + both indexes; safe to re-run.
 *   - Backfill replays router-sourced concepts from memory_v2_activation_logs
 *     and is idempotent on a forced re-run with cleared checkpoint.
 *   - Backfill is a no-op when the activation-logs table doesn't exist
 *     (pre-234 DB).
 *   - recordInjectionEvents appends one row per slug per call; empty list
 *     is a no-op.
 *   - computeInjectionScore matches the closed-form decay at known deltas
 *     (0d ≈ 1, 3d ≈ 0.5, 6d ≈ 0.25) and sums multiple events linearly.
 *   - computeInjectionScores returns the same per-slug values in batch and
 *     omits slugs with no events.
 *
 * Uses an in-memory bun:sqlite database — no real workspace DB.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import type { DrizzleDb } from "../../../../../persistence/db-connection.js";
import { getSqliteFrom } from "../../../../../persistence/db-connection.js";
import { migrateMemoryV2ActivationLogs } from "../../../../../persistence/migrations/234-memory-v2-activation-logs.js";
import {
  downMemoryV2InjectionEvents,
  migrateMemoryV2InjectionEvents,
} from "../../../../../persistence/migrations/256-memory-v2-injection-events.js";
import * as schema from "../../../../../persistence/schema/index.js";
import {
  computeInjectionScore,
  computeInjectionScores,
  INJECTION_SCORE_HALF_LIFE_MS,
  recordInjectionEvents,
} from "../injection-events.js";

// memory_checkpoints is required by withCrashRecovery and is normally
// created by an early core migration. Stand it up by hand so we can run
// the v2 migrations in isolation against a fresh in-memory DB.
const CHECKPOINTS_DDL = /*sql*/ `
  CREATE TABLE memory_checkpoints (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`;

let sqlite: Database;
let database: DrizzleDb;

beforeEach(() => {
  sqlite = new Database(":memory:");
  database = drizzle(sqlite, { schema });
  getSqliteFrom(database).exec(CHECKPOINTS_DDL);
});

afterEach(() => {
  sqlite.close();
});

function insertActivationLog(
  rawDb: Database,
  args: {
    id: string;
    concepts: Array<{ slug: string; source: string; status?: string }>;
    createdAt: number;
  },
): void {
  rawDb
    .prepare(
      `INSERT INTO memory_v2_activation_logs (
        id, conversation_id, message_id, turn, mode,
        concepts_json, skills_json, config_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.id,
      "conv-1",
      `msg-${args.id}`,
      1,
      "router",
      JSON.stringify(args.concepts),
      "[]",
      "{}",
      args.createdAt,
    );
}

describe("migrateMemoryV2InjectionEvents", () => {
  test("creates table and both indexes; safe to re-run", () => {
    migrateMemoryV2InjectionEvents(database);
    migrateMemoryV2InjectionEvents(database);

    const raw = getSqliteFrom(database);
    const table = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_v2_injection_events'`,
      )
      .get();
    expect(table).toBeTruthy();

    const indexNames = new Set(
      (
        raw
          .query(
            `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_v2_injection_events'`,
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name),
    );
    expect(indexNames.has("idx_memory_v2_injection_events_slug_time")).toBe(
      true,
    );
    expect(indexNames.has("idx_memory_v2_injection_events_time")).toBe(true);
  });

  test("backfill replays router-sourced concepts and ignores carry_over", () => {
    migrateMemoryV2ActivationLogs(database);
    const raw = getSqliteFrom(database);
    insertActivationLog(raw, {
      id: "log-1",
      concepts: [
        { slug: "alice", source: "router", status: "injected" },
        { slug: "bob", source: "router", status: "in_context" },
        { slug: "ghost", source: "carry_over", status: "not_injected" },
      ],
      createdAt: 1_000_000,
    });
    insertActivationLog(raw, {
      id: "log-2",
      concepts: [{ slug: "alice", source: "router", status: "injected" }],
      createdAt: 2_000_000,
    });

    migrateMemoryV2InjectionEvents(database);

    const rows = raw
      .query(
        `SELECT slug, injected_at FROM memory_v2_injection_events ORDER BY injected_at, slug`,
      )
      .all() as Array<{ slug: string; injected_at: number }>;
    expect(rows).toEqual([
      { slug: "alice", injected_at: 1_000_000 },
      { slug: "bob", injected_at: 1_000_000 },
      { slug: "alice", injected_at: 2_000_000 },
    ]);
  });

  test("backfill is a no-op when memory_v2_activation_logs is absent", () => {
    // No activation-logs migration applied first.
    expect(() => migrateMemoryV2InjectionEvents(database)).not.toThrow();
    const { n } = getSqliteFrom(database)
      .query(`SELECT COUNT(*) as n FROM memory_v2_injection_events`)
      .get() as { n: number };
    expect(n).toBe(0);
  });

  test("forced re-run does not double-insert existing events", () => {
    migrateMemoryV2ActivationLogs(database);
    const raw = getSqliteFrom(database);
    insertActivationLog(raw, {
      id: "log-1",
      concepts: [{ slug: "alice", source: "router", status: "injected" }],
      createdAt: 1_000_000,
    });

    migrateMemoryV2InjectionEvents(database);
    // Simulate someone manually clearing the checkpoint — the in-table
    // guard should still prevent re-backfill.
    raw
      .prepare(
        `DELETE FROM memory_checkpoints WHERE key = 'migration_memory_v2_injection_events_v1'`,
      )
      .run();
    migrateMemoryV2InjectionEvents(database);

    const { n } = raw
      .query(`SELECT COUNT(*) as n FROM memory_v2_injection_events`)
      .get() as { n: number };
    expect(n).toBe(1);
  });

  test("downMemoryV2InjectionEvents drops the table", () => {
    migrateMemoryV2InjectionEvents(database);
    downMemoryV2InjectionEvents(database);
    const table = getSqliteFrom(database)
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_v2_injection_events'`,
      )
      .get();
    expect(table).toBeFalsy();
  });
});

describe("recordInjectionEvents", () => {
  beforeEach(() => {
    migrateMemoryV2InjectionEvents(database);
  });

  test("appends one row per slug at the same timestamp", () => {
    const t = 1_000_000;
    recordInjectionEvents(database, ["alice", "bob", "alice"], t);
    const rows = getSqliteFrom(database)
      .query(
        `SELECT slug, injected_at FROM memory_v2_injection_events ORDER BY id`,
      )
      .all();
    expect(rows).toEqual([
      { slug: "alice", injected_at: t },
      { slug: "bob", injected_at: t },
      { slug: "alice", injected_at: t },
    ]);
  });

  test("empty list is a no-op", () => {
    recordInjectionEvents(database, [], 1_000_000);
    const { n } = getSqliteFrom(database)
      .query(`SELECT COUNT(*) as n FROM memory_v2_injection_events`)
      .get() as { n: number };
    expect(n).toBe(0);
  });
});

describe("computeInjectionScore", () => {
  beforeEach(() => {
    migrateMemoryV2InjectionEvents(database);
  });

  test("returns 0 for a slug with no events", () => {
    expect(computeInjectionScore(database, "missing", Date.now())).toBe(0);
  });

  test("single event 0 days ago → score ≈ 1", () => {
    const now = 10_000_000_000;
    recordInjectionEvents(database, ["alice"], now);
    expect(computeInjectionScore(database, "alice", now)).toBeCloseTo(1, 5);
  });

  test("single event 3 days (one half-life) ago → score ≈ 0.5", () => {
    const now = 10_000_000_000;
    recordInjectionEvents(
      database,
      ["alice"],
      now - INJECTION_SCORE_HALF_LIFE_MS,
    );
    expect(computeInjectionScore(database, "alice", now)).toBeCloseTo(0.5, 5);
  });

  test("single event 6 days (two half-lives) ago → score ≈ 0.25", () => {
    const now = 10_000_000_000;
    recordInjectionEvents(
      database,
      ["alice"],
      now - 2 * INJECTION_SCORE_HALF_LIFE_MS,
    );
    expect(computeInjectionScore(database, "alice", now)).toBeCloseTo(0.25, 5);
  });

  test("multiple events sum independently", () => {
    const now = 10_000_000_000;
    recordInjectionEvents(database, ["alice"], now);
    recordInjectionEvents(
      database,
      ["alice"],
      now - INJECTION_SCORE_HALF_LIFE_MS,
    );
    recordInjectionEvents(
      database,
      ["alice"],
      now - 2 * INJECTION_SCORE_HALF_LIFE_MS,
    );
    expect(computeInjectionScore(database, "alice", now)).toBeCloseTo(1.75, 5);
  });
});

describe("computeInjectionScores", () => {
  beforeEach(() => {
    migrateMemoryV2InjectionEvents(database);
  });

  test("returns the same per-slug values as the single-slug helper", () => {
    const now = 10_000_000_000;
    recordInjectionEvents(database, ["alice", "bob"], now);
    recordInjectionEvents(
      database,
      ["alice"],
      now - INJECTION_SCORE_HALF_LIFE_MS,
    );

    const scores = computeInjectionScores(
      database,
      ["alice", "bob", "ghost"],
      now,
    );
    expect(scores.get("alice")).toBeCloseTo(1.5, 5);
    expect(scores.get("bob")).toBeCloseTo(1, 5);
    // ghost has no events — omitted from the result, not present as 0.
    expect(scores.has("ghost")).toBe(false);
    expect(scores.get("alice")).toBeCloseTo(
      computeInjectionScore(database, "alice", now),
      5,
    );
  });

  test("empty slug list returns empty map", () => {
    expect(computeInjectionScores(database, [], Date.now()).size).toBe(0);
  });
});
