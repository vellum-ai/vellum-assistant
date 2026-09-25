import { describe, expect, test } from "bun:test";

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
});
