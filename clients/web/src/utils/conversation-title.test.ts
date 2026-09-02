import { describe, expect, test } from "bun:test";

import {
  displayConversationTitle,
  GENERATING_TITLE_SENTINEL,
  resolveConversationTitleDisplay,
  UNTITLED_CONVERSATION_SENTINEL,
  UNTITLED_SENTINEL,
} from "@/utils/conversation-title";

const copy = {
  generating: "标题生成中...",
  untitled: "无标题",
};

describe("resolveConversationTitleDisplay", () => {
  test("maps the generating sentinel, including a unicode ellipsis", () => {
    expect(
      resolveConversationTitleDisplay(GENERATING_TITLE_SENTINEL, copy),
    ).toBe(copy.generating);
    expect(resolveConversationTitleDisplay("Generating title…", copy)).toBe(
      copy.generating,
    );
  });

  test("maps empty, Untitled, and Untitled Conversation to untitled copy", () => {
    expect(resolveConversationTitleDisplay(null, copy)).toBe(copy.untitled);
    expect(resolveConversationTitleDisplay(undefined, copy)).toBe(copy.untitled);
    expect(resolveConversationTitleDisplay("", copy)).toBe(copy.untitled);
    expect(resolveConversationTitleDisplay("   ", copy)).toBe(copy.untitled);
    expect(resolveConversationTitleDisplay(UNTITLED_SENTINEL, copy)).toBe(
      copy.untitled,
    );
    expect(
      resolveConversationTitleDisplay(UNTITLED_CONVERSATION_SENTINEL, copy),
    ).toBe(copy.untitled);
  });

  test("returns a real title unchanged", () => {
    expect(resolveConversationTitleDisplay("Auth Middleware Rewrite", copy)).toBe(
      "Auth Middleware Rewrite",
    );
  });
});

describe("displayConversationTitle", () => {
  test("uses the English catalog in tests", () => {
    expect(displayConversationTitle(null)).toBe("Untitled");
    expect(displayConversationTitle(GENERATING_TITLE_SENTINEL)).toBe(
      "Generating title...",
    );
    expect(displayConversationTitle("Weekly planning")).toBe("Weekly planning");
  });
});
