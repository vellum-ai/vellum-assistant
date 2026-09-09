import { describe, expect, test } from "bun:test";

import {
  displayConversationTitle,
  resolveConversationTitleDisplay,
} from "@/utils/conversation-title";

describe("resolveConversationTitleDisplay", () => {
  test("uses untitled copy for an empty title", () => {
    expect(resolveConversationTitleDisplay(null, "无标题")).toBe("无标题");
    expect(resolveConversationTitleDisplay("", "无标题")).toBe("无标题");
    expect(resolveConversationTitleDisplay("   ", "无标题")).toBe("无标题");
  });

  test("returns a title unchanged", () => {
    expect(
      resolveConversationTitleDisplay("Auth Middleware Rewrite", "无标题"),
    ).toBe("Auth Middleware Rewrite");
    expect(
      resolveConversationTitleDisplay("Generating title...", "无标题"),
    ).toBe("Generating title...");
    expect(
      resolveConversationTitleDisplay("Sin título", "Untitled"),
    ).toBe("Sin título");
  });
});

describe("displayConversationTitle", () => {
  test("uses the English catalog in tests", () => {
    expect(displayConversationTitle(null)).toBe("Untitled");
    expect(displayConversationTitle("Weekly planning")).toBe("Weekly planning");
  });
});
