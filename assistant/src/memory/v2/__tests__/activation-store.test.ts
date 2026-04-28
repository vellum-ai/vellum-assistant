import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { type DrizzleDb, getSqliteFrom } from "../../db-connection.js";
import { migrateActivationState } from "../../migrations/232-activation-state.js";
import * as schema from "../../schema.js";
import {
  evictCompactedTurns,
  fork,
  hydrate,
  save,
} from "../activation-store.js";
import type { ActivationState } from "../types.js";

function createTestDb(): DrizzleDb {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = drizzle(sqlite, { schema });

  // Migration uses the checkpoints table for crash recovery — bootstrap it.
  getSqliteFrom(db).exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  migrateActivationState(db);
  return db;
}

function buildState(overrides: Partial<ActivationState> = {}): ActivationState {
  return {
    messageId: "msg-1",
    state: { "alice-prefers-vscode": 0.42, "bob-coffee-order": 0.18 },
    everInjected: [
      { slug: "alice-prefers-vscode", turn: 1 },
      { slug: "bob-coffee-order", turn: 2 },
    ],
    currentTurn: 3,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

let db: DrizzleDb;
beforeEach(() => {
  db = createTestDb();
});

describe("activation-store", () => {
  describe("hydrate", () => {
    test("returns null when no row exists", async () => {
      expect(await hydrate(db, "conv-missing")).toBeNull();
    });

    test("round-trips state through save + hydrate", async () => {
      const state = buildState();
      await save(db, "conv-1", state);

      const loaded = await hydrate(db, "conv-1");
      expect(loaded).toEqual(state);
    });

    test("rejects rows whose state_json values are not numbers", async () => {
      const raw = getSqliteFrom(db);
      raw
        .query(
          /*sql*/ `INSERT INTO activation_state
            (conversation_id, message_id, state_json, ever_injected_json, current_turn, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("conv-bad", "msg-x", '{"slug-a": "not-a-number"}', "[]", 0, 1);

      await expect(hydrate(db, "conv-bad")).rejects.toThrow();
    });
  });

  describe("save", () => {
    test("upserts on conflict (second save replaces first)", async () => {
      await save(db, "conv-1", buildState({ currentTurn: 1 }));
      await save(
        db,
        "conv-1",
        buildState({
          messageId: "msg-2",
          state: { "carla-likes-vim": 0.9 },
          everInjected: [{ slug: "carla-likes-vim", turn: 5 }],
          currentTurn: 5,
          updatedAt: 1_700_000_001_000,
        }),
      );

      const loaded = await hydrate(db, "conv-1");
      expect(loaded).toEqual({
        messageId: "msg-2",
        state: { "carla-likes-vim": 0.9 },
        everInjected: [{ slug: "carla-likes-vim", turn: 5 }],
        currentTurn: 5,
        updatedAt: 1_700_000_001_000,
      });
    });

    test("persists empty state map and ever-injected list", async () => {
      const state = buildState({ state: {}, everInjected: [] });
      await save(db, "conv-empty", state);

      const loaded = await hydrate(db, "conv-empty");
      expect(loaded).toEqual(state);
    });
  });

  describe("fork", () => {
    test("copies parent state to a new conversation id", async () => {
      const parentState = buildState();
      await save(db, "conv-parent", parentState);

      await fork(db, "conv-parent", "conv-child");

      const child = await hydrate(db, "conv-child");
      expect(child).toEqual(parentState);

      // Parent is untouched.
      const parentAfter = await hydrate(db, "conv-parent");
      expect(parentAfter).toEqual(parentState);
    });

    test("is a no-op when the parent has no state", async () => {
      await fork(db, "conv-parent-missing", "conv-child");

      expect(await hydrate(db, "conv-child")).toBeNull();
    });

    test("forking onto an existing child overwrites it", async () => {
      const parentState = buildState({ currentTurn: 7 });
      await save(db, "conv-parent", parentState);
      await save(db, "conv-child", buildState({ currentTurn: 99 }));

      await fork(db, "conv-parent", "conv-child");

      const child = await hydrate(db, "conv-child");
      expect(child?.currentTurn).toBe(7);
    });
  });

  describe("evictCompactedTurns", () => {
    test("drops entries with turn <= upToTurn and preserves the rest", () => {
      const state = buildState({
        everInjected: [
          { slug: "slug-a", turn: 1 },
          { slug: "slug-b", turn: 2 },
          { slug: "slug-c", turn: 3 },
          { slug: "slug-d", turn: 5 },
        ],
      });

      const result = evictCompactedTurns(state, 2);

      expect(result.everInjected).toEqual([
        { slug: "slug-c", turn: 3 },
        { slug: "slug-d", turn: 5 },
      ]);
    });

    test("returns a new object — does not mutate the input", () => {
      const state = buildState({
        everInjected: [{ slug: "slug-a", turn: 1 }],
      });

      const result = evictCompactedTurns(state, 1);

      expect(result.everInjected).toEqual([]);
      expect(state.everInjected).toEqual([{ slug: "slug-a", turn: 1 }]);
      expect(result).not.toBe(state);
    });

    test("preserves every other field on the state", () => {
      const state = buildState();
      const result = evictCompactedTurns(state, 0);

      expect(result.messageId).toBe(state.messageId);
      expect(result.state).toEqual(state.state);
      expect(result.currentTurn).toBe(state.currentTurn);
      expect(result.updatedAt).toBe(state.updatedAt);
    });

    test("evicts everything when upToTurn covers the entire list", () => {
      const state = buildState({
        everInjected: [
          { slug: "slug-a", turn: 1 },
          { slug: "slug-b", turn: 2 },
        ],
      });

      const result = evictCompactedTurns(state, 5);
      expect(result.everInjected).toEqual([]);
    });
  });
});
