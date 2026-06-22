import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { AppSummary } from "@/types/app-types";
import {
  isAppPinned,
  loadPinnedApps,
  pinApp,
  savePinnedApps,
  unpinApp,
} from "@/utils/app-pin-storage";
import { installMemoryStorage } from "@/utils/memory-storage.test-helper";

const STORAGE_KEY = "vellum:pinnedApps";

const memoryStorage = installMemoryStorage({ beforeAll, afterAll, beforeEach, afterEach });

function makeApp(overrides: Partial<AppSummary> & { id: string }): AppSummary {
  return {
    name: `App ${overrides.id}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: "1.0.0",
    contentId: `content_${overrides.id}`,
    ...overrides,
  };
}

describe("loadPinnedApps", () => {
  test("returns empty array when nothing is stored", () => {
    expect(loadPinnedApps()).toEqual([]);
  });

  test("returns stored entries", () => {
    const entries = [
      { appId: "a1", pinnedOrder: 1, name: "App 1" },
      { appId: "a2", pinnedOrder: 2, name: "App 2", icon: "star" },
    ];
    memoryStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    expect(loadPinnedApps()).toEqual(entries);
  });

  test("returns empty array for invalid JSON", () => {
    memoryStorage.setItem(STORAGE_KEY, "not-json{");
    expect(loadPinnedApps()).toEqual([]);
  });

  test("filters out invalid entries", () => {
    const data = [
      { appId: "a1", pinnedOrder: 1, name: "Valid" },
      { appId: 123, pinnedOrder: 2, name: "Bad ID" },
      { appId: "a3", pinnedOrder: "not-a-number", name: "Bad order" },
      null,
    ];
    memoryStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    expect(loadPinnedApps()).toEqual([
      { appId: "a1", pinnedOrder: 1, name: "Valid" },
    ]);
  });
});

describe("savePinnedApps", () => {
  test("writes entries to localStorage", () => {
    const entries = [{ appId: "a1", pinnedOrder: 1, name: "App 1" }];
    savePinnedApps(entries);
    expect(JSON.parse(memoryStorage.getItem(STORAGE_KEY)!)).toEqual(entries);
  });
});

describe("pinApp", () => {
  test("pins an app to empty list", () => {
    pinApp(makeApp({ id: "a1", name: "First", icon: "star" }));
    const result = loadPinnedApps();
    expect(result).toEqual([
      { appId: "a1", pinnedOrder: 1, name: "First", icon: "star" },
    ]);
  });

  test("appends with incrementing order", () => {
    pinApp(makeApp({ id: "a1", name: "First" }));
    pinApp(makeApp({ id: "a2", name: "Second" }));
    pinApp(makeApp({ id: "a3", name: "Third" }));
    const result = loadPinnedApps();
    expect(result).toHaveLength(3);
    expect(result[0]!.pinnedOrder).toBe(1);
    expect(result[1]!.pinnedOrder).toBe(2);
    expect(result[2]!.pinnedOrder).toBe(3);
  });

  test("is idempotent — pinning same app twice does not duplicate", () => {
    pinApp(makeApp({ id: "a1", name: "First" }));
    pinApp(makeApp({ id: "a1", name: "First" }));
    expect(loadPinnedApps()).toHaveLength(1);
  });
});

describe("unpinApp", () => {
  test("removes the app from the list", () => {
    pinApp(makeApp({ id: "a1", name: "First" }));
    pinApp(makeApp({ id: "a2", name: "Second" }));
    unpinApp("a1");
    const result = loadPinnedApps();
    expect(result).toHaveLength(1);
    expect(result[0]!.appId).toBe("a2");
  });

  test("re-compacts order values (no gaps)", () => {
    pinApp(makeApp({ id: "a1", name: "First" }));
    pinApp(makeApp({ id: "a2", name: "Second" }));
    pinApp(makeApp({ id: "a3", name: "Third" }));
    unpinApp("a2");
    const result = loadPinnedApps();
    expect(result.map((e) => e.pinnedOrder)).toEqual([1, 2]);
    expect(result[0]!.appId).toBe("a1");
    expect(result[1]!.appId).toBe("a3");
  });

  test("unpinning non-existent app is a no-op", () => {
    pinApp(makeApp({ id: "a1", name: "First" }));
    unpinApp("non-existent");
    expect(loadPinnedApps()).toHaveLength(1);
  });
});

describe("isAppPinned", () => {
  test("returns false when nothing is pinned", () => {
    expect(isAppPinned("a1")).toBe(false);
  });

  test("returns true for a pinned app", () => {
    pinApp(makeApp({ id: "a1", name: "First" }));
    expect(isAppPinned("a1")).toBe(true);
  });

  test("returns false after unpinning", () => {
    pinApp(makeApp({ id: "a1", name: "First" }));
    unpinApp("a1");
    expect(isAppPinned("a1")).toBe(false);
  });
});

describe("pin/unpin round-trip", () => {
  test("full lifecycle: pin, verify, unpin, verify", () => {
    const app = makeApp({ id: "a1", name: "My App", icon: "rocket" });
    expect(isAppPinned("a1")).toBe(false);

    pinApp(app);
    expect(isAppPinned("a1")).toBe(true);
    expect(loadPinnedApps()).toEqual([
      { appId: "a1", pinnedOrder: 1, name: "My App", icon: "rocket" },
    ]);

    unpinApp("a1");
    expect(isAppPinned("a1")).toBe(false);
    expect(loadPinnedApps()).toEqual([]);
  });
});
