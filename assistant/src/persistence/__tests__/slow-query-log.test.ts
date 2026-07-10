import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { runWithSqliteQueryLabel } from "../../util/sqlite-query-label.js";
import { withSqliteRetry } from "../../util/sqlite-retry.js";
import {
  callerFromStack,
  SLOW_QUERY_THRESHOLD_MS,
  type SlowQueryEvent,
  wrapSqliteForSlowQueryLogging,
} from "../slow-query-log.js";

/**
 * A deterministic `performance.now()` stand-in that yields the supplied values
 * in order. Each timed execution consumes two readings (start + end), so a
 * `[start, end]` pair per query lets a test dial an exact duration.
 */
function fakeClock(...readings: number[]): () => number {
  let i = 0;
  return () => readings[i++];
}

describe("slow-query-log", () => {
  test("threshold default is a positive number", () => {
    expect(SLOW_QUERY_THRESHOLD_MS).toBeGreaterThan(0);
  });

  test("a slow query logs exactly one event; a fast query logs none", () => {
    const events: SlowQueryEvent[] = [];
    const db = new Database(":memory:");
    // First execution spans 0→300ms (slow); second spans 1000→1002ms (fast).
    wrapSqliteForSlowQueryLogging(db, {
      thresholdMs: 250,
      now: fakeClock(0, 300, 1000, 1002),
      onSlowQuery: (e) => events.push(e),
    });

    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    db.query("INSERT INTO t (v) VALUES (?)").run("a"); // slow
    db.query("SELECT * FROM t").all(); // fast

    expect(events).toHaveLength(1);
    expect(events[0].durationMs).toBe(300);
    expect(events[0].sql).toContain("INSERT INTO t");
  });

  test("slow SELECT reports the returned row count", () => {
    const events: SlowQueryEvent[] = [];
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    db.exec("INSERT INTO t (id) VALUES (1), (2), (3)");
    wrapSqliteForSlowQueryLogging(db, {
      thresholdMs: 100,
      now: fakeClock(0, 500),
      onSlowQuery: (e) => events.push(e),
    });

    const rows = db.query("SELECT * FROM t").all();

    expect(rows).toHaveLength(3);
    expect(events).toHaveLength(1);
    expect(events[0].rowCount).toBe(3);
  });

  test("SQL preview is truncated to 120 characters", () => {
    const events: SlowQueryEvent[] = [];
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    wrapSqliteForSlowQueryLogging(db, {
      thresholdMs: 1,
      now: fakeClock(0, 50),
      onSlowQuery: (e) => events.push(e),
    });

    // A comment pads the statement well past the 120-char preview window.
    const longSql = `SELECT * FROM t WHERE id = 1 -- ${"x".repeat(200)}`;
    db.query(longSql).all();

    expect(events).toHaveLength(1);
    expect(events[0].sql).toHaveLength(120);
    expect(events[0].sql).toBe(longSql.slice(0, 120));
  });

  test("a failing execution still reports once and rethrows unchanged", () => {
    const events: SlowQueryEvent[] = [];
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    db.exec("INSERT INTO t (id) VALUES (1)"); // seed via exec (not timed)
    wrapSqliteForSlowQueryLogging(db, {
      thresholdMs: 0,
      now: fakeClock(0, 7),
      onSlowQuery: (e) => events.push(e),
    });

    // The duplicate primary key throws at execution time — the failed op still
    // blocked the loop, so it is reported, and the error propagates unchanged.
    expect(() => db.query("INSERT INTO t (id) VALUES (1)").run()).toThrow();
    expect(events).toHaveLength(1);
    expect(events[0].durationMs).toBe(7);
  });

  test("return values and types are unchanged through the wrapper", () => {
    // A high threshold + noop sink keeps this purely about passthrough fidelity.
    const bare = new Database(":memory:");
    const wrapped = new Database(":memory:");
    wrapSqliteForSlowQueryLogging(wrapped, {
      thresholdMs: Number.POSITIVE_INFINITY,
      onSlowQuery: () => {
        throw new Error("must not fire on the fast path");
      },
    });

    for (const db of [bare, wrapped]) {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    }

    const runResult = wrapped
      .query("INSERT INTO t (v) VALUES (?)")
      .run("hello");
    const bareRun = bare.query("INSERT INTO t (v) VALUES (?)").run("hello");
    expect(runResult).toEqual(bareRun);
    expect(typeof runResult.changes).toBe("number");
    expect(runResult.changes).toBe(1);

    expect(wrapped.query("SELECT * FROM t").all()).toEqual(
      bare.query("SELECT * FROM t").all(),
    );
    expect(wrapped.query("SELECT * FROM t WHERE id = ?").get(1)).toEqual(
      bare.query("SELECT * FROM t WHERE id = ?").get(1),
    );
    expect(wrapped.query("SELECT * FROM t").values()).toEqual(
      bare.query("SELECT * FROM t").values(),
    );

    // `.get()` on a no-match returns the same nullish shape as the bare client.
    expect(wrapped.query("SELECT * FROM t WHERE id = ?").get(999)).toEqual(
      bare.query("SELECT * FROM t WHERE id = ?").get(999),
    );

    // Non-execution members pass straight through.
    expect(wrapped.query("SELECT id, v FROM t").columnNames).toEqual([
      "id",
      "v",
    ]);
  });

  test("times the Database.run shortcut, which bypasses query/prepare", () => {
    const events: SlowQueryEvent[] = [];
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    wrapSqliteForSlowQueryLogging(db, {
      thresholdMs: 250,
      now: fakeClock(0, 400),
      onSlowQuery: (e) => events.push(e),
    });

    const result = db.run("INSERT INTO t (v) VALUES (?)", ["a"]);

    expect(result.changes).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0].durationMs).toBe(400);
    expect(events[0].sql).toContain("INSERT INTO t");
  });

  test("label() tags the slow-query event", () => {
    const events: SlowQueryEvent[] = [];
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    wrapSqliteForSlowQueryLogging(db, {
      thresholdMs: 100,
      now: fakeClock(0, 500, 1000, 1600),
      onSlowQuery: (e) => events.push(e),
    });

    db.label("schedule::claimDue")
      .query("INSERT INTO t (v) VALUES (?)")
      .run("a");
    db.label("schedule::complete").run("UPDATE t SET v = ? WHERE id = 1", [
      "b",
    ]);

    expect(events).toHaveLength(2);
    expect(events[0].label).toBe("schedule::claimDue");
    expect(events[1].label).toBe("schedule::complete");
    // A curated label suppresses the auto-derived caller.
    expect(events[0].caller).toBeUndefined();
    expect(events[0].sql).toContain("INSERT INTO t");
  });

  test("an unlabeled query derives a caller from the stack", () => {
    const events: SlowQueryEvent[] = [];
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    wrapSqliteForSlowQueryLogging(db, {
      thresholdMs: 100,
      now: fakeClock(0, 500),
      onSlowQuery: (e) => events.push(e),
    });

    // No `.label()` — mirrors a Drizzle query, which has no chokepoint to label.
    db.query("SELECT * FROM t").all();

    expect(events).toHaveLength(1);
    expect(events[0].label).toBeUndefined();
    // The caller points at this test file (the application frame that issued it),
    // not at slow-query-log.ts or bun:sqlite internals.
    expect(events[0].caller).toBeDefined();
    expect(events[0].caller).toContain("slow-query-log.test.ts");
    expect(events[0].caller).not.toContain("slow-query-log.ts");
  });

  test("wraps in place and returns the same Database instance", () => {
    const db = new Database(":memory:");
    expect(wrapSqliteForSlowQueryLogging(db)).toBe(db);
  });

  test("an ambient label tags the event and keeps the derived caller", () => {
    const events: SlowQueryEvent[] = [];
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    wrapSqliteForSlowQueryLogging(db, {
      thresholdMs: 100,
      now: fakeClock(0, 500),
      onSlowQuery: (e) => events.push(e),
    });

    runWithSqliteQueryLabel("memory:upsertRetrospectiveState", () => {
      db.query("SELECT * FROM t").all();
    });

    expect(events).toHaveLength(1);
    expect(events[0].label).toBe("memory:upsertRetrospectiveState");
    // Unlike an explicit `.label()`, an ambient label marks an outer boundary,
    // so the statement's own call site is still derived from the stack.
    expect(events[0].caller).toContain("slow-query-log.test.ts");
  });

  test("an explicit .label() wins over the ambient label", () => {
    const events: SlowQueryEvent[] = [];
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    wrapSqliteForSlowQueryLogging(db, {
      thresholdMs: 100,
      now: fakeClock(0, 500),
      onSlowQuery: (e) => events.push(e),
    });

    runWithSqliteQueryLabel("ambient:outer", () => {
      db.label("schedule::claimDue")
        .query("INSERT INTO t (v) VALUES (?)")
        .run("a");
    });

    expect(events).toHaveLength(1);
    expect(events[0].label).toBe("schedule::claimDue");
    expect(events[0].caller).toBeUndefined();
  });

  test("withSqliteRetry's op labels slow queries inside it, retries included", async () => {
    const events: SlowQueryEvent[] = [];
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    wrapSqliteForSlowQueryLogging(db, {
      thresholdMs: 100,
      now: fakeClock(0, 500),
      onSlowQuery: (e) => events.push(e),
    });

    // First attempt loses the write-lock race; the retry (which runs from a
    // stack truncated by the backoff sleep) issues the slow query.
    let attempt = 0;
    await withSqliteRetry(
      () => {
        if (attempt++ === 0) {
          throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
        }
        return db.query("SELECT * FROM t").all();
      },
      { op: "test:claimRow", baseDelayMs: 1 },
    );

    expect(events).toHaveLength(1);
    expect(events[0].label).toBe("test:claimRow");
  });

  test("withSqliteRetry's op labels a lazy thenable that runs when awaited", async () => {
    const events: SlowQueryEvent[] = [];
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    wrapSqliteForSlowQueryLogging(db, {
      thresholdMs: 100,
      now: fakeClock(0, 500),
      onSlowQuery: (e) => events.push(e),
    });

    // Mirrors a Drizzle QueryPromise: fn returns immediately and the statement
    // only executes when the thenable is assimilated by an await. The retry
    // helper must perform that await inside its label scope.
    const lazy = {
      then(resolve: (value: unknown) => void) {
        resolve(db.query("SELECT * FROM t").all());
      },
    } as unknown as Promise<unknown>;
    await withSqliteRetry(() => lazy, { op: "test:lazyUpdate" });

    expect(events).toHaveLength(1);
    expect(events[0].label).toBe("test:lazyUpdate");
  });
});

describe("callerFromStack", () => {
  test("returns the first app frame in a source-tree run, skipping ORM/self", () => {
    const stack = [
      "Error",
      "    at callerFromStack (/repo/assistant/src/persistence/slow-query-log.ts:110:20)",
      "    at emit (/repo/assistant/src/persistence/slow-query-log.ts:192:5)",
      "    at all (/root/.bun/install/cache/drizzle-orm@0.45.2@@@1/bun-sqlite/session.js:79:23)",
      "    at insertMessageCore (/repo/assistant/src/persistence/conversation-crud.ts:474:10)",
    ].join("\n");
    expect(callerFromStack(stack)).toBe(
      "persistence/conversation-crud.ts:insertMessageCore:474",
    );
  });

  test("preserves the assistant's own src frames in a packaged install", () => {
    // Local-runtime install: the daemon runs from
    // node_modules/@vellumai/assistant/src, so app frames also contain
    // node_modules. Third-party deps are still skipped; assistant src is not.
    const stack = [
      "Error",
      "    at emit (/app/node_modules/@vellumai/assistant/src/persistence/slow-query-log.ts:192:5)",
      "    at all (/app/node_modules/drizzle-orm/bun-sqlite/session.js:79:23)",
      "    at claimDueSchedules (/app/node_modules/@vellumai/assistant/src/schedule/schedule-store.ts:88:12)",
    ].join("\n");
    expect(callerFromStack(stack)).toBe(
      "schedule/schedule-store.ts:claimDueSchedules:88",
    );
  });

  test("handles column-less frames (function omitted)", () => {
    const stack = [
      "Error",
      "    at emit (/repo/assistant/src/persistence/slow-query-log.ts:192:5)",
      "    at all (/root/.bun/install/cache/drizzle-orm@0.45.2/bun-sqlite/session.js:79:23)",
      "    at /repo/assistant/src/plugins/defaults/memory/context-search/sources/conversations.ts:231",
    ].join("\n");
    expect(callerFromStack(stack)).toBe(
      "plugins/defaults/memory/context-search/sources/conversations.ts:231",
    );
  });

  test("prefers the nearest named app frame over an anonymous callback", () => {
    // A statement run inside `db.transaction((tx) => …)` sits in an anonymous
    // app frame, with the accountable named function above the ORM plumbing.
    const stack = [
      "Error",
      "    at emit (/repo/assistant/src/persistence/slow-query-log.ts:192:5)",
      "    at <anonymous> (/repo/assistant/src/persistence/conversation-crud.ts:629:44)",
      "    at <anonymous> (/root/.bun/install/cache/drizzle-orm@0.45.2@@@1/bun-sqlite/session.js:35:16)",
      "    at transaction (bun:sqlite:416:27)",
      "    at transaction (/root/.bun/install/cache/drizzle-orm@0.45.2@@@1/bun-sqlite/session.js:37:33)",
      "    at insertMessageCore (/repo/assistant/src/persistence/conversation-crud.ts:474:10)",
    ].join("\n");
    expect(callerFromStack(stack)).toBe(
      "persistence/conversation-crud.ts:insertMessageCore:474",
    );
  });

  test("falls back to the innermost anonymous app frame when nothing is named", () => {
    const stack = [
      "Error",
      "    at emit (/repo/assistant/src/persistence/slow-query-log.ts:192:5)",
      "    at <anonymous> (/repo/assistant/src/persistence/conversation-crud.ts:629:44)",
      "    at <anonymous> (/repo/assistant/src/daemon/lifecycle.ts:88:12)",
      "    at processTicksAndRejections (native:7:39)",
    ].join("\n");
    expect(callerFromStack(stack)).toBe(
      "persistence/conversation-crud.ts:<anonymous>:629",
    );
  });

  test("returns undefined when no application frame is present", () => {
    const stack = [
      "Error",
      "    at emit (/repo/assistant/src/persistence/slow-query-log.ts:192:5)",
      "    at all (/root/.bun/install/cache/drizzle-orm@0.45.2/bun-sqlite/session.js:79:23)",
      "    at processTicksAndRejections (native:7:39)",
    ].join("\n");
    expect(callerFromStack(stack)).toBeUndefined();
  });
});
