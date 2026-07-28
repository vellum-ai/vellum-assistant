import { beforeEach, describe, expect, test } from "bun:test";

import { getTelemetryDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { flushCheckpoints } from "../../persistence/schema/index.js";
import {
  getFlushCheckpoint,
  isFlushCheckpointStoreAvailable,
  setFlushCheckpoint,
} from "../flush-checkpoints.js";

await initializeDb();

function clearCheckpoints(): void {
  const db = getTelemetryDb();
  if (!db) {
    throw new Error("telemetry DB unavailable in test");
  }
  db.delete(flushCheckpoints).run();
}

describe("flush-checkpoints", () => {
  beforeEach(() => {
    clearCheckpoints();
  });

  test("store is available once the telemetry DB is open", () => {
    expect(isFlushCheckpointStoreAvailable()).toBe(true);
  });

  test("get returns null for an absent key", () => {
    expect(getFlushCheckpoint("telemetry:usage:last_reported_at")).toBeNull();
  });

  test("set + get round-trips", () => {
    setFlushCheckpoint("telemetry:usage:last_reported_at", "1700000000000");
    expect(getFlushCheckpoint("telemetry:usage:last_reported_at")).toBe(
      "1700000000000",
    );
  });

  test("set overwrites an existing value", () => {
    setFlushCheckpoint("telemetry:turns:last_reported_id", "row-1");
    setFlushCheckpoint("telemetry:turns:last_reported_id", "row-2");
    expect(getFlushCheckpoint("telemetry:turns:last_reported_id")).toBe(
      "row-2",
    );
  });

  test("keys are independent", () => {
    setFlushCheckpoint("telemetry:usage:last_reported_at", "1");
    setFlushCheckpoint("telemetry:turns:last_reported_at", "2");
    expect(getFlushCheckpoint("telemetry:usage:last_reported_at")).toBe("1");
    expect(getFlushCheckpoint("telemetry:turns:last_reported_at")).toBe("2");
  });
});
