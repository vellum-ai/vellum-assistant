import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  channelSectionKey,
  loadOpenCategories,
  loadOpenPrimary,
  saveOpenCategories,
  saveOpenPrimary,
} from "@/domains/chat/utils/sidebar-group-collapse-storage";
import { installMemoryStorage } from "@/utils/memory-storage.test-helper";

const ASSISTANT_ID = "asst_123";
const STORAGE_KEY = `vellum:sidebar-open-categories:${ASSISTANT_ID}`;
const PRIMARY_STORAGE_KEY = `vellum:sidebar-open-primary:${ASSISTANT_ID}`;

const memoryStorage = installMemoryStorage({ beforeAll, afterAll, beforeEach, afterEach });

describe("loadOpenCategories", () => {
  test("returns default [] when no value is stored", () => {
    expect(loadOpenCategories(ASSISTANT_ID)).toEqual([]);
  });

  test("returns the stored categories when present", () => {
    memoryStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(["scheduled", "background"]),
    );
    expect(loadOpenCategories(ASSISTANT_ID)).toEqual(["scheduled", "background"]);
  });

  test("filters stale flattened category values", () => {
    memoryStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(["pinned", "recents", "background"]),
    );
    expect(loadOpenCategories(ASSISTANT_ID)).toEqual(["background"]);
  });

  test("returns empty array when stored value is an empty array", () => {
    memoryStorage.setItem(STORAGE_KEY, JSON.stringify([]));
    expect(loadOpenCategories(ASSISTANT_ID)).toEqual([]);
  });

  test("returns default [] when stored value is not a string array", () => {
    memoryStorage.setItem(STORAGE_KEY, JSON.stringify({ foo: "bar" }));
    expect(loadOpenCategories(ASSISTANT_ID)).toEqual([]);
  });

  test("returns default [] when stored value is invalid JSON", () => {
    memoryStorage.setItem(STORAGE_KEY, "not-json{{{");
    expect(loadOpenCategories(ASSISTANT_ID)).toEqual([]);
  });

  test("scopes lookups by assistant id", () => {
    memoryStorage.setItem(STORAGE_KEY, JSON.stringify(["scheduled"]));
    expect(loadOpenCategories("other_assistant")).toEqual([]);
  });

  test("keeps per-channel section keys", () => {
    memoryStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        channelSectionKey("slack"),
        channelSectionKey("telegram"),
        "background",
        "bogus",
      ]),
    );
    expect(loadOpenCategories(ASSISTANT_ID)).toEqual([
      "channel:slack",
      "channel:telegram",
      "background",
    ]);
  });
});

describe("channelSectionKey", () => {
  test("prefixes the channel id", () => {
    expect(channelSectionKey("telegram")).toBe("channel:telegram");
    expect(channelSectionKey("slack")).toBe("channel:slack");
  });
});

describe("saveOpenCategories", () => {
  test("writes the categories under the assistant-scoped storage key", () => {
    saveOpenCategories(ASSISTANT_ID, ["scheduled", "background"]);
    expect(memoryStorage.getItem(STORAGE_KEY)).toBe(
      JSON.stringify(["scheduled", "background"]),
    );
  });

  test("overwrites any previously stored value", () => {
    saveOpenCategories(ASSISTANT_ID, ["scheduled", "background"]);
    saveOpenCategories(ASSISTANT_ID, ["background"]);
    expect(loadOpenCategories(ASSISTANT_ID)).toEqual(["background"]);
  });

  test("persists an empty array when all categories are collapsed", () => {
    saveOpenCategories(ASSISTANT_ID, []);
    expect(loadOpenCategories(ASSISTANT_ID)).toEqual([]);
  });

  test("keeps values for different assistants isolated", () => {
    saveOpenCategories(ASSISTANT_ID, ["background"]);
    saveOpenCategories("other_assistant", ["scheduled"]);
    expect(loadOpenCategories(ASSISTANT_ID)).toEqual(["background"]);
    expect(loadOpenCategories("other_assistant")).toEqual(["scheduled"]);
  });
});

describe("loadOpenPrimary", () => {
  test("defaults to both Pinned and Chats open when nothing is stored", () => {
    expect(loadOpenPrimary(ASSISTANT_ID)).toEqual(["pinned", "recents"]);
  });

  test("returns an empty array when the user has collapsed both", () => {
    // A stored empty array is distinct from an absent key — it means the user
    // explicitly collapsed both sections, so we must NOT fall back to open.
    memoryStorage.setItem(PRIMARY_STORAGE_KEY, JSON.stringify([]));
    expect(loadOpenPrimary(ASSISTANT_ID)).toEqual([]);
  });

  test("returns the stored subset when only one is open", () => {
    memoryStorage.setItem(PRIMARY_STORAGE_KEY, JSON.stringify(["pinned"]));
    expect(loadOpenPrimary(ASSISTANT_ID)).toEqual(["pinned"]);
  });

  test("filters unknown keys", () => {
    memoryStorage.setItem(
      PRIMARY_STORAGE_KEY,
      JSON.stringify(["pinned", "recents", "scheduled", "bogus"]),
    );
    expect(loadOpenPrimary(ASSISTANT_ID)).toEqual(["pinned", "recents"]);
  });
});

describe("saveOpenPrimary", () => {
  test("writes under the assistant-scoped primary storage key", () => {
    saveOpenPrimary(ASSISTANT_ID, ["recents"]);
    expect(memoryStorage.getItem(PRIMARY_STORAGE_KEY)).toBe(
      JSON.stringify(["recents"]),
    );
    expect(loadOpenPrimary(ASSISTANT_ID)).toEqual(["recents"]);
  });

  test("persists the collapsed-both state across a reload", () => {
    saveOpenPrimary(ASSISTANT_ID, []);
    expect(loadOpenPrimary(ASSISTANT_ID)).toEqual([]);
  });
});
