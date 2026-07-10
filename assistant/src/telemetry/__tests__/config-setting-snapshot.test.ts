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

import type { AssistantConfig } from "../../config/schema.js";
import { getTelemetryDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { configSettingEvents } from "../../persistence/schema/index.js";
import { queryUnreportedConfigSettingEvents } from "../config-setting-events-store.js";
import {
  recordConfigSettingSnapshot,
  resetConfigSettingSnapshotForTesting,
} from "../config-setting-snapshot.js";

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
  return queryUnreportedConfigSettingEvents(0, undefined, 100).map((r) => [
    r.configKey,
    r.configValue,
  ]);
}

function clearEvents(): void {
  const db = getTelemetryDb();
  if (!db) {
    throw new Error("telemetry DB unavailable in test");
  }
  db.delete(configSettingEvents).run();
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

    // A later opted-in snapshot (the reporter's flush retry loop) records the
    // full set — the opted-out attempt must not have memoized the values.
    shareAnalytics = true;
    recordConfigSettingSnapshot(makeConfig(true, true));
    expect(recordedPairs()).toHaveLength(2);
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
