import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  loadLastViewedConversationKey,
  saveLastViewedConversationKey,
} from "@/domains/chat/utils/lastViewedConversationStorage.js";

const ASSISTANT_ID = "asst_123";
const STORAGE_KEY = `vellum:lastViewedConversation:${ASSISTANT_ID}`;

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

const memoryStorage = new MemoryStorage();
// Track the original `window` descriptor so we can restore it after this test
// file finishes. Other tests in the same bun worker rely on `typeof window ===
// "undefined"` to pick a baseUrl for the HTTP client, so we must not leak a
// defined `window` into unrelated suites.
const ORIGINAL_WINDOW_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  globalThis,
  "window",
);

beforeAll(() => {
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: memoryStorage },
    configurable: true,
    writable: true,
  });
});

afterAll(() => {
  if (ORIGINAL_WINDOW_DESCRIPTOR) {
    Object.defineProperty(globalThis, "window", ORIGINAL_WINDOW_DESCRIPTOR);
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
});

beforeEach(() => {
  memoryStorage.clear();
});

afterEach(() => {
  memoryStorage.clear();
});

describe("loadLastViewedConversationKey", () => {
  test("returns null when no value is stored", () => {
    expect(loadLastViewedConversationKey(ASSISTANT_ID)).toBeNull();
  });

  test("returns the stored conversation key when present", () => {
    memoryStorage.setItem(STORAGE_KEY, "conv_abc");
    expect(loadLastViewedConversationKey(ASSISTANT_ID)).toBe("conv_abc");
  });

  test("returns null when the stored value is an empty string", () => {
    memoryStorage.setItem(STORAGE_KEY, "");
    expect(loadLastViewedConversationKey(ASSISTANT_ID)).toBeNull();
  });

  test("scopes lookups by assistant id", () => {
    memoryStorage.setItem(STORAGE_KEY, "conv_abc");
    expect(loadLastViewedConversationKey("other_assistant")).toBeNull();
  });
});

describe("saveLastViewedConversationKey", () => {
  test("writes the conversation key under the assistant-scoped storage key", () => {
    saveLastViewedConversationKey(ASSISTANT_ID, "conv_abc");
    expect(memoryStorage.getItem(STORAGE_KEY)).toBe("conv_abc");
  });

  test("overwrites any previously stored value", () => {
    saveLastViewedConversationKey(ASSISTANT_ID, "conv_abc");
    saveLastViewedConversationKey(ASSISTANT_ID, "conv_def");
    expect(loadLastViewedConversationKey(ASSISTANT_ID)).toBe("conv_def");
  });

  test("keeps values for different assistants isolated", () => {
    saveLastViewedConversationKey(ASSISTANT_ID, "conv_abc");
    saveLastViewedConversationKey("other_assistant", "conv_xyz");
    expect(loadLastViewedConversationKey(ASSISTANT_ID)).toBe("conv_abc");
    expect(loadLastViewedConversationKey("other_assistant")).toBe("conv_xyz");
  });
});
