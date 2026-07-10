import { beforeEach, describe, expect, mock, test } from "bun:test";

// Silence the logger.
mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

let shareAnalytics = true;

mock.module("../../platform/consent-cache.js", () => ({
  getCachedShareAnalytics: () => shareAnalytics,
}));

import { getTelemetryDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { configSettingEvents } from "../../persistence/schema/index.js";
import {
  queryUnreportedConfigSettingEvents,
  recordConfigSettingEvent,
} from "../config-setting-events-store.js";

await initializeDb();

function insertEvent(id: string, createdAt: number): void {
  const db = getTelemetryDb();
  if (!db) {
    throw new Error("telemetry DB unavailable in test");
  }
  db.insert(configSettingEvents)
    .values({ id, createdAt, configKey: "memory.enabled", configValue: "true" })
    .run();
}

function clearEvents(): void {
  const db = getTelemetryDb();
  if (!db) {
    throw new Error("telemetry DB unavailable in test");
  }
  db.delete(configSettingEvents).run();
}

describe("config-setting-events-store", () => {
  beforeEach(() => {
    shareAnalytics = true;
    clearEvents();
  });

  test("honors the share_analytics opt-out (records nothing)", () => {
    shareAnalytics = false;
    expect(
      recordConfigSettingEvent({
        configKey: "memory.enabled",
        configValue: "true",
      }),
    ).toBe(false);
    expect(queryUnreportedConfigSettingEvents(0, undefined, 10)).toHaveLength(
      0,
    );
  });

  test("record + query round-trips the key/value pair", () => {
    expect(
      recordConfigSettingEvent({
        configKey: "memory.v2.enabled",
        configValue: "false",
      }),
    ).toBe(true);

    const rows = queryUnreportedConfigSettingEvents(0, undefined, 10);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBeString();
    expect(row.createdAt).toBeGreaterThan(0);
    expect(row.configKey).toBe("memory.v2.enabled");
    expect(row.configValue).toBe("false");
  });

  test("clamps oversize key and value to the platform bounds", () => {
    recordConfigSettingEvent({
      configKey: "k".repeat(200),
      configValue: "v".repeat(300),
    });

    const rows = queryUnreportedConfigSettingEvents(0, undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.configKey).toBe("k".repeat(128));
    expect(rows[0]!.configValue).toBe("v".repeat(256));
  });

  test("returns rows in (createdAt, id) order", () => {
    insertEvent("cs-b", 2000);
    insertEvent("cs-a", 1000);

    const rows = queryUnreportedConfigSettingEvents(0, undefined, 100);
    expect(rows.map((r) => r.id)).toEqual(["cs-a", "cs-b"]);
  });

  test("query advances past the compound (createdAt, id) cursor", () => {
    // Two rows in the same millisecond: pagination must use the id
    // tiebreaker to make forward progress, not loop.
    insertEvent("cs-1", 5000);
    insertEvent("cs-2", 5000);
    insertEvent("cs-3", 6000);

    const first = queryUnreportedConfigSettingEvents(0, undefined, 1);
    expect(first.map((r) => r.id)).toEqual(["cs-1"]);

    const second = queryUnreportedConfigSettingEvents(
      first[0]!.createdAt,
      first[0]!.id,
      100,
    );
    expect(second.map((r) => r.id)).toEqual(["cs-2", "cs-3"]);

    // Without an id cursor the timestamp-only branch is used.
    expect(
      queryUnreportedConfigSettingEvents(5000, undefined, 100).map((r) => r.id),
    ).toEqual(["cs-3"]);

    // Cursor past the last row returns nothing.
    const last = second[second.length - 1]!;
    expect(
      queryUnreportedConfigSettingEvents(last.createdAt, last.id, 100).length,
    ).toBe(0);
  });

  test("honors the limit", () => {
    insertEvent("cs-l1", 1000);
    insertEvent("cs-l2", 2000);
    insertEvent("cs-l3", 3000);

    const rows = queryUnreportedConfigSettingEvents(0, undefined, 2);
    expect(rows.map((r) => r.id)).toEqual(["cs-l1", "cs-l2"]);
  });
});
