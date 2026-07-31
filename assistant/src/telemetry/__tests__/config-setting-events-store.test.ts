import { beforeEach, describe, expect, test } from "bun:test";

import { APP_VERSION } from "../../version.js";
import { recordConfigSettingEvent } from "../config-setting-events-store.js";
import {
  pendingOutboxPayloads,
  pendingOutboxRows,
  resetOutboxTable,
  setShareAnalytics,
} from "./outbox-test-harness.js";

describe("config-setting-events-store", () => {
  beforeEach(() => {
    setShareAnalytics(true);
    resetOutboxTable();
  });

  test("honors the share_analytics opt-out (records nothing, returns false)", () => {
    setShareAnalytics(false);
    expect(
      recordConfigSettingEvent({
        configKey: "memory.enabled",
        configValue: "true",
      }),
    ).toBe(false);
    expect(pendingOutboxRows("config_setting", 10)).toHaveLength(0);
  });

  test("records the full wire event and returns true", () => {
    expect(
      recordConfigSettingEvent({
        configKey: "memory.v2.enabled",
        configValue: "false",
      }),
    ).toBe(true);

    const rows = pendingOutboxRows("config_setting", 10);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBeString();
    expect(row.createdAt).toBeGreaterThan(0);
    expect(JSON.parse(row.payload)).toEqual({
      type: "config_setting",
      daemon_event_id: row.id,
      recorded_at: row.createdAt,
      config_key: "memory.v2.enabled",
      config_value: "false",
      assistant_version: APP_VERSION,
    });
  });

  test("clamps oversize key and value to the platform bounds", () => {
    recordConfigSettingEvent({
      configKey: "k".repeat(200),
      configValue: "v".repeat(300),
    });

    const payloads = pendingOutboxPayloads("config_setting");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.config_key).toBe("k".repeat(128));
    expect(payloads[0]!.config_value).toBe("v".repeat(256));
  });
});
