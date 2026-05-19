/**
 * Tests for `discord-nudge/prefs`: storage key namespacing, read/write
 * helpers, prerequisite checks, and round-trip persistence for the
 * three boolean flags (`joined`, `bannerDismissed`, `sidebarDismissed`)
 * plus the `firstSeenAt` timestamp.
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
  KEY_DISCORD_NUDGE_JOINED,
  KEY_DISCORD_NUDGE_BANNER_DISMISSED,
  KEY_DISCORD_NUDGE_SIDEBAR_DISMISSED,
  KEY_DISCORD_NUDGE_FIRST_SEEN_AT,
  DISCORD_INVITE_URL,
  DISCORD_MIN_CONVERSATION_COUNT,
  DISCORD_GITHUB_DISMISS_COOLDOWN_MS,
} from "@/lib/discord-nudge/constants.js";

import {
  KEY_GITHUB_NUDGE_STARRED,
  KEY_GITHUB_NUDGE_BANNER_DISMISSED,
  KEY_GITHUB_NUDGE_SIDEBAR_DISMISSED,
  KEY_GITHUB_NUDGE_BANNER_DISMISSED_AT,
} from "@/lib/github-nudge/constants.js";

import {
  readDiscordNudgeJoined,
  ensureFirstSeenAt,
  readFirstSeenAt,
  areDiscordPrerequisitesMet,
  __testing,
} from "@/lib/discord-nudge/prefs.js";

const {
  writeDiscordNudgeJoined,
  writeDiscordBannerDismissed,
  writeDiscordSidebarDismissed,
  isGitHubNudgeResolved,
  isGitHubDismissCooldownElapsed,
} = __testing;

// ---------------------------------------------------------------------------
// Storage key contract
// ---------------------------------------------------------------------------

describe("storage key contract", () => {
  test("joined key is namespaced under app.discordNudge.*", () => {
    expect(KEY_DISCORD_NUDGE_JOINED).toBe("app.discordNudge.joined");
  });

  test("bannerDismissed key is namespaced under app.discordNudge.*", () => {
    expect(KEY_DISCORD_NUDGE_BANNER_DISMISSED).toBe(
      "app.discordNudge.bannerDismissed",
    );
  });

  test("sidebarDismissed key is namespaced under app.discordNudge.*", () => {
    expect(KEY_DISCORD_NUDGE_SIDEBAR_DISMISSED).toBe(
      "app.discordNudge.sidebarDismissed",
    );
  });

  test("firstSeenAt key is namespaced under app.discordNudge.*", () => {
    expect(KEY_DISCORD_NUDGE_FIRST_SEEN_AT).toBe(
      "app.discordNudge.firstSeenAt",
    );
  });

  test("namespace is distinct from the GitHub and macOS nudges", () => {
    expect(KEY_DISCORD_NUDGE_JOINED.startsWith("app.discordNudge.")).toBe(true);
    expect(KEY_DISCORD_NUDGE_BANNER_DISMISSED.startsWith("app.discordNudge.")).toBe(true);
    expect(KEY_DISCORD_NUDGE_SIDEBAR_DISMISSED.startsWith("app.discordNudge.")).toBe(true);
    expect(KEY_DISCORD_NUDGE_FIRST_SEEN_AT.startsWith("app.discordNudge.")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Constants sanity
// ---------------------------------------------------------------------------

describe("public constants", () => {
  test("DISCORD_INVITE_URL points at the Discord invite", () => {
    expect(DISCORD_INVITE_URL).toBe("https://discord.gg/ZABd9V2zM8");
  });

  test("DISCORD_MIN_CONVERSATION_COUNT is 2", () => {
    expect(DISCORD_MIN_CONVERSATION_COUNT).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Public readers / writers: joined
// ---------------------------------------------------------------------------

describe("readDiscordNudgeJoined / writeDiscordNudgeJoined", () => {
  test("returns false by default", () => {
    // GIVEN no localStorage values set
    // WHEN reading the joined flag
    // THEN it returns false
    expect(readDiscordNudgeJoined()).toBe(false);
  });

  test("returns true after write", () => {
    // GIVEN the joined flag is written
    writeDiscordNudgeJoined();

    // WHEN reading the joined flag
    // THEN it returns true
    expect(readDiscordNudgeJoined()).toBe(true);
  });

  test("writes to the correct localStorage key", () => {
    // GIVEN the joined flag is written
    writeDiscordNudgeJoined();

    // WHEN checking the raw localStorage value
    // THEN the correct key is set to "true"
    expect(memoryStorage.getItem(KEY_DISCORD_NUDGE_JOINED)).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// Public readers / writers: banner dismissed
// ---------------------------------------------------------------------------

describe("writeDiscordBannerDismissed", () => {
  test("writes to the correct localStorage key", () => {
    // GIVEN the banner dismissed flag is written
    writeDiscordBannerDismissed();

    // WHEN checking the raw localStorage value
    // THEN the correct key is set to "true"
    expect(memoryStorage.getItem(KEY_DISCORD_NUDGE_BANNER_DISMISSED)).toBe("true");
  });

  test("does not flip joined or sidebarDismissed", () => {
    // GIVEN the banner dismissed flag is written
    writeDiscordBannerDismissed();

    // WHEN checking unrelated keys
    // THEN they are unset
    expect(memoryStorage.getItem(KEY_DISCORD_NUDGE_JOINED)).toBeNull();
    expect(memoryStorage.getItem(KEY_DISCORD_NUDGE_SIDEBAR_DISMISSED)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Public readers / writers: sidebar dismissed
// ---------------------------------------------------------------------------

describe("writeDiscordSidebarDismissed", () => {
  test("writes to the correct localStorage key", () => {
    // GIVEN the sidebar dismissed flag is written
    writeDiscordSidebarDismissed();

    // WHEN checking the raw localStorage value
    // THEN the correct key is set to "true"
    expect(memoryStorage.getItem(KEY_DISCORD_NUDGE_SIDEBAR_DISMISSED)).toBe("true");
  });

  test("does not flip joined or bannerDismissed", () => {
    // GIVEN the sidebar dismissed flag is written
    writeDiscordSidebarDismissed();

    // WHEN checking unrelated keys
    // THEN they are unset
    expect(memoryStorage.getItem(KEY_DISCORD_NUDGE_JOINED)).toBeNull();
    expect(memoryStorage.getItem(KEY_DISCORD_NUDGE_BANNER_DISMISSED)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Flag independence
// ---------------------------------------------------------------------------

describe("flag independence", () => {
  test("all three flags can be set independently", () => {
    // GIVEN all three flags are written
    writeDiscordNudgeJoined();
    writeDiscordBannerDismissed();
    writeDiscordSidebarDismissed();

    // WHEN checking all raw localStorage values
    // THEN all are set to "true"
    expect(memoryStorage.getItem(KEY_DISCORD_NUDGE_JOINED)).toBe("true");
    expect(memoryStorage.getItem(KEY_DISCORD_NUDGE_BANNER_DISMISSED)).toBe("true");
    expect(memoryStorage.getItem(KEY_DISCORD_NUDGE_SIDEBAR_DISMISSED)).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// First-seen timestamp
// ---------------------------------------------------------------------------

describe("ensureFirstSeenAt", () => {
  test("records a timestamp on first call", () => {
    // GIVEN no firstSeenAt timestamp exists
    // WHEN we call ensureFirstSeenAt
    ensureFirstSeenAt();

    // THEN a non-zero timestamp is recorded
    expect(readFirstSeenAt()).toBeGreaterThan(0);
  });

  test("does not overwrite an existing timestamp", () => {
    // GIVEN a firstSeenAt timestamp already exists
    memoryStorage.setItem(KEY_DISCORD_NUDGE_FIRST_SEEN_AT, "1000");

    // WHEN we call ensureFirstSeenAt again
    ensureFirstSeenAt();

    // THEN the original value is preserved
    expect(readFirstSeenAt()).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Prerequisite checks: GitHub nudge resolved
// ---------------------------------------------------------------------------

describe("isGitHubNudgeResolved", () => {
  test("returns false when GitHub nudge is not resolved", () => {
    // GIVEN no GitHub nudge state set
    // WHEN checking if GitHub nudge is resolved
    // THEN it returns false
    expect(isGitHubNudgeResolved()).toBe(false);
  });

  test("returns true when user has starred", () => {
    // GIVEN the user has starred on GitHub
    memoryStorage.setItem(KEY_GITHUB_NUDGE_STARRED, "true");

    // WHEN checking if GitHub nudge is resolved
    // THEN it returns true
    expect(isGitHubNudgeResolved()).toBe(true);
  });

  test("returns true when both banner and sidebar are dismissed", () => {
    // GIVEN the user dismissed both GitHub nudge surfaces
    memoryStorage.setItem(KEY_GITHUB_NUDGE_BANNER_DISMISSED, "true");
    memoryStorage.setItem(KEY_GITHUB_NUDGE_SIDEBAR_DISMISSED, "true");

    // WHEN checking if GitHub nudge is resolved
    // THEN it returns true
    expect(isGitHubNudgeResolved()).toBe(true);
  });

  test("returns false when only banner is dismissed", () => {
    // GIVEN only the GitHub banner is dismissed
    memoryStorage.setItem(KEY_GITHUB_NUDGE_BANNER_DISMISSED, "true");

    // WHEN checking if GitHub nudge is resolved
    // THEN it returns false (sidebar still visible)
    expect(isGitHubNudgeResolved()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Prerequisite checks: GitHub dismiss cooldown
// ---------------------------------------------------------------------------

describe("isGitHubDismissCooldownElapsed", () => {
  test("returns true when no GitHub banner was ever dismissed", () => {
    // GIVEN no GitHub banner dismiss timestamp
    // WHEN checking the cooldown
    // THEN it returns true (no cooldown needed)
    expect(isGitHubDismissCooldownElapsed()).toBe(true);
  });

  test("returns false when GitHub banner was just dismissed", () => {
    // GIVEN the GitHub banner was dismissed just now
    memoryStorage.setItem(KEY_GITHUB_NUDGE_BANNER_DISMISSED_AT, String(Date.now()));

    // WHEN checking the cooldown
    // THEN it returns false (cooldown not elapsed)
    expect(isGitHubDismissCooldownElapsed()).toBe(false);
  });

  test("returns true when cooldown has elapsed", () => {
    // GIVEN the GitHub banner was dismissed longer than the cooldown period ago
    const pastTime = Date.now() - DISCORD_GITHUB_DISMISS_COOLDOWN_MS - 1000;
    memoryStorage.setItem(KEY_GITHUB_NUDGE_BANNER_DISMISSED_AT, String(pastTime));

    // WHEN checking the cooldown
    // THEN it returns true
    expect(isGitHubDismissCooldownElapsed()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Composite prerequisite check
// ---------------------------------------------------------------------------

describe("areDiscordPrerequisitesMet", () => {
  /**
   * Helper to set up a state where all prerequisites are satisfied.
   */
  function setupAllPrerequisitesMet() {
    // GitHub nudge resolved (starred)
    memoryStorage.setItem(KEY_GITHUB_NUDGE_STARRED, "true");
    // First seen timestamp exists
    memoryStorage.setItem(KEY_DISCORD_NUDGE_FIRST_SEEN_AT, String(Date.now()));
  }

  test("returns true when all prerequisites are met", () => {
    // GIVEN all prerequisites are satisfied
    setupAllPrerequisitesMet();

    // WHEN checking prerequisites
    // THEN it returns true
    expect(areDiscordPrerequisitesMet(true, 2)).toBe(true);
  });

  test("returns false when platform nudge is not resolved", () => {
    // GIVEN all other prerequisites are satisfied
    setupAllPrerequisitesMet();

    // WHEN checking with platform nudge unresolved
    // THEN it returns false
    expect(areDiscordPrerequisitesMet(false, 2)).toBe(false);
  });

  test("returns false when GitHub nudge is not resolved", () => {
    // GIVEN platform nudge is resolved but GitHub nudge is not
    memoryStorage.setItem(KEY_DISCORD_NUDGE_FIRST_SEEN_AT, String(Date.now()));

    // WHEN checking prerequisites
    // THEN it returns false
    expect(areDiscordPrerequisitesMet(true, 2)).toBe(false);
  });

  test("returns false when conversation count is below threshold", () => {
    // GIVEN all other prerequisites are satisfied
    setupAllPrerequisitesMet();

    // WHEN checking with only 1 conversation
    // THEN it returns false
    expect(areDiscordPrerequisitesMet(true, 1)).toBe(false);
  });

  test("returns false when GitHub dismiss cooldown has not elapsed", () => {
    // GIVEN all other prerequisites are satisfied
    setupAllPrerequisitesMet();

    // AND the GitHub banner was dismissed just now
    memoryStorage.setItem(KEY_GITHUB_NUDGE_BANNER_DISMISSED_AT, String(Date.now()));

    // WHEN checking prerequisites
    // THEN it returns false
    expect(areDiscordPrerequisitesMet(true, 2)).toBe(false);
  });

  test("returns true when GitHub banner was dismissed long ago", () => {
    // GIVEN all prerequisites are satisfied
    setupAllPrerequisitesMet();

    // AND the GitHub banner was dismissed longer than the cooldown period ago
    const pastTime = Date.now() - DISCORD_GITHUB_DISMISS_COOLDOWN_MS - 1000;
    memoryStorage.setItem(KEY_GITHUB_NUDGE_BANNER_DISMISSED_AT, String(pastTime));

    // WHEN checking prerequisites
    // THEN it returns true
    expect(areDiscordPrerequisitesMet(true, 2)).toBe(true);
  });
});
