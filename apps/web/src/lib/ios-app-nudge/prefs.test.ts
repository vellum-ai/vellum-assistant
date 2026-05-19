/**
 * Tests for ios-app-nudge/prefs.
 *
 * Covers the localStorage-backed read/write helpers, banner dismissal,
 * sidebar permanent dismiss, and the number pref (assistant turns)
 * accumulation logic.
 *
 * The `window` mock follows the same pattern as `mac-app-nudge/prefs.test.ts`.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Minimal in-memory Storage / Window shim
// ---------------------------------------------------------------------------

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

const ORIGINAL_WINDOW_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  globalThis,
  "window",
);
const ORIGINAL_LOCAL_STORAGE_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);

beforeAll(() => {
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: memoryStorage },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage,
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
  if (ORIGINAL_LOCAL_STORAGE_DESCRIPTOR) {
    Object.defineProperty(
      globalThis,
      "localStorage",
      ORIGINAL_LOCAL_STORAGE_DESCRIPTOR,
    );
  } else {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

beforeEach(() => {
  memoryStorage.clear();
});

afterEach(() => {
  memoryStorage.clear();
});

// ---------------------------------------------------------------------------
// Import subjects after window mock is installed
// ---------------------------------------------------------------------------

import {
  KEY_IOS_APP_DOWNLOADED,
  KEY_IOS_APP_BANNER_DISMISSED,
  KEY_IOS_APP_SIDEBAR_DISMISSED,
  KEY_IOS_APP_ASSISTANT_TURNS_SEEN,
} from "@/lib/ios-app-nudge/constants.js";

import {
  readIOSAppDownloaded,
  writeIOSAppDownloaded,
  readIOSAssistantTurnsSeen,
  incrementIOSAssistantTurnsSeen,
  __testing,
} from "@/lib/ios-app-nudge/prefs.js";

const {
  readBooleanPref,
  writeBooleanPref,
  readNumberPref,
  writeNumberPref,
  readIOSAppBannerDismissed,
  writeIOSAppBannerDismissed,
  readSidebarDismissed,
  writeSidebarDismissed,
} = __testing;

// ---------------------------------------------------------------------------
// Storage key contract
// ---------------------------------------------------------------------------

describe("storage key contract", () => {
  test("downloaded key is namespaced under app.iosNudge.*", () => {
    expect(KEY_IOS_APP_DOWNLOADED).toBe("app.iosNudge.downloaded");
  });

  test("bannerDismissed key is namespaced under app.iosNudge.*", () => {
    expect(KEY_IOS_APP_BANNER_DISMISSED).toBe("app.iosNudge.bannerDismissed");
  });

  test("sidebarDismissed key is namespaced under app.iosNudge.*", () => {
    expect(KEY_IOS_APP_SIDEBAR_DISMISSED).toBe(
      "app.iosNudge.sidebarDismissed",
    );
  });

  test("assistantTurnsSeen key is namespaced under app.iosNudge.*", () => {
    expect(KEY_IOS_APP_ASSISTANT_TURNS_SEEN).toBe(
      "app.iosNudge.assistantTurnsSeen",
    );
  });
});

// ---------------------------------------------------------------------------
// readBooleanPref
// ---------------------------------------------------------------------------

describe("readBooleanPref", () => {
  test("returns defaultValue when key is absent", () => {
    expect(readBooleanPref(KEY_IOS_APP_DOWNLOADED, false)).toBe(false);
    expect(readBooleanPref(KEY_IOS_APP_DOWNLOADED, true)).toBe(true);
  });

  test("returns true when stored value is 'true'", () => {
    memoryStorage.setItem(KEY_IOS_APP_DOWNLOADED, "true");
    expect(readBooleanPref(KEY_IOS_APP_DOWNLOADED, false)).toBe(true);
  });

  test("returns false when stored value is 'false'", () => {
    memoryStorage.setItem(KEY_IOS_APP_DOWNLOADED, "false");
    expect(readBooleanPref(KEY_IOS_APP_DOWNLOADED, true)).toBe(false);
  });

  test("falls back to defaultValue for non-literal stored value", () => {
    memoryStorage.setItem(KEY_IOS_APP_DOWNLOADED, "yes");
    expect(readBooleanPref(KEY_IOS_APP_DOWNLOADED, false)).toBe(false);
    expect(readBooleanPref(KEY_IOS_APP_DOWNLOADED, true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writeBooleanPref
// ---------------------------------------------------------------------------

describe("writeBooleanPref", () => {
  test("persists 'true' as a literal string", () => {
    writeBooleanPref(KEY_IOS_APP_DOWNLOADED, true);
    expect(memoryStorage.getItem(KEY_IOS_APP_DOWNLOADED)).toBe("true");
  });

  test("persists 'false' as a literal string", () => {
    writeBooleanPref(KEY_IOS_APP_DOWNLOADED, false);
    expect(memoryStorage.getItem(KEY_IOS_APP_DOWNLOADED)).toBe("false");
  });

  test("round-trips — write then read returns the same boolean", () => {
    writeBooleanPref(KEY_IOS_APP_DOWNLOADED, true);
    expect(readBooleanPref(KEY_IOS_APP_DOWNLOADED, false)).toBe(true);
    writeBooleanPref(KEY_IOS_APP_DOWNLOADED, false);
    expect(readBooleanPref(KEY_IOS_APP_DOWNLOADED, true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readNumberPref
// ---------------------------------------------------------------------------

describe("readNumberPref", () => {
  test("returns defaultValue when key is absent", () => {
    expect(readNumberPref(KEY_IOS_APP_ASSISTANT_TURNS_SEEN, 0)).toBe(0);
  });

  test("returns stored number", () => {
    memoryStorage.setItem(KEY_IOS_APP_ASSISTANT_TURNS_SEEN, "7");
    expect(readNumberPref(KEY_IOS_APP_ASSISTANT_TURNS_SEEN, 0)).toBe(7);
  });

  test("returns defaultValue for NaN stored value", () => {
    memoryStorage.setItem(KEY_IOS_APP_ASSISTANT_TURNS_SEEN, "abc");
    expect(readNumberPref(KEY_IOS_APP_ASSISTANT_TURNS_SEEN, 0)).toBe(0);
  });

  test("returns defaultValue for negative stored value", () => {
    memoryStorage.setItem(KEY_IOS_APP_ASSISTANT_TURNS_SEEN, "-3");
    expect(readNumberPref(KEY_IOS_APP_ASSISTANT_TURNS_SEEN, 0)).toBe(0);
  });

  test("returns defaultValue for Infinity", () => {
    memoryStorage.setItem(KEY_IOS_APP_ASSISTANT_TURNS_SEEN, "Infinity");
    expect(readNumberPref(KEY_IOS_APP_ASSISTANT_TURNS_SEEN, 0)).toBe(0);
  });

  test("accepts zero as a valid stored value", () => {
    memoryStorage.setItem(KEY_IOS_APP_ASSISTANT_TURNS_SEEN, "0");
    expect(readNumberPref(KEY_IOS_APP_ASSISTANT_TURNS_SEEN, 5)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// writeNumberPref
// ---------------------------------------------------------------------------

describe("writeNumberPref", () => {
  test("persists number as a string", () => {
    writeNumberPref(KEY_IOS_APP_ASSISTANT_TURNS_SEEN, 42);
    expect(memoryStorage.getItem(KEY_IOS_APP_ASSISTANT_TURNS_SEEN)).toBe("42");
  });

  test("round-trips — write then read returns the same number", () => {
    writeNumberPref(KEY_IOS_APP_ASSISTANT_TURNS_SEEN, 10);
    expect(readNumberPref(KEY_IOS_APP_ASSISTANT_TURNS_SEEN, 0)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Public readers / writers: downloaded
// ---------------------------------------------------------------------------

describe("readIOSAppDownloaded / writeIOSAppDownloaded", () => {
  test("returns false by default", () => {
    expect(readIOSAppDownloaded()).toBe(false);
  });

  test("returns true after write", () => {
    writeIOSAppDownloaded();
    expect(readIOSAppDownloaded()).toBe(true);
  });

  test("writes to the correct localStorage key", () => {
    writeIOSAppDownloaded();
    expect(memoryStorage.getItem("app.iosNudge.downloaded")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// Public readers / writers: banner dismissed
// ---------------------------------------------------------------------------

describe("readIOSAppBannerDismissed / writeIOSAppBannerDismissed", () => {
  test("returns false by default", () => {
    expect(readIOSAppBannerDismissed()).toBe(false);
  });

  test("returns true after write", () => {
    writeIOSAppBannerDismissed();
    expect(readIOSAppBannerDismissed()).toBe(true);
  });

  test("writes to the correct localStorage key", () => {
    writeIOSAppBannerDismissed();
    expect(memoryStorage.getItem("app.iosNudge.bannerDismissed")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// Sidebar dismissed (permanent localStorage)
// ---------------------------------------------------------------------------

describe("readSidebarDismissed / writeSidebarDismissed", () => {
  test("returns false by default", () => {
    expect(readSidebarDismissed()).toBe(false);
  });

  test("returns true after write", () => {
    writeSidebarDismissed();
    expect(readSidebarDismissed()).toBe(true);
  });

  test("writes to the correct localStorage key", () => {
    writeSidebarDismissed();
    expect(memoryStorage.getItem("app.iosNudge.sidebarDismissed")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// Public readers / writers: assistant turns seen
// ---------------------------------------------------------------------------

describe("readIOSAssistantTurnsSeen / incrementIOSAssistantTurnsSeen", () => {
  test("returns 0 by default", () => {
    expect(readIOSAssistantTurnsSeen()).toBe(0);
  });

  test("increments by 1 by default", () => {
    incrementIOSAssistantTurnsSeen();
    expect(readIOSAssistantTurnsSeen()).toBe(1);
  });

  test("accumulates across multiple increments", () => {
    incrementIOSAssistantTurnsSeen();
    incrementIOSAssistantTurnsSeen();
    incrementIOSAssistantTurnsSeen();
    expect(readIOSAssistantTurnsSeen()).toBe(3);
  });

  test("increments by custom delta", () => {
    incrementIOSAssistantTurnsSeen(5);
    expect(readIOSAssistantTurnsSeen()).toBe(5);
    incrementIOSAssistantTurnsSeen(3);
    expect(readIOSAssistantTurnsSeen()).toBe(8);
  });

  test("no-op for zero delta", () => {
    incrementIOSAssistantTurnsSeen(0);
    expect(readIOSAssistantTurnsSeen()).toBe(0);
  });

  test("no-op for negative delta", () => {
    incrementIOSAssistantTurnsSeen(3);
    incrementIOSAssistantTurnsSeen(-1);
    expect(readIOSAssistantTurnsSeen()).toBe(3);
  });

  test("writes to the correct localStorage key", () => {
    incrementIOSAssistantTurnsSeen(2);
    expect(memoryStorage.getItem("app.iosNudge.assistantTurnsSeen")).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// Public API shape
// ---------------------------------------------------------------------------

describe("public API", () => {
  test("all expected functions are exported", async () => {
    const mod = await import("./prefs");
    expect(typeof mod.readIOSAppDownloaded).toBe("function");
    expect(typeof mod.writeIOSAppDownloaded).toBe("function");
    expect(typeof mod.readIOSAssistantTurnsSeen).toBe("function");
    expect(typeof mod.incrementIOSAssistantTurnsSeen).toBe("function");
    expect(typeof mod.useIOSNudgeState).toBe("function");
    expect(typeof mod.openIOSAppStore).toBe("function");
  });
});
