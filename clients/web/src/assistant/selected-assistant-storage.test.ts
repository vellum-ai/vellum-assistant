import { afterEach, describe, expect, test } from "bun:test";

import {
  SELECTED_ASSISTANT_STORAGE_KEY,
  clearSelectedAssistantId,
  readSelectedAssistantId,
  writeSelectedAssistantId,
} from "@/assistant/selected-assistant-storage";

afterEach(() => {
  localStorage.removeItem(SELECTED_ASSISTANT_STORAGE_KEY);
});

describe("selected-assistant-storage", () => {
  test("round-trips a written id", () => {
    writeSelectedAssistantId("asst-1");
    expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBe("asst-1");
    expect(readSelectedAssistantId()).toBe("asst-1");
  });

  test("reads null when unset", () => {
    expect(readSelectedAssistantId()).toBeNull();
  });

  test("reads null for an empty-string value", () => {
    localStorage.setItem(SELECTED_ASSISTANT_STORAGE_KEY, "");
    expect(readSelectedAssistantId()).toBeNull();
  });

  test("clear removes the key", () => {
    writeSelectedAssistantId("asst-1");
    clearSelectedAssistantId();
    expect(readSelectedAssistantId()).toBeNull();
    expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBeNull();
  });
});
