import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  loadLastViewedConversationId,
  saveLastViewedConversationId,
} from "@/utils/last-viewed-conversation-storage";
import { installMemoryStorage } from "@/utils/memory-storage.test-helper";

const ASSISTANT_ID = "asst_123";
const STORAGE_KEY = `vellum:lastViewedConversation:${ASSISTANT_ID}`;

const memoryStorage = installMemoryStorage({ beforeAll, afterAll, beforeEach, afterEach });

describe("loadLastViewedConversationId", () => {
  test("returns null when no value is stored", () => {
    expect(loadLastViewedConversationId(ASSISTANT_ID)).toBeNull();
  });

  test("returns the stored conversation key when present", () => {
    memoryStorage.setItem(STORAGE_KEY, "conv_abc");
    expect(loadLastViewedConversationId(ASSISTANT_ID)).toBe("conv_abc");
  });

  test("returns null when the stored value is an empty string", () => {
    memoryStorage.setItem(STORAGE_KEY, "");
    expect(loadLastViewedConversationId(ASSISTANT_ID)).toBeNull();
  });

  test("scopes lookups by assistant id", () => {
    memoryStorage.setItem(STORAGE_KEY, "conv_abc");
    expect(loadLastViewedConversationId("other_assistant")).toBeNull();
  });
});

describe("saveLastViewedConversationId", () => {
  test("writes the conversation key under the assistant-scoped storage key", () => {
    saveLastViewedConversationId(ASSISTANT_ID, "conv_abc");
    expect(memoryStorage.getItem(STORAGE_KEY)).toBe("conv_abc");
  });

  test("overwrites any previously stored value", () => {
    saveLastViewedConversationId(ASSISTANT_ID, "conv_abc");
    saveLastViewedConversationId(ASSISTANT_ID, "conv_def");
    expect(loadLastViewedConversationId(ASSISTANT_ID)).toBe("conv_def");
  });

  test("keeps values for different assistants isolated", () => {
    saveLastViewedConversationId(ASSISTANT_ID, "conv_abc");
    saveLastViewedConversationId("other_assistant", "conv_xyz");
    expect(loadLastViewedConversationId(ASSISTANT_ID)).toBe("conv_abc");
    expect(loadLastViewedConversationId("other_assistant")).toBe("conv_xyz");
  });
});
