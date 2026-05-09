import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../memory/db-connection.js";
import {
  migrate231RepairMemoryGraphEventDates,
  repairMemoryGraphEventDate,
} from "../memory/migrations/231-repair-memory-graph-event-dates.js";
import * as schema from "../memory/schema.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function bootstrapTables(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE memory_graph_nodes (
      id TEXT PRIMARY KEY,
      created INTEGER NOT NULL,
      event_date INTEGER,
      content TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE memory_graph_triggers (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      type TEXT NOT NULL,
      event_date INTEGER
    );
  `);
}

function eventDateFor(raw: Database, nodeId: string): number | null {
  const row = raw
    .query(`SELECT event_date FROM memory_graph_nodes WHERE id = ?`)
    .get(nodeId) as { event_date: number | null } | null;
  return row?.event_date ?? null;
}

function triggerEventDateFor(raw: Database, triggerId: string): number | null {
  const row = raw
    .query(`SELECT event_date FROM memory_graph_triggers WHERE id = ?`)
    .get(triggerId) as { event_date: number | null } | null;
  return row?.event_date ?? null;
}

describe("repairMemoryGraphEventDate", () => {
  test("repairs a nearby prior-year event date created in 2026", () => {
    const created = Date.UTC(2026, 3, 26, 5, 23, 20);
    const wrongEventDate = Date.UTC(2025, 3, 19, 2, 32, 0);

    expect(
      repairMemoryGraphEventDate(
        created,
        wrongEventDate,
        "Talked about the trip on April 19",
      ),
    ).toBe(Date.UTC(2026, 3, 19, 2, 32, 0));
  });

  test("leaves distant historical dates alone", () => {
    const created = Date.UTC(2026, 3, 26, 5, 23, 20);
    const historicalEventDate = Date.UTC(2025, 10, 1, 12, 0, 0);

    expect(
      repairMemoryGraphEventDate(created, historicalEventDate, ""),
    ).toBeNull();
  });

  test("leaves dates alone when content explicitly mentions the prior year", () => {
    const created = Date.UTC(2026, 3, 26, 5, 23, 20);
    const explicitHistorical = Date.UTC(2025, 3, 19, 2, 32, 0);

    expect(
      repairMemoryGraphEventDate(
        created,
        explicitHistorical,
        "User flew on April 19, 2025 to visit family",
      ),
    ).toBeNull();
  });
});

describe("migrate231RepairMemoryGraphEventDates", () => {
  test("repairs bad node and trigger event dates idempotently", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapTables(raw);

    const created = Date.UTC(2026, 3, 26, 5, 23, 20);
    const wrongEventDate = Date.UTC(2025, 3, 19, 2, 32, 0);
    const correctedEventDate = Date.UTC(2026, 3, 19, 2, 32, 0);
    const distantHistoricalDate = Date.UTC(2025, 10, 1, 12, 0, 0);
    const futureDate = Date.UTC(2027, 0, 1, 12, 0, 0);

    const insertNode = raw.prepare(
      `INSERT INTO memory_graph_nodes (id, created, event_date, content) VALUES (?, ?, ?, ?)`,
    );
    insertNode.run("bad-node", created, wrongEventDate, "Trip on April 19");
    insertNode.run(
      "historical-node",
      created,
      distantHistoricalDate,
      "Notes from last fall",
    );
    insertNode.run("future-node", created, futureDate, "New Year 2027 plans");
    insertNode.run(
      "explicit-year-node",
      created,
      wrongEventDate,
      "User flew on April 19, 2025 to visit family",
    );
    raw
      .prepare(
        `INSERT INTO memory_graph_triggers (id, node_id, type, event_date) VALUES (?, ?, ?, ?)`,
      )
      .run("bad-trigger", "bad-node", "event", wrongEventDate);

    migrate231RepairMemoryGraphEventDates(db);
    migrate231RepairMemoryGraphEventDates(db);

    expect(eventDateFor(raw, "bad-node")).toBe(correctedEventDate);
    expect(triggerEventDateFor(raw, "bad-trigger")).toBe(correctedEventDate);
    expect(eventDateFor(raw, "historical-node")).toBe(distantHistoricalDate);
    expect(eventDateFor(raw, "future-node")).toBe(futureDate);
    expect(eventDateFor(raw, "explicit-year-node")).toBe(wrongEventDate);
  });
});
