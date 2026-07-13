import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as dbConnection from "../persistence/db-connection.js";
import { getTelemetryDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { telemetryEvents } from "../persistence/schema/index.js";
import {
  deleteTelemetryOutboxEvents,
  discardPendingTelemetryOutboxEvents,
  insertTelemetryOutboxEvent,
  insertTelemetryOutboxEvents,
  queryTelemetryOutboxBatch,
} from "./telemetry-events-outbox.js";
import type { LifecycleTelemetryEvent } from "./types.js";

await initializeDb();

function lifecycleEvent(
  id: string,
  createdAt: number,
): LifecycleTelemetryEvent {
  return {
    type: "lifecycle",
    daemon_event_id: id,
    event_name: "app_open",
    recorded_at: createdAt,
    assistant_version: "1.2.3",
  };
}

function insert(
  id: string,
  createdAt: number,
  name = "lifecycle",
  conversationId?: string | null,
): boolean {
  return insertTelemetryOutboxEvent({
    id,
    name,
    createdAt,
    conversationId,
    event: lifecycleEvent(id, createdAt),
  });
}

function allIds(): string[] {
  return queryTelemetryOutboxBatch("lifecycle", 10_000).map((r) => r.id);
}

describe("telemetry-events-outbox", () => {
  beforeEach(() => {
    getTelemetryDb()!.delete(telemetryEvents).run();
  });

  test("insert + query round-trips the wire payload", () => {
    expect(insert("evt-1", 1000)).toBe(true);

    const rows = queryTelemetryOutboxBatch("lifecycle", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "evt-1", createdAt: 1000 });
    expect(JSON.parse(rows[0]!.payload)).toEqual(lifecycleEvent("evt-1", 1000));
  });

  test("batch insert lands every row", () => {
    const inserted = insertTelemetryOutboxEvents([
      {
        id: "evt-1",
        name: "lifecycle",
        createdAt: 1000,
        event: lifecycleEvent("evt-1", 1000),
      },
      {
        id: "evt-2",
        name: "lifecycle",
        createdAt: 2000,
        event: lifecycleEvent("evt-2", 2000),
      },
      {
        id: "evt-3",
        name: "lifecycle",
        createdAt: 3000,
        event: lifecycleEvent("evt-3", 3000),
      },
    ]);
    expect(inserted).toBe(true);
    expect(allIds()).toEqual(["evt-1", "evt-2", "evt-3"]);
  });

  test("batch insert is all-or-nothing on a mid-batch failure", () => {
    insert("evt-dup", 500);

    expect(() =>
      insertTelemetryOutboxEvents([
        {
          id: "evt-new-1",
          name: "lifecycle",
          createdAt: 1000,
          event: lifecycleEvent("evt-new-1", 1000),
        },
        {
          id: "evt-dup",
          name: "lifecycle",
          createdAt: 2000,
          event: lifecycleEvent("evt-dup", 2000),
        },
        {
          id: "evt-new-2",
          name: "lifecycle",
          createdAt: 3000,
          event: lifecycleEvent("evt-new-2", 3000),
        },
      ]),
    ).toThrow();

    // The primary-key conflict aborts the whole statement — no partial batch.
    expect(allIds()).toEqual(["evt-dup"]);
  });

  test("batch insert returns false when the telemetry DB is unavailable", () => {
    const spy = spyOn(dbConnection, "getTelemetryDb").mockReturnValue(null);
    try {
      expect(
        insertTelemetryOutboxEvents([
          {
            id: "evt-1",
            name: "lifecycle",
            createdAt: 1000,
            event: lifecycleEvent("evt-1", 1000),
          },
        ]),
      ).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(allIds()).toEqual([]);
  });

  test("empty batch is a successful no-op", () => {
    expect(insertTelemetryOutboxEvents([])).toBe(true);
    expect(allIds()).toEqual([]);
  });

  test("conversation_id persists in its dedicated column", () => {
    insert("evt-conv", 1000, "lifecycle", "conv-1");
    insert("evt-null", 2000, "lifecycle");

    const rows = getTelemetryDb()!
      .select({
        id: telemetryEvents.id,
        conversationId: telemetryEvents.conversationId,
      })
      .from(telemetryEvents)
      .all()
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(rows).toEqual([
      { id: "evt-conv", conversationId: "conv-1" },
      { id: "evt-null", conversationId: null },
    ]);
  });

  test("orders by (created_at, id) with id as tiebreaker", () => {
    insert("evt-b", 2000);
    insert("evt-c", 1000);
    insert("evt-a", 1000);

    expect(allIds()).toEqual(["evt-a", "evt-c", "evt-b"]);
  });

  test("honors the limit", () => {
    insert("evt-1", 1000);
    insert("evt-2", 2000);
    insert("evt-3", 3000);

    const rows = queryTelemetryOutboxBatch("lifecycle", 2);
    expect(rows.map((r) => r.id)).toEqual(["evt-1", "evt-2"]);
  });

  test("queries are isolated per event name", () => {
    insert("evt-life", 1000, "lifecycle");
    insert("evt-watch", 1000, "watchdog");

    expect(allIds()).toEqual(["evt-life"]);
    expect(queryTelemetryOutboxBatch("watchdog", 10).map((r) => r.id)).toEqual([
      "evt-watch",
    ]);
    expect(queryTelemetryOutboxBatch("onboarding", 10)).toEqual([]);
  });

  test("deletes rows by id", () => {
    insert("evt-1", 1000);
    insert("evt-2", 2000);
    insert("evt-3", 3000);

    deleteTelemetryOutboxEvents(["evt-1", "evt-3"]);

    expect(allIds()).toEqual(["evt-2"]);
  });

  test("delete with an empty id list is a no-op", () => {
    insert("evt-1", 1000);

    deleteTelemetryOutboxEvents([]);

    expect(allIds()).toEqual(["evt-1"]);
  });

  test("deletes more than one chunk of ids", () => {
    const ids: string[] = [];
    for (let i = 0; i < 501; i++) {
      const id = `evt-${String(i).padStart(4, "0")}`;
      ids.push(id);
      insert(id, i);
    }
    insert("evt-keep", 9999);

    deleteTelemetryOutboxEvents(ids);

    expect(allIds()).toEqual(["evt-keep"]);
  });

  test("discards all pending rows for one name only", () => {
    insert("evt-1", 1000, "lifecycle");
    insert("evt-2", 2000, "lifecycle");
    insert("evt-other", 1000, "watchdog");

    discardPendingTelemetryOutboxEvents("lifecycle");

    expect(allIds()).toEqual([]);
    expect(queryTelemetryOutboxBatch("watchdog", 10).map((r) => r.id)).toEqual([
      "evt-other",
    ]);
  });
});
