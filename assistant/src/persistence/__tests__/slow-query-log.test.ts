import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import {
  reportSlowQuery,
  setSlowQueryTelemetrySink,
  SLOW_QUERY_CHECK_NAME,
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
    // Unlabeled queries carry no label field.
    expect(events[0].sql).toContain("INSERT INTO t");
  });

  test("wraps in place and returns the same Database instance", () => {
    const db = new Database(":memory:");
    expect(wrapSqliteForSlowQueryLogging(db)).toBe(db);
  });
});

describe("slow-query telemetry sink", () => {
  afterEach(() => setSlowQueryTelemetrySink(undefined));

  test("check name is stable", () => {
    expect(SLOW_QUERY_CHECK_NAME).toBe("slow_sqlite_query");
  });

  test("reportSlowQuery forwards the event to the registered sink", () => {
    const seen: SlowQueryEvent[] = [];
    setSlowQueryTelemetrySink((e) => seen.push(e));

    const event: SlowQueryEvent = {
      durationMs: 500,
      sql: "SELECT 1",
      label: "test:probe",
    };
    reportSlowQuery(event);

    expect(seen).toEqual([event]);
  });

  test("clearing the sink stops delivery", () => {
    const seen: SlowQueryEvent[] = [];
    setSlowQueryTelemetrySink((e) => seen.push(e));
    setSlowQueryTelemetrySink(undefined);

    reportSlowQuery({ durationMs: 500, sql: "SELECT 1" });

    expect(seen).toHaveLength(0);
  });

  test("a throwing sink never escapes reportSlowQuery", () => {
    setSlowQueryTelemetrySink(() => {
      throw new Error("telemetry boom");
    });

    expect(() =>
      reportSlowQuery({ durationMs: 500, sql: "SELECT 1" }),
    ).not.toThrow();
  });

  test("the wrapper's default path routes slow queries to the sink", () => {
    const seen: SlowQueryEvent[] = [];
    setSlowQueryTelemetrySink((e) => seen.push(e));

    // No onSlowQuery override, so the wrapper uses the production reportSlowQuery,
    // which fans out to the telemetry sink.
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    wrapSqliteForSlowQueryLogging(db, {
      thresholdMs: 100,
      now: fakeClock(0, 400),
    });

    db.label("schedule::claimDue")
      .query("INSERT INTO t (v) VALUES (?)")
      .run("a");

    expect(seen).toHaveLength(1);
    expect(seen[0].durationMs).toBe(400);
    expect(seen[0].label).toBe("schedule::claimDue");
  });
});
