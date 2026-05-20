import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  __TEST_ONLY__,
  getEditChatKey,
  resolveEditChatDraftKey,
  setEditChatKey,
} from "@/domains/chat/utils/edit-chat-session.js";

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
    expect(getEditChatKey(ASSISTANT, APP)).toBeNull();
  });

  it("round-trips a stored key within the TTL", () => {
    setEditChatKey(ASSISTANT, APP, "conv-abc", 1_000_000);
    expect(getEditChatKey(ASSISTANT, APP, 1_000_500)).toBe("conv-abc");
  });

  it("expires the entry after the TTL", () => {
    setEditChatKey(ASSISTANT, APP, "conv-abc", 0);
    expect(getEditChatKey(ASSISTANT, APP, __TEST_ONLY__.TTL_MS + 1)).toBeNull();
  });

  it("scopes entries per (assistantId, appId)", () => {
    setEditChatKey(ASSISTANT, APP, "conv-a", 0);
    setEditChatKey(ASSISTANT, "app-2", "conv-b", 0);
    setEditChatKey("assistant-2", APP, "conv-c", 0);
    expect(getEditChatKey(ASSISTANT, APP, 0)).toBe("conv-a");
    expect(getEditChatKey(ASSISTANT, "app-2", 0)).toBe("conv-b");
    expect(getEditChatKey("assistant-2", APP, 0)).toBe("conv-c");
  });

  it("refreshes lastUsedAt on every set", () => {
    setEditChatKey(ASSISTANT, APP, "conv-abc", 0);
    setEditChatKey(ASSISTANT, APP, "conv-abc", __TEST_ONLY__.TTL_MS - 1);
    // Reading at TTL+1ms past the first write would expire, but the second
    // write refreshed the timestamp so the entry is still live.
    expect(getEditChatKey(ASSISTANT, APP, __TEST_ONLY__.TTL_MS + 100)).toBe("conv-abc");
  });

  it("resolves draft keys across all stored apps", () => {
    setEditChatKey(ASSISTANT, "app-a", "draft-1", 0);
    setEditChatKey(ASSISTANT, "app-b", "draft-1", 0);
    setEditChatKey(ASSISTANT, "app-c", "draft-2", 0);

    resolveEditChatDraftKey("draft-1", "real-1");

    expect(getEditChatKey(ASSISTANT, "app-a", 0)).toBe("real-1");
    expect(getEditChatKey(ASSISTANT, "app-b", 0)).toBe("real-1");
    expect(getEditChatKey(ASSISTANT, "app-c", 0)).toBe("draft-2");
  });

  it("ignores corrupted JSON", () => {
    window.sessionStorage.setItem(
      `${__TEST_ONLY__.PREFIX}${ASSISTANT}:${APP}`,
      "not-json",
    );
    expect(getEditChatKey(ASSISTANT, APP)).toBeNull();
  });
});
