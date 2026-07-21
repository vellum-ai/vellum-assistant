import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getMemorySqlite } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import {
  clearStoredDb,
  setStoredDb,
} from "../../../../persistence/db-singleton.js";
import * as schema from "../../../../persistence/schema/index.js";
import {
  isActivationSession,
  markActivationSession,
} from "../activation-session-store.js";

await initializeDb();

describe("activation-session-store", () => {
  beforeEach(() => {
    getMemorySqlite()!.exec("DELETE FROM activation_sessions");
  });

  test("marks a conversation and reports it as an activation session", () => {
    markActivationSession("c1");
    expect(isActivationSession("c1")).toBe(true);
  });

  test("unmarked conversations are not activation sessions", () => {
    expect(isActivationSession("nope")).toBe(false);
  });

  test("marking the same conversation twice is idempotent", () => {
    markActivationSession("c1");
    markActivationSession("c1");
    expect(isActivationSession("c1")).toBe(true);
    const { n } = getMemorySqlite()!
      .query("SELECT COUNT(*) AS n FROM activation_sessions")
      .get() as { n: number };
    expect(n).toBe(1);
  });

  test("rows land in the memory database, not main", () => {
    markActivationSession("c-placement");
    const inMemory = getMemorySqlite()!
      .query(
        "SELECT conversation_id FROM activation_sessions WHERE conversation_id = 'c-placement'",
      )
      .get() as { conversation_id: string } | null;
    expect(inMemory?.conversation_id).toBe("c-placement");
  });
});

describe("activation-session-store — degraded memory database", () => {
  // Install a memory DB WITHOUT the activation_sessions table: the store's
  // catch paths must swallow the failure (write no-ops, read reports false)
  // rather than throw into the turn.
  let brokenSqlite: Database;

  beforeEach(() => {
    brokenSqlite = new Database(":memory:");
    setStoredDb("memory", drizzle(brokenSqlite, { schema }), () =>
      brokenSqlite.close(),
    );
  });

  afterEach(() => {
    clearStoredDb("memory");
  });

  test("mark is a no-op and read reports false", () => {
    expect(() => markActivationSession("c1")).not.toThrow();
    expect(isActivationSession("c1")).toBe(false);
  });
});
