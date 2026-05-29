import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  loadOpenCategories,
  saveOpenCategories,
} from "@/domains/chat/utils/sidebar-group-collapse-storage";
import { installMemoryStorage } from "@/utils/memory-storage.test-helper";

const ASSISTANT_ID = "asst_123";
const STORAGE_KEY = `vellum:sidebar-open-categories:${ASSISTANT_ID}`;

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
