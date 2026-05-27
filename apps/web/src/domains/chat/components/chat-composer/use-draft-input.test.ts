/**
 * Tests for useDraftInput localStorage helpers and switch-detection logic.
 *
 * The workspace lacks @testing-library/react (no jsdom), so we test the
 * exported pure helpers and the localStorage serialization contract directly
 * via a minimal localStorage shim.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// localStorage shim (Bun test env has no window.localStorage)
// ---------------------------------------------------------------------------

const store = new Map<string, string>();

const localStorageShim = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value);
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
  clear: () => {
    store.clear();
  },
  get length() {
    return store.size;
  },
  key: (_index: number): string | null => null,
};

// Install the shim globally before importing the module under test so it
// can see `window.localStorage`.
if (typeof globalThis.window === "undefined") {
  (globalThis as Record<string, unknown>).window = { localStorage: localStorageShim };
} else {
  Object.defineProperty(globalThis.window, "localStorage", {
    value: localStorageShim,
    writable: true,
    configurable: true,
  });
}

// Dynamic import AFTER the shim is installed.
const { loadDraftsForTest, persistDraftsForTest } = await import(
  "./use-draft-input-test-helpers"
);

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  store.clear();
});

afterEach(() => {
  store.clear();
});

// ---------------------------------------------------------------------------
// loadDrafts
// ---------------------------------------------------------------------------

describe("loadDrafts", () => {
  test("returns empty map when nothing stored", () => {
    const result = loadDraftsForTest("ast-1");
    expect(result.size).toBe(0);
  });

  test("round-trips through persist → load", () => {
    const drafts = new Map([
      ["conv-a", "hello"],
      ["conv-b", "world"],
    ]);
    persistDraftsForTest("ast-1", drafts);
    const loaded = loadDraftsForTest("ast-1");
    expect(loaded.size).toBe(2);
    expect(loaded.get("conv-a")).toBe("hello");
    expect(loaded.get("conv-b")).toBe("world");
  });

  test("ignores non-string values in stored JSON", () => {
    store.set("vellum:chatDrafts:ast-1", JSON.stringify({
      "conv-a": "valid",
      "conv-b": 42,
      "conv-c": null,
      "conv-d": true,
    }));
    const loaded = loadDraftsForTest("ast-1");
    expect(loaded.size).toBe(1);
    expect(loaded.get("conv-a")).toBe("valid");
  });

  test("returns empty map for malformed JSON", () => {
    store.set("vellum:chatDrafts:ast-1", "not json");
    const loaded = loadDraftsForTest("ast-1");
    expect(loaded.size).toBe(0);
  });

  test("returns empty map for non-object JSON (array)", () => {
    store.set("vellum:chatDrafts:ast-1", '["a","b"]');
    const loaded = loadDraftsForTest("ast-1");
    expect(loaded.size).toBe(0);
  });

  test("scopes by assistantId", () => {
    persistDraftsForTest("ast-1", new Map([["conv-a", "draft 1"]]));
    persistDraftsForTest("ast-2", new Map([["conv-a", "draft 2"]]));
    expect(loadDraftsForTest("ast-1").get("conv-a")).toBe("draft 1");
    expect(loadDraftsForTest("ast-2").get("conv-a")).toBe("draft 2");
  });
});

// ---------------------------------------------------------------------------
// persistDrafts
// ---------------------------------------------------------------------------

describe("persistDrafts", () => {
  test("writes JSON object to localStorage", () => {
    persistDraftsForTest("ast-1", new Map([["conv-a", "hello"]]));
    const raw = store.get("vellum:chatDrafts:ast-1");
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual({ "conv-a": "hello" });
  });

  test("overwrites previous drafts", () => {
    persistDraftsForTest("ast-1", new Map([["conv-a", "first"]]));
    persistDraftsForTest("ast-1", new Map([["conv-b", "second"]]));
    const loaded = loadDraftsForTest("ast-1");
    expect(loaded.size).toBe(1);
    expect(loaded.has("conv-a")).toBe(false);
    expect(loaded.get("conv-b")).toBe("second");
  });

  test("empty map writes empty object", () => {
    persistDraftsForTest("ast-1", new Map());
    const raw = store.get("vellum:chatDrafts:ast-1");
    expect(JSON.parse(raw!)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Switch detection (pure logic)
// ---------------------------------------------------------------------------

describe("conversation switch detection", () => {
  function isConversationSwitch(prevKey: string | null, nextKey: string | null): boolean {
    return prevKey !== null && prevKey !== nextKey;
  }

  test("null → key is not a switch (initial mount)", () => {
    expect(isConversationSwitch(null, "conv-a")).toBe(false);
  });

  test("same key is not a switch", () => {
    expect(isConversationSwitch("conv-a", "conv-a")).toBe(false);
  });

  test("different keys IS a switch", () => {
    expect(isConversationSwitch("conv-a", "conv-b")).toBe(true);
  });

  test("key → null IS a switch (save outgoing, no restore)", () => {
    expect(isConversationSwitch("conv-a", null)).toBe(true);
  });
});
