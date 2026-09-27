import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import { getWorkspaceConfigPath } from "../../util/platform.js";
import { loadRawConfig, saveRawConfig } from "../loader.js";
import { AssistantConfigSchema } from "../schema.js";
import { AutoArchiveConfigSchema } from "../schemas/conversations.js";

describe("chat settings config", () => {
  test("missing settings preserve existing behavior", () => {
    const config = AssistantConfigSchema.parse({});
    expect(config.conversations.autoArchive).toEqual({
      enabled: false,
      afterDays: 7,
    });
    expect(config.notifications.newMessageEnabled).toBe(true);
  });

  test.each([1, 7, 14, 30])(
    "accepts a %i-day inactivity interval",
    (afterDays) => {
      expect(AutoArchiveConfigSchema.parse({ afterDays })).toEqual({
        enabled: false,
        afterDays,
      });
    },
  );

  test.each([
    { conversations: { autoArchive: { enabled: "false" } } },
    { conversations: { autoArchive: { afterDays: 2 } } },
    { conversations: { autoArchive: { afterDays: 1.5 } } },
    { conversations: { autoArchive: { enabled: null } } },
    { conversations: { autoArchive: [] } },
    { conversations: null },
    { notifications: { newMessageEnabled: 1 } },
    { notifications: { newMessageEnabled: null } },
    { notifications: [] },
  ])(
    "raw writes reject invalid settings before changing disk: %j",
    (invalid) => {
      const original = {
        conversations: { autoArchive: { enabled: true, afterDays: 14 } },
        notifications: { newMessageEnabled: false },
      };
      saveRawConfig(original);
      expect(() => saveRawConfig(invalid)).toThrow();
      expect(loadRawConfig()).toEqual(original);
    },
  );

  test.each([
    { conversations: false },
    { conversations: [] },
    { conversations: null },
    { conversations: { autoArchive: "legacy" } },
    { conversations: { autoArchive: [] } },
    { conversations: { autoArchive: null } },
    { conversations: { autoArchive: { enabled: "true", afterDays: 2 } } },
    { conversations: { autoArchive: { enabled: null, afterDays: null } } },
    { notifications: "legacy" },
    { notifications: [] },
    { notifications: null },
    { notifications: { newMessageEnabled: "false" } },
    { notifications: { newMessageEnabled: null } },
  ])("raw unrelated writes preserve untouched legacy values: %j", (legacy) => {
    const original = { ...legacy, maxStepsPerSession: 75 };
    writeFileSync(getWorkspaceConfigPath(), JSON.stringify(original));

    const updated = { ...loadRawConfig(), maxStepsPerSession: 100 };
    saveRawConfig(updated);

    expect(loadRawConfig()).toEqual({ ...original, maxStepsPerSession: 100 });
  });

  test.each([
    [{ conversations: false }, { conversations: [] }],
    [
      { conversations: [] },
      { conversations: { autoArchive: { enabled: "true" } } },
    ],
    [
      { conversations: { autoArchive: null } },
      { conversations: { autoArchive: { afterDays: 2 } } },
    ],
    [
      { notifications: { newMessageEnabled: "false" } },
      { notifications: { newMessageEnabled: "true" } },
    ],
    [
      { conversations: { autoArchive: { enabled: "true", afterDays: 2 } } },
      { conversations: { autoArchive: { enabled: "true", afterDays: 3 } } },
    ],
  ])("raw writes reject changed invalid values: %j -> %j", (previous, next) => {
    const configPath = getWorkspaceConfigPath();
    writeFileSync(configPath, JSON.stringify(previous));
    const originalBytes = readFileSync(configPath, "utf-8");

    expect(() => saveRawConfig(next)).toThrow();

    expect(readFileSync(configPath, "utf-8")).toBe(originalBytes);
  });

  test("raw writes can repair one leaf while preserving other legacy values", () => {
    writeFileSync(
      getWorkspaceConfigPath(),
      JSON.stringify({
        conversations: { autoArchive: { enabled: "true", afterDays: 2 } },
        notifications: null,
      }),
    );
    const repaired = {
      conversations: { autoArchive: { enabled: true, afterDays: 2 } },
      notifications: null,
    };

    saveRawConfig(repaired);

    expect(loadRawConfig()).toEqual(repaired);
  });
});
