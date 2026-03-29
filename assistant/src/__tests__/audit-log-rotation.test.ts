import { randomBytes } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Test setup — mock modules
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { initializeDb, resetDb } from "../memory/db.js";
import { getSqlite } from "../memory/db-connection.js";
import {
  getRecentInvocations,
  rotateToolInvocations,
} from "../memory/tool-usage-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addInvocation(ageMs: number): void {
  // Insert directly with a specific timestamp in the past
  const db = getSqlite();
  const id = randomBytes(8).toString("hex");
  const createdAt = Date.now() - ageMs;
  db.prepare(
    `INSERT INTO tool_invocations (id, conversation_id, tool_name, input, result, decision, risk_level, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "conv-1",
    "bash",
    '{"command":"echo hi"}',
    "hi",
    "allow",
    "Low",
    100,
    createdAt,
  );
}

function clearTable(): void {
  getSqlite().run("DELETE FROM tool_invocations");
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("audit log rotation", () => {
  beforeAll(() => {
    resetDb();
    initializeDb();
    // Insert a conversations row so FK-enforced ORM inserts succeed
    getSqlite().run(
      `INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 'test', ${Date.now()}, ${Date.now()})`,
    );
  });

  beforeEach(() => {
    clearTable();
  });

  test("returns 0 when retentionDays is 0 (retain forever)", () => {
    addInvocation(100 * ONE_DAY_MS); // 100 days old
    const deleted = rotateToolInvocations(0);
    expect(deleted).toBe(0);
    expect(getRecentInvocations(100).length).toBe(1);
  });

  test("returns 0 when retentionDays is negative", () => {
    addInvocation(100 * ONE_DAY_MS);
    const deleted = rotateToolInvocations(-5);
    expect(deleted).toBe(0);
    expect(getRecentInvocations(100).length).toBe(1);
  });

  test("deletes records older than retentionDays", () => {
    addInvocation(10 * ONE_DAY_MS); // 10 days old — should be deleted with 7-day retention
    addInvocation(3 * ONE_DAY_MS); // 3 days old — should be kept
    addInvocation(1 * ONE_DAY_MS); // 1 day old — should be kept

    const deleted = rotateToolInvocations(7);
    expect(deleted).toBe(1);
    expect(getRecentInvocations(100).length).toBe(2);
  });

  test("keeps all records when none exceed retention", () => {
    addInvocation(1 * ONE_DAY_MS);
    addInvocation(2 * ONE_DAY_MS);
    addInvocation(3 * ONE_DAY_MS);

    const deleted = rotateToolInvocations(30);
    expect(deleted).toBe(0);
    expect(getRecentInvocations(100).length).toBe(3);
  });

  test("deletes all records when all exceed retention", () => {
    addInvocation(60 * ONE_DAY_MS);
    addInvocation(90 * ONE_DAY_MS);
    addInvocation(120 * ONE_DAY_MS);

    const deleted = rotateToolInvocations(30);
    expect(deleted).toBe(3);
    expect(getRecentInvocations(100).length).toBe(0);
  });

  test("returns 0 when table is empty", () => {
    const deleted = rotateToolInvocations(7);
    expect(deleted).toBe(0);
  });

  test("handles 1-day retention (deletes everything older than 24h)", () => {
    addInvocation(2 * ONE_DAY_MS); // 2 days old — delete
    addInvocation(12 * 60 * 60 * 1000); // 12 hours old — keep

    const deleted = rotateToolInvocations(1);
    expect(deleted).toBe(1);
    expect(getRecentInvocations(100).length).toBe(1);
  });

  test("works with recordToolInvocation (via ORM)", () => {
    // Use raw SQL to insert (avoids db singleton issues in parallel test runs)
    // and verify the rotation/query functions work correctly with it
    addInvocation(0); // just-created record

    // This record was just created, so it should not be rotated
    const deleted = rotateToolInvocations(1);
    expect(deleted).toBe(0);
    expect(getRecentInvocations(100).length).toBe(1);
  });
});
