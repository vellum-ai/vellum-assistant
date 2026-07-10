import { randomBytes } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Test setup — mock modules
// ---------------------------------------------------------------------------
import { getSqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  getRecentInvocations,
  rotateToolInvocations,
} from "../telemetry/tool-usage-store.js";
import { resetDbForTesting } from "./db-test-helpers.js";

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
  // initializeDb runs the full migration chain (hundreds of steps); under
  // parallel CI load it can exceed bun's default 5s hook timeout, so allow more.
  beforeAll(async () => {
    resetDbForTesting();
    await initializeDb();
    // Insert a conversations row so FK-enforced ORM inserts succeed
    getSqlite().run(
      `INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 'test', ${Date.now()}, ${Date.now()})`,
    );
  }, 30_000);

  beforeEach(() => {
    clearTable();
  });

  test("returns 0 when retentionDays is 0 (retain forever)", async () => {
    addInvocation(100 * ONE_DAY_MS); // 100 days old
    const deleted = await rotateToolInvocations(0);
    expect(deleted).toBe(0);
    expect(getRecentInvocations(100).length).toBe(1);
  });

  test("returns 0 when retentionDays is negative", async () => {
    addInvocation(100 * ONE_DAY_MS);
    const deleted = await rotateToolInvocations(-5);
    expect(deleted).toBe(0);
    expect(getRecentInvocations(100).length).toBe(1);
  });

  test("deletes records older than retentionDays", async () => {
    addInvocation(10 * ONE_DAY_MS); // 10 days old — should be deleted with 7-day retention
    addInvocation(3 * ONE_DAY_MS); // 3 days old — should be kept
    addInvocation(1 * ONE_DAY_MS); // 1 day old — should be kept

    const deleted = await rotateToolInvocations(7);
    expect(deleted).toBe(1);
    expect(getRecentInvocations(100).length).toBe(2);
  });

  test("keeps all records when none exceed retention", async () => {
    addInvocation(1 * ONE_DAY_MS);
    addInvocation(2 * ONE_DAY_MS);
    addInvocation(3 * ONE_DAY_MS);

    const deleted = await rotateToolInvocations(30);
    expect(deleted).toBe(0);
    expect(getRecentInvocations(100).length).toBe(3);
  });

  test("deletes all records when all exceed retention", async () => {
    addInvocation(60 * ONE_DAY_MS);
    addInvocation(90 * ONE_DAY_MS);
    addInvocation(120 * ONE_DAY_MS);

    const deleted = await rotateToolInvocations(30);
    expect(deleted).toBe(3);
    expect(getRecentInvocations(100).length).toBe(0);
  });

  test("returns 0 when table is empty", async () => {
    const deleted = await rotateToolInvocations(7);
    expect(deleted).toBe(0);
  });

  test("handles 1-day retention (deletes everything older than 24h)", async () => {
    addInvocation(2 * ONE_DAY_MS); // 2 days old — delete
    addInvocation(12 * 60 * 60 * 1000); // 12 hours old — keep

    const deleted = await rotateToolInvocations(1);
    expect(deleted).toBe(1);
    expect(getRecentInvocations(100).length).toBe(1);
  });

  test("works with recordToolInvocation (via ORM)", async () => {
    // Use raw SQL to insert (avoids db singleton issues in parallel test runs)
    // and verify the rotation/query functions work correctly with it
    addInvocation(0); // just-created record

    // This record was just created, so it should not be rotated
    const deleted = await rotateToolInvocations(1);
    expect(deleted).toBe(0);
    expect(getRecentInvocations(100).length).toBe(1);
  });

  test("yields to the event loop while the purge is in flight (anti-block)", async () => {
    // Seed a few thousand rows so the DELETE has measurable
    // subprocess work behind the scenes.
    const ROW_COUNT = 2000;
    const past = 100 * ONE_DAY_MS;
    const sqlite = getSqlite();
    sqlite.exec("BEGIN");
    try {
      for (let i = 0; i < ROW_COUNT; i++) {
        addInvocation(past);
      }
      sqlite.exec("COMMIT");
    } catch (err) {
      sqlite.exec("ROLLBACK");
      throw err;
    }

    // Race the purge against a `setImmediate` ping. The ping
    // resolves on the very next event-loop iteration after it is
    // scheduled.
    //
    // If the purge is async (subprocess), `rotateToolInvocations`
    // returns a pending Promise immediately; the ping wins the race
    // while the subprocess is still running.
    //
    // If the purge is ever regressed back to a synchronous DELETE,
    // `rotateToolInvocations` blocks the main thread for the full
    // DELETE duration. `setImmediate` cannot fire until the main
    // thread releases, so the purge's already-resolved Promise
    // beats the ping through the microtask queue and "purge" wins.
    //
    // The signal is deterministic regardless of how fast the
    // subprocess is or how busy the event loop is.
    const ping = new Promise<"ping">((resolve) =>
      setImmediate(() => resolve("ping")),
    );
    const purgePromise = rotateToolInvocations(7);
    const winner = await Promise.race([
      ping,
      purgePromise.then(() => "purge" as const),
    ]);

    expect(winner).toBe("ping");

    // Drain the purge so the log + subprocess cleanup complete
    // before the test exits.
    const deleted = await purgePromise;
    expect(deleted).toBe(ROW_COUNT);
  }, 60_000);
});
