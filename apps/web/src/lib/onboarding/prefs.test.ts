/**
 * Tests for onboarding/prefs.
 *
 * This codebase does not ship `@testing-library/react` or a DOM-enabled
 * bun:test runner, so we cannot `renderHook`. Instead we verify behavior by:
 *
 *  1. Asserting the exact localStorage keys each hook binds to (public
 *     contract that `/settings/privacy` relies on).
 *  2. Exercising the pure helpers the hooks compose (`readBooleanPref`,
 *     `writeBooleanPref`, `handleStorageEvent`) — these are the only
 *     non-trivial code paths in the module, so covering them covers the
 *     hooks by composition.
 *  3. Testing `readOnboardingCompleted()` directly against a mocked
 *     `localStorage`.
 *
 * The `window` mock is installed for this file only and torn down afterward
 * so we don't leak a `window` global into unrelated suites in the same bun
 * worker. The pattern mirrors
 * `web/src/lib/chat/lastViewedConversationStorage.test.ts`.
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

// Track the original descriptors so we can restore them after this file
// finishes. Other tests in the same bun worker may rely on `typeof window`
// being `undefined`, so we must not leak these globals.
const ORIGINAL_WINDOW_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  globalThis,
  "window",
);
const ORIGINAL_LOCAL_STORAGE_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
const ORIGINAL_STORAGE_EVENT_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  globalThis,
  "StorageEvent",
);

// Minimal `StorageEvent` shim for bun:test (no DOM available by default).
// We only use the `key` and `newValue` fields in the subject-under-test, so
// the shim just needs to carry those through.
class FakeStorageEvent extends Event {
  key: string | null;
  newValue: string | null;
  oldValue: string | null;
  storageArea: Storage | null;
  url: string;

  constructor(
    type: string,
    init: {
      key?: string | null;
      newValue?: string | null;
      oldValue?: string | null;
      storageArea?: Storage | null;
      url?: string;
    } = {},
  ) {
    super(type);
    this.key = init.key ?? null;
    this.newValue = init.newValue ?? null;
    this.oldValue = init.oldValue ?? null;
    this.storageArea = init.storageArea ?? null;
    this.url = init.url ?? "";
  }
}

beforeAll(() => {
  // `window` is what the module checks with `typeof window !== "undefined"`.
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: memoryStorage },
    configurable: true,
    writable: true,
  });
  // `localStorage` is a bare global in `local-settings.ts` (no `window.`
  // prefix), so mock the bare global too.
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage,
    configurable: true,
    writable: true,
  });
  // Install our `StorageEvent` shim if the runtime doesn't ship one.
  if (typeof (globalThis as { StorageEvent?: unknown }).StorageEvent !==
      "function") {
    Object.defineProperty(globalThis, "StorageEvent", {
      value: FakeStorageEvent,
      configurable: true,
      writable: true,
    });
  }
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
  if (ORIGINAL_STORAGE_EVENT_DESCRIPTOR) {
    Object.defineProperty(
      globalThis,
      "StorageEvent",
      ORIGINAL_STORAGE_EVENT_DESCRIPTOR,
    );
  } else {
    delete (globalThis as { StorageEvent?: unknown }).StorageEvent;
  }
});

beforeEach(() => {
  memoryStorage.clear();
});

afterEach(() => {
  memoryStorage.clear();
});

// ---------------------------------------------------------------------------
// Import subject AFTER window mock is installed. The module only touches
// `window` lazily inside functions, so top-level import order is not strict,
// but we keep this ordering for parity with other storage-coupled tests.
// ---------------------------------------------------------------------------

import { readOnboardingCompleted, __testing } from "@/lib/onboarding/prefs.js";

const {
  KEY_SHARE_ANALYTICS,
  KEY_SHARE_DIAGNOSTICS,
  KEY_TOS_ACCEPTED,
  KEY_AI_DATA_CONSENT,
  KEY_COMPLETED,
  readBooleanPref,
  writeBooleanPref,
  handleStorageEvent,
} = __testing;

// ---------------------------------------------------------------------------
// Key contract — these are the load-bearing strings shared with
// `/settings/privacy`. Renaming either silently breaks cross-surface sync.
// ---------------------------------------------------------------------------

describe("storage key contract", () => {
  test("share-analytics key matches /settings/privacy", () => {
    expect(KEY_SHARE_ANALYTICS).toBe("vellum_share_analytics");
  });

  test("share-diagnostics key matches /settings/privacy", () => {
    expect(KEY_SHARE_DIAGNOSTICS).toBe("vellum_share_diagnostics");
  });

  test("tosAccepted key is namespaced under onboarding.*", () => {
    expect(KEY_TOS_ACCEPTED).toBe("onboarding.tosAccepted");
  });

  test("aiDataConsent key is namespaced under onboarding.* and distinct from TOS", () => {
    // Distinct key: Apple Guideline 5.1.2(i) requires AI consent to be
    // SPECIFIC, not bundled with TOS. Sharing a key would silently bundle
    // the two acknowledgments at the storage layer.
    expect(KEY_AI_DATA_CONSENT).toBe("onboarding.aiDataConsent");
    expect(KEY_AI_DATA_CONSENT).not.toBe(KEY_TOS_ACCEPTED);
  });

  test("completed key is namespaced under onboarding.*", () => {
    expect(KEY_COMPLETED).toBe("onboarding.completed");
  });
});

// ---------------------------------------------------------------------------
// readBooleanPref — drives each hook's initial hydration.
// ---------------------------------------------------------------------------

describe("readBooleanPref", () => {
  test("returns defaultValue=true when key is absent (share prefs default to true)", () => {
    expect(readBooleanPref(KEY_SHARE_ANALYTICS, true)).toBe(true);
    expect(readBooleanPref(KEY_SHARE_DIAGNOSTICS, true)).toBe(true);
  });

  test("returns defaultValue=false when key is absent (tos/aiConsent/completed default to false)", () => {
    expect(readBooleanPref(KEY_TOS_ACCEPTED, false)).toBe(false);
    expect(readBooleanPref(KEY_AI_DATA_CONSENT, false)).toBe(false);
    expect(readBooleanPref(KEY_COMPLETED, false)).toBe(false);
  });

  test("returns true when stored value is the literal string 'true'", () => {
    memoryStorage.setItem(KEY_SHARE_ANALYTICS, "true");
    expect(readBooleanPref(KEY_SHARE_ANALYTICS, false)).toBe(true);
  });

  test("returns false when stored value is the literal string 'false'", () => {
    memoryStorage.setItem(KEY_SHARE_ANALYTICS, "false");
    expect(readBooleanPref(KEY_SHARE_ANALYTICS, true)).toBe(false);
  });

  test("falls back to defaultValue for any non-literal stored value", () => {
    memoryStorage.setItem(KEY_SHARE_ANALYTICS, "yes");
    expect(readBooleanPref(KEY_SHARE_ANALYTICS, true)).toBe(true);
    expect(readBooleanPref(KEY_SHARE_ANALYTICS, false)).toBe(false);
  });

  test("useShareAnalytics reads from 'vellum_share_analytics' specifically", () => {
    // Pre-populate the exact key the settings page writes and verify the
    // share-analytics pref sees it.
    memoryStorage.setItem("vellum_share_analytics", "false");
    expect(readBooleanPref(KEY_SHARE_ANALYTICS, true)).toBe(false);
    // And the diagnostics key is NOT cross-wired.
    expect(readBooleanPref(KEY_SHARE_DIAGNOSTICS, true)).toBe(true);
  });

  test("useShareDiagnostics reads from 'vellum_share_diagnostics' specifically", () => {
    memoryStorage.setItem("vellum_share_diagnostics", "false");
    expect(readBooleanPref(KEY_SHARE_DIAGNOSTICS, true)).toBe(false);
    expect(readBooleanPref(KEY_SHARE_ANALYTICS, true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writeBooleanPref — drives every hook's setter.
// ---------------------------------------------------------------------------

describe("writeBooleanPref", () => {
  test("setting useShareAnalytics(false) persists 'false' at 'vellum_share_analytics'", () => {
    writeBooleanPref(KEY_SHARE_ANALYTICS, false);
    expect(memoryStorage.getItem("vellum_share_analytics")).toBe("false");
  });

  test("setting useShareAnalytics(true) persists 'true' at 'vellum_share_analytics'", () => {
    writeBooleanPref(KEY_SHARE_ANALYTICS, true);
    expect(memoryStorage.getItem("vellum_share_analytics")).toBe("true");
  });

  test("setting useShareDiagnostics(false) persists 'false' at 'vellum_share_diagnostics'", () => {
    writeBooleanPref(KEY_SHARE_DIAGNOSTICS, false);
    expect(memoryStorage.getItem("vellum_share_diagnostics")).toBe("false");
  });

  test("setting useTosAccepted(true) persists 'true' at 'onboarding.tosAccepted'", () => {
    writeBooleanPref(KEY_TOS_ACCEPTED, true);
    expect(memoryStorage.getItem("onboarding.tosAccepted")).toBe("true");
  });

  test("setting useAiDataConsent(true) persists 'true' at 'onboarding.aiDataConsent' (distinct from TOS)", () => {
    writeBooleanPref(KEY_AI_DATA_CONSENT, true);
    expect(memoryStorage.getItem("onboarding.aiDataConsent")).toBe("true");
    // Cross-key independence: writing AI consent must not bleed into TOS.
    expect(memoryStorage.getItem("onboarding.tosAccepted")).toBeNull();
  });

  test("setting useOnboardingCompleted(true) persists 'true' at 'onboarding.completed'", () => {
    writeBooleanPref(KEY_COMPLETED, true);
    expect(memoryStorage.getItem("onboarding.completed")).toBe("true");
  });

  test("round-trips — write then read returns the same boolean", () => {
    writeBooleanPref(KEY_SHARE_ANALYTICS, false);
    expect(readBooleanPref(KEY_SHARE_ANALYTICS, true)).toBe(false);
    writeBooleanPref(KEY_SHARE_ANALYTICS, true);
    expect(readBooleanPref(KEY_SHARE_ANALYTICS, false)).toBe(true);
  });

  test("writes are serialized as the literal strings 'true' / 'false'", () => {
    writeBooleanPref(KEY_COMPLETED, true);
    // Not "1", not "on", not JSON — the exact string.
    expect(memoryStorage.getItem(KEY_COMPLETED)).toBe("true");
    writeBooleanPref(KEY_COMPLETED, false);
    expect(memoryStorage.getItem(KEY_COMPLETED)).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// readOnboardingCompleted — non-hook SSR-safe reader.
// ---------------------------------------------------------------------------

describe("readOnboardingCompleted", () => {
  test("returns false when the key is absent", () => {
    expect(readOnboardingCompleted()).toBe(false);
  });

  test("returns true only for the literal string 'true'", () => {
    memoryStorage.setItem(KEY_COMPLETED, "true");
    expect(readOnboardingCompleted()).toBe(true);
  });

  test("returns false for the literal string 'false'", () => {
    memoryStorage.setItem(KEY_COMPLETED, "false");
    expect(readOnboardingCompleted()).toBe(false);
  });

  test("returns false for any other non-'true' value", () => {
    memoryStorage.setItem(KEY_COMPLETED, "1");
    expect(readOnboardingCompleted()).toBe(false);
    memoryStorage.setItem(KEY_COMPLETED, "yes");
    expect(readOnboardingCompleted()).toBe(false);
    memoryStorage.setItem(KEY_COMPLETED, "");
    expect(readOnboardingCompleted()).toBe(false);
  });

  test("returns false when localStorage.getItem throws", () => {
    // Temporarily replace window with a storage that throws on getItem.
    const original = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem() {
          throw new Error("quota / disabled");
        },
      },
    };
    try {
      expect(readOnboardingCompleted()).toBe(false);
    } finally {
      (globalThis as { window?: unknown }).window = original;
    }
  });
});

// ---------------------------------------------------------------------------
// handleStorageEvent — the tab-sync logic the hooks attach via
// `window.addEventListener("storage", ...)`. Exercising this directly is
// equivalent to dispatching a `StorageEvent` against a mounted hook: the
// hook's handler is literally `handleStorageEvent(event, key, default)` +
// a `setValue` call.
// ---------------------------------------------------------------------------

describe("handleStorageEvent (tab-sync)", () => {
  test("dispatching a 'false' StorageEvent for vellum_share_analytics yields false", () => {
    const event = new StorageEvent("storage", {
      key: "vellum_share_analytics",
      newValue: "false",
    });
    expect(handleStorageEvent(event, KEY_SHARE_ANALYTICS, true)).toBe(false);
  });

  test("dispatching a 'true' StorageEvent for vellum_share_analytics yields true", () => {
    const event = new StorageEvent("storage", {
      key: "vellum_share_analytics",
      newValue: "true",
    });
    expect(handleStorageEvent(event, KEY_SHARE_ANALYTICS, false)).toBe(true);
  });

  test("StorageEvent for a different key is ignored (returns undefined)", () => {
    const event = new StorageEvent("storage", {
      key: "some_unrelated_key",
      newValue: "false",
    });
    expect(handleStorageEvent(event, KEY_SHARE_ANALYTICS, true)).toBeUndefined();
  });

  test("StorageEvent with null newValue (key cleared) falls back to defaultValue", () => {
    const event = new StorageEvent("storage", {
      key: "vellum_share_analytics",
      newValue: null,
    });
    expect(handleStorageEvent(event, KEY_SHARE_ANALYTICS, true)).toBe(true);
    expect(handleStorageEvent(event, KEY_SHARE_ANALYTICS, false)).toBe(false);
  });

  test("StorageEvent with garbage newValue falls back to defaultValue", () => {
    const event = new StorageEvent("storage", {
      key: "vellum_share_diagnostics",
      newValue: "nope",
    });
    expect(handleStorageEvent(event, KEY_SHARE_DIAGNOSTICS, true)).toBe(true);
  });

  test("targets onboarding.tosAccepted independently", () => {
    const event = new StorageEvent("storage", {
      key: "onboarding.tosAccepted",
      newValue: "true",
    });
    expect(handleStorageEvent(event, KEY_TOS_ACCEPTED, false)).toBe(true);
    // Not routed to share-analytics listener:
    expect(
      handleStorageEvent(event, KEY_SHARE_ANALYTICS, true),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Public API shape — importable via @/lib/onboarding/prefs.
// ---------------------------------------------------------------------------

describe("public API", () => {
  test("hook functions are exported", async () => {
    const mod = await import("./prefs");
    expect(typeof mod.useShareAnalytics).toBe("function");
    expect(typeof mod.useShareDiagnostics).toBe("function");
    expect(typeof mod.useTosAccepted).toBe("function");
    expect(typeof mod.useAiDataConsent).toBe("function");
    expect(typeof mod.useOnboardingCompleted).toBe("function");
    expect(typeof mod.readOnboardingCompleted).toBe("function");
    expect(typeof mod.readTosAccepted).toBe("function");
    expect(typeof mod.readAiDataConsent).toBe("function");
    expect(typeof mod.clearOnboardingFlags).toBe("function");
    expect(typeof mod.syncOnboardingUser).toBe("function");
  });

  test("readAiDataConsent returns true only when 'onboarding.aiDataConsent' === 'true'", async () => {
    const mod = await import("./prefs");
    expect(mod.readAiDataConsent()).toBe(false);
    memoryStorage.setItem("onboarding.aiDataConsent", "true");
    expect(mod.readAiDataConsent()).toBe(true);
    memoryStorage.setItem("onboarding.aiDataConsent", "false");
    expect(mod.readAiDataConsent()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// syncOnboardingUser — reconciles onboarding flags against the signed-in user.
// ---------------------------------------------------------------------------

describe("syncOnboardingUser", () => {
  const KEY_LAST_USER_ID = "onboarding.lastUserId";
  const TOS = "onboarding.tosAccepted";
  const COMPLETED = "onboarding.completed";

  test("no-op on null userId (preserves stored id through signed-out gaps)", async () => {
    const { syncOnboardingUser } = await import("./prefs");
    memoryStorage.setItem(KEY_LAST_USER_ID, "user-a");
    memoryStorage.setItem(TOS, "true");
    memoryStorage.setItem(COMPLETED, "true");

    syncOnboardingUser(null);

    expect(memoryStorage.getItem(KEY_LAST_USER_ID)).toBe("user-a");
    expect(memoryStorage.getItem(TOS)).toBe("true");
    expect(memoryStorage.getItem(COMPLETED)).toBe("true");
  });

  test("records the current user id on fresh signed-out->signed-in load", async () => {
    const { syncOnboardingUser } = await import("./prefs");
    // Scenario: fresh app load, no prior id stored, a user signs in.
    syncOnboardingUser("user-a");
    expect(memoryStorage.getItem(KEY_LAST_USER_ID)).toBe("user-a");
  });

  test("clears stale flags when a different user signs in after signed-out gap", async () => {
    const { syncOnboardingUser } = await import("./prefs");
    // Prior session (possibly expired): user-a completed onboarding.
    memoryStorage.setItem(KEY_LAST_USER_ID, "user-a");
    memoryStorage.setItem(TOS, "true");
    memoryStorage.setItem(COMPLETED, "true");

    // user-b signs in on the same browser.
    syncOnboardingUser("user-b");

    expect(memoryStorage.getItem(KEY_LAST_USER_ID)).toBe("user-b");
    expect(memoryStorage.getItem(TOS)).toBeNull();
    expect(memoryStorage.getItem(COMPLETED)).toBeNull();
  });

  test("clears stale flags when a different user signs in on fresh load (no stored id)", async () => {
    const { syncOnboardingUser } = await import("./prefs");
    // Scenario from Codex P1: fresh app load, flags survived from a prior
    // user whose session expired / cookie was cleared. `previousUserId`
    // was null, but localStorage still has their flags.
    memoryStorage.setItem(TOS, "true");
    memoryStorage.setItem(COMPLETED, "true");

    syncOnboardingUser("user-new");

    expect(memoryStorage.getItem(KEY_LAST_USER_ID)).toBe("user-new");
    expect(memoryStorage.getItem(TOS)).toBeNull();
    expect(memoryStorage.getItem(COMPLETED)).toBeNull();
  });

  test("no-op when the same user signs back in (preserves their onboarding state)", async () => {
    const { syncOnboardingUser } = await import("./prefs");
    memoryStorage.setItem(KEY_LAST_USER_ID, "user-a");
    memoryStorage.setItem(COMPLETED, "true");

    syncOnboardingUser("user-a");

    expect(memoryStorage.getItem(KEY_LAST_USER_ID)).toBe("user-a");
    expect(memoryStorage.getItem(COMPLETED)).toBe("true");
  });

  test("swallows storage errors so a throwing localStorage can't brick auth init", async () => {
    const { syncOnboardingUser } = await import("./prefs");
    // Simulate a browser that throws on every localStorage access (disabled
    // storage / private mode / quota error). `AuthProvider.setUser` calls
    // this on every session update, so an uncaught throw would propagate
    // into auth init and could leave `isLoading` stuck.
    const originalGet = memoryStorage.getItem.bind(memoryStorage);
    memoryStorage.getItem = () => {
      throw new Error("storage disabled");
    };

    // Must not throw.
    expect(() => syncOnboardingUser("user-a")).not.toThrow();

    memoryStorage.getItem = originalGet;
  });
});

// ---------------------------------------------------------------------------
// clearOnboardingFlags — wipes flags but preserves the last-user-id so a
// same-user re-login isn't mistaken for a new user.
// ---------------------------------------------------------------------------

describe("clearOnboardingFlags", () => {
  const KEY_LAST_USER_ID = "onboarding.lastUserId";
  const TOS = "onboarding.tosAccepted";
  const AI_CONSENT = "onboarding.aiDataConsent";
  const COMPLETED = "onboarding.completed";

  test("clears onboarding flags but preserves last-user-id", async () => {
    const { clearOnboardingFlags } = await import("./prefs");
    memoryStorage.setItem(KEY_LAST_USER_ID, "user-a");
    memoryStorage.setItem(TOS, "true");
    memoryStorage.setItem(AI_CONSENT, "true");
    memoryStorage.setItem(COMPLETED, "true");
    memoryStorage.setItem("vellum_share_analytics", "false");

    clearOnboardingFlags();

    expect(memoryStorage.getItem(TOS)).toBeNull();
    expect(memoryStorage.getItem(AI_CONSENT)).toBeNull();
    expect(memoryStorage.getItem(COMPLETED)).toBeNull();
    // Last-user-id stays so a same-user re-login doesn't retrigger a clear.
    expect(memoryStorage.getItem(KEY_LAST_USER_ID)).toBe("user-a");
    // Device-level share prefs stay.
    expect(memoryStorage.getItem("vellum_share_analytics")).toBe("false");
  });

  test("clears AI data consent so the next onboarding requires fresh explicit consent (Apple 5.1.2(i))", async () => {
    // Regression guard: prior version of this PR forgot to add
    // `KEY_AI_DATA_CONSENT` to `clearOnboardingFlags`, leaving the box
    // pre-checked on `/onboarding/privacy` after a retire / logout.
    const { clearOnboardingFlags } = await import("./prefs");
    memoryStorage.setItem(AI_CONSENT, "true");

    clearOnboardingFlags();

    expect(memoryStorage.getItem(AI_CONSENT)).toBeNull();
  });
});
