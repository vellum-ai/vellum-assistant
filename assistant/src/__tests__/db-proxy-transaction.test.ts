/**
 * Tests for the `db_proxy_transaction` IPC handler.
 *
 * Verifies all-or-nothing semantics: every step commits together, any
 * exception or `requireChanges` violation rolls the entire batch back.
 *
 * Uses the real DB (via `initializeDb()`); the test preload points
 * `VELLUM_WORKSPACE_DIR` at a per-file temp dir.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { handleDbProxyTransaction } from "../ipc/routes/db-proxy-transaction.js";
import { getSqlite } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { RouteError } from "../runtime/routes/errors.js";

initializeDb();

function resetTestTable(): void {
  const sqlite = getSqlite();
  sqlite.exec("DROP TABLE IF EXISTS proxy_tx_test");
  sqlite.exec(
    "CREATE TABLE proxy_tx_test (id INTEGER PRIMARY KEY, label TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0)",
  );
}

function rowCount(): number {
  const result = getSqlite()
    .prepare("SELECT COUNT(*) AS n FROM proxy_tx_test")
    .get() as { n: number };
  return result.n;
}

describe("db_proxy_transaction", () => {
  beforeEach(() => {
    resetTestTable();
  });

  test("commits multiple inserts atomically", () => {
    const result = handleDbProxyTransaction({
      steps: [
        {
          sql: "INSERT INTO proxy_tx_test (id, label) VALUES (?, ?)",
          bind: [1, "alpha"],
        },
        {
          sql: "INSERT INTO proxy_tx_test (id, label) VALUES (?, ?)",
          bind: [2, "beta"],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results).toHaveLength(2);
      expect(result.results[0].changes).toBe(1);
      expect(result.results[1].changes).toBe(1);
    }
    expect(rowCount()).toBe(2);
  });

  test("rolls back all writes when a later step throws (SQL constraint)", () => {
    // Pre-existing row that the transaction will collide with.
    getSqlite()
      .prepare("INSERT INTO proxy_tx_test (id, label) VALUES (?, ?)")
      .run(2, "preexisting");

    let caught: unknown;
    try {
      handleDbProxyTransaction({
        steps: [
          {
            sql: "INSERT INTO proxy_tx_test (id, label) VALUES (?, ?)",
            bind: [1, "alpha"],
          },
          // Primary-key collision triggers a SqliteError mid-transaction.
          {
            sql: "INSERT INTO proxy_tx_test (id, label) VALUES (?, ?)",
            bind: [2, "beta"],
          },
        ],
      });
    } catch (err) {
      caught = err;
    }

    // The thrown error must be a RouteError carrying the underlying SQL
    // message — without the wrapping, the IPC envelope would lose the
    // statusCode and the gateway-side strict caller would misclassify
    // this as a transport failure ("assistant may not be ready").
    expect(caught).toBeInstanceOf(RouteError);
    if (caught instanceof RouteError) {
      expect(caught.code).toBe("DB_PROXY_TRANSACTION_FAILED");
      expect(caught.statusCode).toBe(500);
      // The original SQL constraint message must survive the wrap so
      // operators can debug from the gateway logs.
      expect(caught.message).toMatch(/UNIQUE|PRIMARY KEY|constraint/i);
    }

    // The first step's insert must NOT have committed.
    expect(rowCount()).toBe(1);
    const remaining = getSqlite()
      .prepare("SELECT label FROM proxy_tx_test WHERE id = ?")
      .get(2) as { label: string };
    expect(remaining.label).toBe("preexisting");
  });

  test("requireChanges aborts the transaction when unmet", () => {
    // Seed a row to update; condition will not match so changes = 0.
    getSqlite()
      .prepare("INSERT INTO proxy_tx_test (id, label, count) VALUES (?, ?, ?)")
      .run(1, "active", 0);

    const result = handleDbProxyTransaction({
      steps: [
        {
          sql: "INSERT INTO proxy_tx_test (id, label) VALUES (?, ?)",
          bind: [99, "should-rollback"],
        },
        {
          // No row matches label='nonexistent', so changes = 0.
          sql: "UPDATE proxy_tx_test SET count = count + 1 WHERE label = ?",
          bind: ["nonexistent"],
          requireChanges: 1,
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("require_changes_failed");
      expect(result.failedStep).toBe(1);
      expect(result.actualChanges).toBe(0);
      expect(result.requiredChanges).toBe(1);
    }

    // The earlier insert must have rolled back.
    expect(rowCount()).toBe(1);
    const remaining = getSqlite()
      .prepare("SELECT label FROM proxy_tx_test WHERE id = ?")
      .get(1) as { label: string };
    expect(remaining.label).toBe("active");
  });

  test("requireChanges allows the transaction to commit when met", () => {
    getSqlite()
      .prepare("INSERT INTO proxy_tx_test (id, label, count) VALUES (?, ?, ?)")
      .run(1, "active", 0);

    const result = handleDbProxyTransaction({
      steps: [
        {
          sql: "INSERT INTO proxy_tx_test (id, label) VALUES (?, ?)",
          bind: [2, "new"],
        },
        {
          sql: "UPDATE proxy_tx_test SET count = count + 1 WHERE label = ?",
          bind: ["active"],
          requireChanges: 1,
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results[1].changes).toBe(1);
    }
    expect(rowCount()).toBe(2);
    const updated = getSqlite()
      .prepare("SELECT count FROM proxy_tx_test WHERE id = ?")
      .get(1) as { count: number };
    expect(updated.count).toBe(1);
  });

  test("rejects empty step list with a 400 RouteError", () => {
    let caught: unknown;
    try {
      handleDbProxyTransaction({ steps: [] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RouteError);
    if (caught instanceof RouteError) {
      expect(caught.statusCode).toBe(400);
      expect(caught.code).toBe("INVALID_PARAMS");
      expect(caught.message).toMatch(/at least one step/);
    }
  });

  test("returns lastInsertRowid for inserts", () => {
    const result = handleDbProxyTransaction({
      steps: [
        {
          sql: "INSERT INTO proxy_tx_test (label) VALUES (?)",
          bind: ["solo"],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results[0].lastInsertRowid).toBeGreaterThan(0);
    }
  });
});
