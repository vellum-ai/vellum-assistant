import { describe, expect, test } from "bun:test";

import {
  displayConversationTitle,
  resolveConversationTitleDisplay,
} from "@/utils/conversation-title";

const copy = {
  generating: "标题生成中...",
  untitled: "无标题",
};

describe("resolveConversationTitleDisplay", () => {
  test("uses titleState generating, not the title string", () => {
    expect(
      resolveConversationTitleDisplay("Weekly planning", copy, "generating"),
    ).toBe(copy.generating);
  });

  test("uses titleState untitled or an empty title", () => {
    expect(
      resolveConversationTitleDisplay("Untitled Conversation", copy, "untitled"),
    ).toBe(copy.untitled);
    expect(resolveConversationTitleDisplay(null, copy)).toBe(copy.untitled);
    expect(resolveConversationTitleDisplay("", copy)).toBe(copy.untitled);
    expect(resolveConversationTitleDisplay("   ", copy)).toBe(copy.untitled);
  });

  test("returns a real title unchanged when titleState is absent", () => {
    expect(
      resolveConversationTitleDisplay("Auth Middleware Rewrite", copy),
    ).toBe("Auth Middleware Rewrite");
    expect(
      resolveConversationTitleDisplay("Generating title...", copy),
    ).toBe("Generating title...");
  });
});

describe("displayConversationTitle", () => {
  test("uses the English catalog in tests", () => {
    expect(displayConversationTitle(null)).toBe("Untitled");
    expect(displayConversationTitle("Weekly planning", undefined, "generating")).toBe(
      "Generating title...",
    );
    expect(displayConversationTitle("Weekly planning")).toBe("Weekly planning");
  });
});
