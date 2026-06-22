import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  __TEST_ONLY__,
  getEditChatConversationId,
  resolveEditChatDraftConversationId,
  setEditChatConversationId,
} from "@/utils/edit-chat-session";

const ASSISTANT = "assistant-1";
const APP = "app-1";

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  window.sessionStorage.clear();
});

describe("edit-chat-session", () => {
  it("returns null when nothing is stored", () => {
    expect(getEditChatConversationId(ASSISTANT, APP)).toBeNull();
  });

  it("round-trips a stored id within the TTL", () => {
    setEditChatConversationId(ASSISTANT, APP, "conv-abc", 1_000_000);
    expect(getEditChatConversationId(ASSISTANT, APP, 1_000_500)).toBe("conv-abc");
  });

  it("expires the entry after the TTL", () => {
    setEditChatConversationId(ASSISTANT, APP, "conv-abc", 0);
    expect(getEditChatConversationId(ASSISTANT, APP, __TEST_ONLY__.TTL_MS + 1)).toBeNull();
  });

  it("scopes entries per (assistantId, appId)", () => {
    setEditChatConversationId(ASSISTANT, APP, "conv-a", 0);
    setEditChatConversationId(ASSISTANT, "app-2", "conv-b", 0);
    setEditChatConversationId("assistant-2", APP, "conv-c", 0);
    expect(getEditChatConversationId(ASSISTANT, APP, 0)).toBe("conv-a");
    expect(getEditChatConversationId(ASSISTANT, "app-2", 0)).toBe("conv-b");
    expect(getEditChatConversationId("assistant-2", APP, 0)).toBe("conv-c");
  });

  it("refreshes lastUsedAt on every set", () => {
    setEditChatConversationId(ASSISTANT, APP, "conv-abc", 0);
    setEditChatConversationId(ASSISTANT, APP, "conv-abc", __TEST_ONLY__.TTL_MS - 1);
    // Reading at TTL+1ms past the first write would expire, but the second
    // write refreshed the timestamp so the entry is still live.
    expect(getEditChatConversationId(ASSISTANT, APP, __TEST_ONLY__.TTL_MS + 100)).toBe("conv-abc");
  });

  it("resolves draft ids across all stored apps", () => {
    setEditChatConversationId(ASSISTANT, "app-a", "draft-1", 0);
    setEditChatConversationId(ASSISTANT, "app-b", "draft-1", 0);
    setEditChatConversationId(ASSISTANT, "app-c", "draft-2", 0);

    resolveEditChatDraftConversationId("draft-1", "real-1");

    expect(getEditChatConversationId(ASSISTANT, "app-a", 0)).toBe("real-1");
    expect(getEditChatConversationId(ASSISTANT, "app-b", 0)).toBe("real-1");
    expect(getEditChatConversationId(ASSISTANT, "app-c", 0)).toBe("draft-2");
  });

  it("ignores corrupted JSON", () => {
    window.sessionStorage.setItem(
      `${__TEST_ONLY__.PREFIX}${ASSISTANT}:${APP}`,
      "not-json",
    );
    expect(getEditChatConversationId(ASSISTANT, APP)).toBeNull();
  });
});
