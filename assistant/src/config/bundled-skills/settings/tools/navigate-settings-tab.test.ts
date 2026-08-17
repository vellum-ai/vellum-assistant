import { beforeEach, describe, expect, test } from "bun:test";

import type { ToolContext } from "../../../../tools/types.js";
import { run } from "./navigate-settings-tab.js";

let sentMessages: Array<{ type: string; [key: string]: unknown }> = [];

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "conv-xyz",
    trustClass: "guardian",
    sendToClient: (msg) => {
      sentMessages.push(msg);
    },
    ...overrides,
  };
}

describe("navigate_settings_tab tool", () => {
  beforeEach(() => {
    sentMessages = [];
  });

  test("navigates to the Voice tab and hints the inline picker", async () => {
    const result = await run({ tab: "Voice" }, makeContext());

    expect(result.isError).toBe(false);
    expect(sentMessages).toEqual([{ type: "navigate_settings", tab: "Voice" }]);
    expect(result.content).toStartWith("Opened settings to the Voice tab.");
    expect(result.content).toContain(
      'ui_show { surface_type: "voice_picker", data: {} }',
    );
  });

  test("leaves a non-Voice tab's result unchanged", async () => {
    const result = await run({ tab: "Billing" }, makeContext());

    expect(result.isError).toBe(false);
    expect(sentMessages).toEqual([
      { type: "navigate_settings", tab: "Billing" },
    ]);
    expect(result.content).toBe("Opened settings to the Billing tab.");
    expect(result.content).not.toContain("voice_picker");
  });

  test("resolves legacy tab aliases without hinting", async () => {
    const result = await run({ tab: "Archived Conversations" }, makeContext());

    expect(result.isError).toBe(false);
    expect(sentMessages).toEqual([
      { type: "navigate_settings", tab: "Archive" },
    ]);
    expect(result.content).toBe("Opened settings to the Archive tab.");
    expect(result.content).not.toContain("voice_picker");
  });

  test("rejects an unknown tab without navigating", async () => {
    const result = await run({ tab: "Telepathy" }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('unknown tab "Telepathy"');
    expect(sentMessages).toEqual([]);
  });
});
