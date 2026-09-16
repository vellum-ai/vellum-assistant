import { describe, expect, test } from "bun:test";

import {
  autoSendPromptState,
  hasAutoSendPromptState,
} from "@/utils/auto-send-prompt";

describe("auto-send prompt provenance", () => {
  test("a bare URL load (null or undefined state) is not authorized to send", () => {
    expect(hasAutoSendPromptState(null)).toBe(false);
    expect(hasAutoSendPromptState(undefined)).toBe(false);
  });

  test("unrelated history state does not count", () => {
    expect(
      hasAutoSendPromptState({
        documentEntry: { surfaceId: "s", returnTo: "/assistant/library" },
      }),
    ).toBe(false);
    expect(hasAutoSendPromptState({ autoSendPrompt: "true" })).toBe(false);
    expect(hasAutoSendPromptState("autoSendPrompt")).toBe(false);
  });

  test("the marker round-trips and merges onto existing state", () => {
    expect(hasAutoSendPromptState(autoSendPromptState())).toBe(true);
    const merged = autoSendPromptState({
      documentEntry: { surfaceId: "s", returnTo: "/assistant/library" },
    });
    expect(hasAutoSendPromptState(merged)).toBe(true);
    expect(merged.documentEntry).toEqual({
      surfaceId: "s",
      returnTo: "/assistant/library",
    });
  });
});
