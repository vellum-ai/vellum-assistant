import { beforeEach, describe, expect, mock, test } from "bun:test";

let shareAnalytics = true;

mock.module("../../platform/consent-cache.js", () => ({
  getCachedShareAnalytics: () => shareAnalytics,
}));

import type { AssistantConfig } from "../../config/schema.js";
import { getTelemetryDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { telemetryEvents } from "../../persistence/schema/index.js";
import {
  recordConfigSettingSnapshot,
  resetConfigSettingSnapshotForTesting,
} from "../config-setting-snapshot.js";
import { queryTelemetryOutboxBatch } from "../telemetry-events-outbox.js";

await initializeDb();

function makeConfig(
  memoryEnabled: boolean,
  v2Enabled: boolean,
): AssistantConfig {
  return {
    memory: { enabled: memoryEnabled, v2: { enabled: v2Enabled } },
  } as AssistantConfig;
}

function recordedPairs(): Array<[string, string]> {
  return queryTelemetryOutboxBatch("config_setting", 100).map((row) => {
    const event = JSON.parse(row.payload) as {
      config_key: string;
      config_value: string;
    };
    return [event.config_key, event.config_value];
  });
}

function clearEvents(): void {
  const db = getTelemetryDb();
  if (!db) {
    throw new Error("telemetry DB unavailable in test");
  }
  db.delete(telemetryEvents).run();
}

describe("config-setting-snapshot", () => {
  beforeEach(() => {
    shareAnalytics = true;
    clearEvents();
    resetConfigSettingSnapshotForTesting();
  });

  test("records every tracked setting on the first snapshot", () => {
    recordConfigSettingSnapshot(makeConfig(true, false));

    expect(recordedPairs().sort()).toEqual([
      ["memory.enabled", "true"],
      ["memory.v2.enabled", "false"],
    ]);
  });

  test("repeated snapshots with unchanged values record nothing new", () => {
    recordConfigSettingSnapshot(makeConfig(true, true));
    recordConfigSettingSnapshot(makeConfig(true, true));
    recordConfigSettingSnapshot(makeConfig(true, true));

    expect(recordedPairs()).toHaveLength(2);
  });

  test("a changed value records only the changed key", () => {
    recordConfigSettingSnapshot(makeConfig(true, true));
    clearEvents();

    recordConfigSettingSnapshot(makeConfig(true, false));

    expect(recordedPairs()).toEqual([["memory.v2.enabled", "false"]]);
  });

  test("consent off drops the snapshot without poisoning the memo", () => {
    shareAnalytics = false;
    recordConfigSettingSnapshot(makeConfig(true, true));
    expect(recordedPairs()).toHaveLength(0);

    // A later opted-in snapshot records the full set — the opted-out attempt
    // must not have memoized the values (mirrors the reporter's flush retry
    // once consent resolves).
    shareAnalytics = true;
    recordConfigSettingSnapshot(makeConfig(true, true));
    expect(recordedPairs()).toHaveLength(2);
  });

  test("re-opt-in after an opt-out re-records the full snapshot", () => {
    // Recorded while opted in.
    recordConfigSettingSnapshot(makeConfig(true, true));
    expect(recordedPairs()).toHaveLength(2);
    clearEvents();

    // Opt out: the reporter's opt-out flush discards any pending rows, so the
    // memo must be cleared here too.
    shareAnalytics = false;
    recordConfigSettingSnapshot(makeConfig(true, true));
    expect(recordedPairs()).toHaveLength(0);

    // Re-opt-in with the SAME config: the full snapshot re-records rather than
    // being skipped by a stale memo.
    shareAnalytics = true;
    recordConfigSettingSnapshot(makeConfig(true, true));
    expect(recordedPairs().sort()).toEqual([
      ["memory.enabled", "true"],
      ["memory.v2.enabled", "true"],
    ]);
  });

  test("a partial config skips missing keys instead of throwing", () => {
    recordConfigSettingSnapshot({} as AssistantConfig);
    expect(recordedPairs()).toHaveLength(0);

    recordConfigSettingSnapshot({
      memory: { enabled: true },
    } as AssistantConfig);
    expect(recordedPairs()).toEqual([["memory.enabled", "true"]]);
  });
});
