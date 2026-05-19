/**
 * Tests for `github-nudge/prefs`: storage key namespacing, read/write
 * helpers, and round-trip persistence for the three boolean flags
 * (`starred`, `bannerDismissed`, `sidebarDismissed`) and the
 * `GITHUB_REPO_URL` constant.
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
// Minimal in-memory Storage / Window shim. Installed before the module
// under test is imported so the `typeof window` SSR guards in prefs.ts
// see a defined `window` and route through the storage path.
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
    value: {
      localStorage: memoryStorage,
      // CustomEvent dispatch is best-effort in `setLocalSetting`; no-op
      // here so the helper doesn't throw and we can still assert on the
      // localStorage side effect.
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    },
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
  GITHUB_REPO_URL,
  KEY_GITHUB_NUDGE_BANNER_DISMISSED,
  KEY_GITHUB_NUDGE_SIDEBAR_DISMISSED,
  KEY_GITHUB_NUDGE_STARRED,
} from "@/lib/github-nudge/constants.js";

import { readGitHubNudgeStarred, __testing } from "@/lib/github-nudge/prefs.js";

const {
  writeGitHubNudgeStarred,
  writeGitHubBannerDismissed,
  writeGitHubSidebarDismissed,
} = __testing;

// ---------------------------------------------------------------------------
// Storage key contract
// ---------------------------------------------------------------------------

describe("storage key contract", () => {
  test("starred key is namespaced under app.githubNudge.*", () => {
    expect(KEY_GITHUB_NUDGE_STARRED).toBe("app.githubNudge.starred");
  });

  test("bannerDismissed key is namespaced under app.githubNudge.*", () => {
    expect(KEY_GITHUB_NUDGE_BANNER_DISMISSED).toBe(
      "app.githubNudge.bannerDismissed",
    );
  });

  test("sidebarDismissed key is namespaced under app.githubNudge.*", () => {
    expect(KEY_GITHUB_NUDGE_SIDEBAR_DISMISSED).toBe(
      "app.githubNudge.sidebarDismissed",
    );
  });

  test("namespace is distinct from the iOS / macOS nudges so flag flips do not collide", () => {
    expect(KEY_GITHUB_NUDGE_STARRED.startsWith("app.githubNudge.")).toBe(true);
    expect(KEY_GITHUB_NUDGE_BANNER_DISMISSED.startsWith("app.githubNudge."))
      .toBe(true);
    expect(KEY_GITHUB_NUDGE_SIDEBAR_DISMISSED.startsWith("app.githubNudge."))
      .toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Constants sanity
// ---------------------------------------------------------------------------

describe("public constants", () => {
  test("GITHUB_REPO_URL points at the open-source repo", () => {
    expect(GITHUB_REPO_URL).toBe(
      "https://github.com/vellum-ai/vellum-assistant",
    );
  });
});

// ---------------------------------------------------------------------------
// Public readers / writers: starred
// ---------------------------------------------------------------------------

describe("readGitHubNudgeStarred / writeGitHubNudgeStarred", () => {
  test("returns false by default", () => {
    expect(readGitHubNudgeStarred()).toBe(false);
  });

  test("returns true after write", () => {
    writeGitHubNudgeStarred();
    expect(readGitHubNudgeStarred()).toBe(true);
  });

  test("writes to the correct localStorage key", () => {
    writeGitHubNudgeStarred();
    expect(memoryStorage.getItem(KEY_GITHUB_NUDGE_STARRED)).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// Public readers / writers: banner dismissed
// ---------------------------------------------------------------------------

describe("writeGitHubBannerDismissed", () => {
  test("writes to the correct localStorage key", () => {
    writeGitHubBannerDismissed();
    expect(memoryStorage.getItem(KEY_GITHUB_NUDGE_BANNER_DISMISSED)).toBe(
      "true",
    );
  });

  test("does not flip starred or sidebarDismissed", () => {
    writeGitHubBannerDismissed();
    expect(memoryStorage.getItem(KEY_GITHUB_NUDGE_STARRED)).toBeNull();
    expect(memoryStorage.getItem(KEY_GITHUB_NUDGE_SIDEBAR_DISMISSED)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Public readers / writers: sidebar dismissed
// ---------------------------------------------------------------------------

describe("writeGitHubSidebarDismissed", () => {
  test("writes to the correct localStorage key", () => {
    writeGitHubSidebarDismissed();
    expect(memoryStorage.getItem(KEY_GITHUB_NUDGE_SIDEBAR_DISMISSED)).toBe(
      "true",
    );
  });

  test("does not flip starred or bannerDismissed", () => {
    writeGitHubSidebarDismissed();
    expect(memoryStorage.getItem(KEY_GITHUB_NUDGE_STARRED)).toBeNull();
    expect(memoryStorage.getItem(KEY_GITHUB_NUDGE_BANNER_DISMISSED)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Three flags are independent — no shared write side effects
// ---------------------------------------------------------------------------

describe("flag independence", () => {
  test("starring does not dismiss the banner or sidebar flags", () => {
    writeGitHubNudgeStarred();
    expect(memoryStorage.getItem(KEY_GITHUB_NUDGE_BANNER_DISMISSED)).toBeNull();
    expect(memoryStorage.getItem(KEY_GITHUB_NUDGE_SIDEBAR_DISMISSED)).toBeNull();
  });

  test("all three flags can be set independently", () => {
    writeGitHubNudgeStarred();
    writeGitHubBannerDismissed();
    writeGitHubSidebarDismissed();
    expect(memoryStorage.getItem(KEY_GITHUB_NUDGE_STARRED)).toBe("true");
    expect(memoryStorage.getItem(KEY_GITHUB_NUDGE_BANNER_DISMISSED)).toBe(
      "true",
    );
    expect(memoryStorage.getItem(KEY_GITHUB_NUDGE_SIDEBAR_DISMISSED)).toBe(
      "true",
    );
  });
});
