import { describe, expect, test } from "bun:test";

import { run } from "../config/bundled-skills/settings/tools/navigate-settings-tab.js";
import type { ToolContext } from "../tools/types.js";

function makeContext(sendToClient?: (msg: unknown) => void): ToolContext {
  return { sendToClient } as unknown as ToolContext;
}

const CANONICAL_TABS = [
  "General",
  "Channels",
  "Models & Services",
  "Voice",
  "Permissions & Privacy",
  "Contacts",
  "Developer",
];

const LEGACY_TABS = [
  "Account",
  "Connect",
  "Trust",
  "Model",
  "Scheduling",
  "Appearance",
  "Advanced",
  "Privacy",
  "Sentry Testing",
  "Automation",
];

describe("navigate-settings-tab", () => {
  describe("accepts canonical tab names", () => {
    for (const tab of CANONICAL_TABS) {
      test(`accepts "${tab}"`, async () => {
        const messages: unknown[] = [];
        const result = await run(
          { tab },
          makeContext((msg) => messages.push(msg)),
        );

        expect(result.isError).toBe(false);
        expect(result.content).toContain(tab);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toEqual({ type: "navigate_settings", tab });
      });
    }
  });

  describe("rejects legacy tab names", () => {
    for (const tab of LEGACY_TABS) {
      test(`rejects "${tab}"`, async () => {
        const messages: unknown[] = [];
        const result = await run(
          { tab },
          makeContext((msg) => messages.push(msg)),
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("Error");
        expect(result.content).toContain(tab);
        expect(messages).toHaveLength(0);
      });
    }
  });

  test("navigate_settings payload includes type and tab", async () => {
    const messages: unknown[] = [];
    await run(
      { tab: "General" },
      makeContext((msg) => messages.push(msg)),
    );

    expect(messages).toEqual([{ type: "navigate_settings", tab: "General" }]);
  });

  test("works when sendToClient is undefined", async () => {
    const result = await run({ tab: "Developer" }, makeContext());

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Developer");
  });
});
