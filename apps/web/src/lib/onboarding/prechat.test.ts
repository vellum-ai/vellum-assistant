import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import {
  clearPendingPreChatContext,
  consumePendingPreChatContext,
  normalizePreChatOnboardingContext,
  preChatOnboardingProfileFields,
  type PreChatOnboardingContext,
  setPendingPreChatContext,
  STORAGE_KEY,
} from "@/lib/onboarding/prechat.js";

/**
 * In-memory `Storage` shim mirroring the pattern in
 * `web/src/app/(app)/assistant/onboarding/privacy/PrivacyScreen.test.tsx:146-167`.
 * The bun test runner has no `jsdom`, so `sessionStorage` doesn't exist
 * out of the box. We install the shim on `globalThis.sessionStorage` —
 * `prechat.ts`'s `getSessionStorage` reads from `globalThis` directly,
 * so we deliberately avoid touching `globalThis.window`. Fabricating a
 * `window` here leaks across bun-test files and broke heyapi-client
 * URL construction in unrelated suites (`new Request("/v1/...")`).
 */
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
    const keys = Array.from(this.store.keys());
    return index >= 0 && index < keys.length ? keys[index]! : null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

/**
 * Throwing `Storage` shim used to verify `setPendingPreChatContext`
 * swallows quota / disabled-storage failures. `removeItem` is inherited
 * from `MemoryStorage` and works normally — exercises the path where a
 * failing write still successfully clears any prior value.
 */
class ThrowingSetItemStorage extends MemoryStorage {
  override setItem(_key: string, _value: string): void {
    throw new Error("QuotaExceededError");
  }
}

// Bun-test shares `globalThis` across test files. We install the
// `sessionStorage` shim on `globalThis.sessionStorage` ONLY — never on
// `globalThis.window`. Touching `window` here previously poisoned other
// suites whose code paths construct `new Request("/v1/...")`, because
// the heyapi client's URL construction depends on the absence of a
// fabricated `window` to fall back to its own base-URL resolution.
function installStorage(storage: Storage): void {
  (globalThis as { sessionStorage?: Storage }).sessionStorage = storage;
}

function uninstallStorage(): void {
  delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
}

describe("prechat onboarding handoff", () => {
  beforeEach(() => {
    uninstallStorage();
    installStorage(new MemoryStorage());
  });

  // Tear down sessionStorage when the suite ends so a later test file
  // running in the same `bun test` invocation isn't confused by a stale
  // `globalThis.sessionStorage` reference. We deliberately leave
  // `globalThis.window` alone — see the comment on `installStorage`.
  afterAll(() => {
    uninstallStorage();
  });

  test("round-trip set then consume returns the same object", () => {
    const ctx: PreChatOnboardingContext = {
      tools: ["slack", "linear", "figma"],
      tasks: ["code-building", "writing"],
      tone: "casual",
      userName: "Ada",
      assistantName: "Vellum",
    };

    setPendingPreChatContext(ctx);
    expect(consumePendingPreChatContext()).toEqual(ctx);
  });

  test("consume after a successful consume returns null (consume-once)", () => {
    const ctx: PreChatOnboardingContext = {
      tools: [],
      tasks: [],
      tone: "balanced",
    };

    setPendingPreChatContext(ctx);
    expect(consumePendingPreChatContext()).toEqual(ctx);
    // Second call must not replay the personalization.
    expect(consumePendingPreChatContext()).toBeNull();
  });

  test("consume on empty storage returns null", () => {
    expect(consumePendingPreChatContext()).toBeNull();
    // Idempotent — repeated calls on the empty path stay null.
    expect(consumePendingPreChatContext()).toBeNull();
  });

  test("consume on malformed JSON returns null", () => {
    // Reach into the underlying storage to plant garbage.
    (globalThis as { sessionStorage: Storage }).sessionStorage.setItem(
      STORAGE_KEY,
      "{not valid json",
    );
    expect(consumePendingPreChatContext()).toBeNull();
    // The malformed key is cleared on read so subsequent calls don't
    // re-trip the parse error.
    expect(consumePendingPreChatContext()).toBeNull();
  });

  test("consume on object missing required fields returns null", () => {
    // `tone` is omitted — the validator must reject this even though the
    // JSON itself is well-formed.
    (globalThis as { sessionStorage: Storage }).sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ tools: ["slack"], tasks: ["writing"] }),
    );
    expect(consumePendingPreChatContext()).toBeNull();
  });

  test("clearPendingPreChatContext removes a previously-set context", () => {
    const ctx: PreChatOnboardingContext = {
      tools: ["slack"],
      tasks: ["writing"],
      tone: "professional",
    };

    setPendingPreChatContext(ctx);
    clearPendingPreChatContext();
    expect(consumePendingPreChatContext()).toBeNull();
  });

  test("setPendingPreChatContext swallows errors when sessionStorage throws on setItem", () => {
    installStorage(new ThrowingSetItemStorage());

    expect(() =>
      setPendingPreChatContext({
        tools: [],
        tasks: [],
        tone: "casual",
      }),
    ).not.toThrow();
  });

  // ---- Google Connect Scan: new optional fields ----

  test("round-trip with googleConnected and googleScopes fields", () => {
    const ctx: PreChatOnboardingContext = {
      tools: ["gmail"],
      tasks: ["writing"],
      tone: "warm",
      googleConnected: true,
      googleScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    };
    setPendingPreChatContext(ctx);
    expect(consumePendingPreChatContext()).toEqual(ctx);
  });

  test("backward compat: payloads without new fields still validate", () => {
    const ctx: PreChatOnboardingContext = {
      tools: ["slack"],
      tasks: ["code-building"],
      tone: "grounded",
    };
    setPendingPreChatContext(ctx);
    const result = consumePendingPreChatContext();
    expect(result).toEqual(ctx);
    expect(result?.googleConnected).toBeUndefined();
    expect(result?.googleScopes).toBeUndefined();
  });

  test("consume rejects googleConnected with non-boolean type", () => {
    (globalThis as { sessionStorage: Storage }).sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tools: [],
        tasks: [],
        tone: "grounded",
        googleConnected: "yes",
      }),
    );
    expect(consumePendingPreChatContext()).toBeNull();
  });

  test("consume rejects googleScopes containing non-string entries", () => {
    (globalThis as { sessionStorage: Storage }).sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tools: [],
        tasks: [],
        tone: "grounded",
        googleScopes: [42],
      }),
    );
    expect(consumePendingPreChatContext()).toBeNull();
  });

  test("setPendingPreChatContext clears any stale context when the new write fails", () => {
    // Codex P2 regression guard: if a user already has a pending context
    // and a subsequent `setPendingPreChatContext` call hits a `setItem`
    // failure (quota exceeded, private-mode write block), the stale
    // value must NOT linger — `consumePendingPreChatContext` should
    // return `null` rather than replay the prior payload.
    const stale: PreChatOnboardingContext = {
      tools: ["slack"],
      tasks: ["writing"],
      tone: "casual",
      userName: "Stale",
      assistantName: "Old",
    };

    // Use a MemoryStorage so the initial seeding write succeeds, then
    // patch `setItem` in place to throw on the *next* call (the one
    // under test). `removeItem` continues to work, modeling a real
    // browser where a `setItem` quota-exceeded throw doesn't poison
    // sibling operations on the same storage object.
    const storage = new MemoryStorage();
    installStorage(storage);
    setPendingPreChatContext(stale);
    expect(storage.getItem(STORAGE_KEY)).not.toBeNull();

    storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };

    expect(() =>
      setPendingPreChatContext({
        tools: ["linear"],
        tasks: ["code-building"],
        tone: "balanced",
      }),
    ).not.toThrow();

    // The pre-write `removeItem` cleared the old value, the failing
    // `setItem` did NOT install the new one, and the caller never sees
    // a stale replay.
    expect(consumePendingPreChatContext()).toBeNull();
  });
});

describe("prechat onboarding normalization", () => {
  test("maps tool and task IDs to the daemon display labels", () => {
    expect(
      normalizePreChatOnboardingContext({
        tools: ["github", "google-calendar", "custom-tool"],
        tasks: ["code-building", "personal", "custom-task"],
        tone: "balanced",
        userName: "Ada",
        assistantName: "Vel",
      }),
    ).toEqual({
      tools: ["GitHub", "Google Calendar", "Custom-tool"],
      tasks: ["builds code, apps, or tools", "handles life admin", "custom-task"],
      tone: "balanced",
      userName: "Ada",
      assistantName: "Vel",
    });
  });

  test("builds profile fields with trimmed preferred name", () => {
    expect(
      preChatOnboardingProfileFields({
        tools: ["slack", "linear"],
        tasks: ["writing"],
        tone: "warm",
        userName: "  Alex  ",
      }),
    ).toEqual({
      preferredName: "Alex",
      commonWork: ["writes docs, emails, or content"],
      dailyTools: ["Slack", "Linear"],
    });
  });

  test("normalizePreChatOnboardingContext passes through googleConnected and googleScopes", () => {
    const ctx: PreChatOnboardingContext = {
      tools: ["gmail"],
      tasks: ["writing"],
      tone: "warm",
      googleConnected: true,
      googleScopes: ["https://mail.google.com/"],
    };
    expect(normalizePreChatOnboardingContext(ctx)).toMatchObject({
      googleConnected: true,
      googleScopes: ["https://mail.google.com/"],
    });
  });
});
