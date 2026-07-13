import { beforeEach, describe, expect, test } from "bun:test";

import type { AssistantConfig } from "../../config/schema.js";
import {
  recordConfigSettingSnapshot,
  resetConfigSettingSnapshotForTesting,
} from "../config-setting-snapshot.js";
import {
  pendingOutboxPayloads,
  resetOutboxTable,
  setShareAnalytics,
} from "./outbox-test-harness.js";

function makeConfig(
  memoryEnabled: boolean,
  v2Enabled: boolean,
): AssistantConfig {
  return {
    memory: { enabled: memoryEnabled, v2: { enabled: v2Enabled } },
  } as AssistantConfig;
}

function recordedPairs(): Array<[string, string]> {
  return pendingOutboxPayloads<{
    config_key: string;
    config_value: string;
  }>("config_setting").map((event) => [event.config_key, event.config_value]);
}

describe("config-setting-snapshot", () => {
  beforeEach(() => {
    setShareAnalytics(true);
    resetOutboxTable();
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
    resetOutboxTable();

    recordConfigSettingSnapshot(makeConfig(true, false));

    expect(recordedPairs()).toEqual([["memory.v2.enabled", "false"]]);
  });

  test("consent off drops the snapshot without poisoning the memo", () => {
    setShareAnalytics(false);
    recordConfigSettingSnapshot(makeConfig(true, true));
    expect(recordedPairs()).toHaveLength(0);

    // A later opted-in snapshot records the full set — the opted-out attempt
    // must not have memoized the values (mirrors the reporter's flush retry
    // once consent resolves).
    setShareAnalytics(true);
    recordConfigSettingSnapshot(makeConfig(true, true));
    expect(recordedPairs()).toHaveLength(2);
  });

  test("re-opt-in after an opt-out re-records the full snapshot", () => {
    // Recorded while opted in.
    recordConfigSettingSnapshot(makeConfig(true, true));
    expect(recordedPairs()).toHaveLength(2);
    resetOutboxTable();

    // Opt out: the reporter's opt-out flush discards any pending rows, so the
    // memo must be cleared here too.
    setShareAnalytics(false);
    recordConfigSettingSnapshot(makeConfig(true, true));
    expect(recordedPairs()).toHaveLength(0);

    // Re-opt-in with the SAME config: the full snapshot re-records rather than
    // being skipped by a stale memo.
    setShareAnalytics(true);
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
