/**
 * Tests for `withSqliteRetry()`, the shared retry wrapper for transient
 * SQLite write contention (`SQLITE_BUSY*` / `SQLITE_IOERR*`).
 */

import { describe, expect, test } from "bun:test";

import { isRetryableSqliteError, withSqliteRetry } from "../sqlite-retry.js";

function sqliteError(code: string): Error {
  const err = new Error(code);
  (err as Error & { code: string }).code = code;
  return err;
}

describe("isRetryableSqliteError", () => {
  test("matches the SQLITE_BUSY and SQLITE_IOERR families", () => {
    expect(isRetryableSqliteError(sqliteError("SQLITE_BUSY"))).toBe(true);
    expect(isRetryableSqliteError(sqliteError("SQLITE_BUSY_SNAPSHOT"))).toBe(
      true,
    );
    expect(isRetryableSqliteError(sqliteError("SQLITE_IOERR"))).toBe(true);
    expect(isRetryableSqliteError(sqliteError("SQLITE_IOERR_SHORT_READ"))).toBe(
      true,
    );
  });

  test("rejects non-transient errors", () => {
    expect(isRetryableSqliteError(sqliteError("SQLITE_CONSTRAINT"))).toBe(
      false,
    );
    expect(isRetryableSqliteError(new Error("database is locked"))).toBe(false);
    expect(isRetryableSqliteError(null)).toBe(false);
    expect(isRetryableSqliteError(undefined)).toBe(false);
  });
});

describe("withSqliteRetry", () => {
  test("returns the wrapped value on first success", async () => {
    let calls = 0;
    const result = await withSqliteRetry(
      () => {
        calls += 1;
        return "ok";
      },
      { op: "test-op" },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  test("retries transient contention and returns the eventual success", async () => {
    let calls = 0;
    const result = await withSqliteRetry(
      () => {
        calls += 1;
        if (calls <= 2) {
          throw sqliteError("SQLITE_BUSY");
        }
        return "recovered";
      },
      { op: "test-op", baseDelayMs: 1 },
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(3);
  });

  test("awaits an async wrapped function", async () => {
    let calls = 0;
    const result = await withSqliteRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw sqliteError("SQLITE_IOERR");
        }
        return 42;
      },
      { op: "test-op", baseDelayMs: 1 },
    );
    expect(result).toBe(42);
    expect(calls).toBe(2);
  });

  test("throws immediately on a non-retryable error", async () => {
    let calls = 0;
    await expect(
      withSqliteRetry(
        () => {
          calls += 1;
          throw sqliteError("SQLITE_CONSTRAINT_PRIMARYKEY");
        },
        { op: "test-op", baseDelayMs: 1 },
      ),
    ).rejects.toThrow("SQLITE_CONSTRAINT_PRIMARYKEY");
    expect(calls).toBe(1);
  });

  test("rethrows after exhausting maxRetries", async () => {
    let calls = 0;
    await expect(
      withSqliteRetry(
        () => {
          calls += 1;
          throw sqliteError("SQLITE_BUSY");
        },
        { op: "test-op", maxRetries: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("SQLITE_BUSY");
    // Initial attempt + 2 retries.
    expect(calls).toBe(3);
  });
});
