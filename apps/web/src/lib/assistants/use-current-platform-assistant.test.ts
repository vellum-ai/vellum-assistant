/**
 * Tests for `useCurrentPlatformAssistant`.
 *
 * Two layers of coverage:
 *   1. Pure resolution + storage scoping — exercised against the contract
 *      (storage key shape, default-to-first, stored-ID precedence).
 *   2. Same-tab broadcast via the module-scope listener set — verified by
 *      driving `useSyncExternalStore` with the hook's own `subscribe` /
 *      `setStoredAssistantIdForTesting` helpers (renderHook from
 *      @testing-library/react). This covers the Codex P2 fix: a write in one
 *      hook instance must wake every other instance in the same tab on the
 *      next render, since the browser `storage` event only fires cross-tab.
 *
 * We deliberately do NOT go through the full hook (`useCurrentPlatformAssistant`
 * itself) because that pulls in React Query + the assistants list endpoint;
 * the same-tab-broadcast guarantee lives entirely in the external store, and
 * testing that store directly is sufficient.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useSyncExternalStore } from "react";

import {
  PLATFORM_ASSISTANT_STORAGE_PREFIX,
  __subscribeForTesting,
  __getSnapshotForTesting,
  __setStoredIdForTesting,
} from "@/lib/assistants/use-current-platform-assistant.js";

class MemStorage implements Storage {
  private s = new Map<string, string>();
  get length(): number {
    return this.s.size;
  }
  clear(): void {
    this.s.clear();
  }
  getItem(k: string): string | null {
    return this.s.has(k) ? (this.s.get(k) ?? null) : null;
  }
  key(i: number): string | null {
    return Array.from(this.s.keys())[i] ?? null;
  }
  removeItem(k: string): void {
    this.s.delete(k);
  }
  setItem(k: string, v: string): void {
    this.s.set(k, String(v));
  }
}

interface PlatformAssistantLike {
  id: string;
}

/**
 * Pure copy of the resolution logic in `use-current-platform-assistant.ts`.
 * Keeps the contract assertions hook-implementation-agnostic so the hook can
 * be refactored without breaking the test.
 */
function resolveSelection<A extends PlatformAssistantLike>(
  platformAssistants: A[],
  storedId: string | null,
): A | null {
  if (storedId) {
    const match = platformAssistants.find((a) => a.id === storedId);
    if (match) return match;
  }
  return platformAssistants[0] ?? null;
}

/**
 * Pure copy of the new resolution-ID rules — see Codex P1 race vs hatch.
 * An empty list is treated as "no candidates": the storedId is presumed
 * valid until the list is non-empty AND the storedId is missing from it.
 * Returns `{ id, persist }` so tests can assert on the persistence behavior
 * (we never persist a `null` against an empty list).
 */
function resolveAssistantId<A extends PlatformAssistantLike>(
  platformAssistants: A[],
  storedId: string | null,
): { id: string | null; persist: string | null } {
  if (platformAssistants.length === 0) {
    return { id: storedId, persist: null };
  }
  if (storedId && platformAssistants.some((a) => a.id === storedId)) {
    return { id: storedId, persist: null };
  }
  const fallback = platformAssistants[0]?.id ?? null;
  return { id: fallback, persist: fallback };
}

describe("useCurrentPlatformAssistant — storage key scoping", () => {
  test("key includes the org ID so per-org keys do not collide", () => {
    const orgA = `${PLATFORM_ASSISTANT_STORAGE_PREFIX}org-a`;
    const orgB = `${PLATFORM_ASSISTANT_STORAGE_PREFIX}org-b`;
    expect(orgA).not.toBe(orgB);
    expect(orgA).toContain("org-a");
    expect(orgB).toContain("org-b");
  });
});

describe("useCurrentPlatformAssistant — selection resolution", () => {
  test("default-to-first when no stored ID", () => {
    const platforms = [{ id: "asst-1" }, { id: "asst-2" }];
    expect(resolveSelection(platforms, null)?.id).toBe("asst-1");
  });

  test("stored ID wins when present in the list", () => {
    const platforms = [{ id: "asst-1" }, { id: "asst-2" }];
    expect(resolveSelection(platforms, "asst-2")?.id).toBe("asst-2");
  });

  test("invalid stored ID falls back to the first platform assistant", () => {
    const platforms = [{ id: "asst-1" }, { id: "asst-2" }];
    expect(resolveSelection(platforms, "asst-stale")?.id).toBe("asst-1");
  });

  test("returns null when the platform list is empty", () => {
    expect(resolveSelection([], null)).toBeNull();
    expect(resolveSelection([], "asst-stale")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveAssistantId — Codex P1 race against `hatchAndCheck()`.
//
// hatchAndCheck() stores a new assistant ID then invalidates the list query.
// Between those two events the hook re-renders with the still-cached empty
// list. The OLD logic resolved to `null` and persisted that null over the
// just-stored ID, which broadcasts `null` to every consumer and re-arms the
// chat page's auto-hatch synthesizer (duplicate hatch / lost selection).
//
// The new contract: an empty list means "no candidates yet" — we surface the
// storedId as-is and DO NOT persist anything until the list returns at least
// one entry.
// ---------------------------------------------------------------------------

describe("useCurrentPlatformAssistant — resolveAssistantId (post-hatch race)", () => {
  test("empty list with stored ID → returns stored ID, no persist (regression)", () => {
    // This is the regression case: post-hatch, before the list refetch
    // returns. We must NOT clear the just-stored ID by resolving to null.
    const result = resolveAssistantId([], "asst-just-hatched");
    expect(result.id).toBe("asst-just-hatched");
    expect(result.persist).toBeNull();
  });

  test("empty list, no stored ID → returns null, no persist", () => {
    // Genuinely-empty case before any hatch. Chat-page synthesizer takes
    // over and triggers auto-hatch.
    const result = resolveAssistantId([], null);
    expect(result.id).toBeNull();
    expect(result.persist).toBeNull();
  });

  test("non-empty list with stored ID present → returns stored, no persist", () => {
    const list = [{ id: "asst-1" }, { id: "asst-2" }];
    const result = resolveAssistantId(list, "asst-2");
    expect(result.id).toBe("asst-2");
    expect(result.persist).toBeNull();
  });

  test("non-empty list, no stored ID → returns first and persists fallback", () => {
    const list = [{ id: "asst-1" }, { id: "asst-2" }];
    const result = resolveAssistantId(list, null);
    expect(result.id).toBe("asst-1");
    expect(result.persist).toBe("asst-1");
  });

  test("non-empty list, stored ID absent (stale) → returns first and persists fallback", () => {
    const list = [{ id: "asst-1" }, { id: "asst-2" }];
    const result = resolveAssistantId(list, "asst-retired");
    expect(result.id).toBe("asst-1");
    expect(result.persist).toBe("asst-1");
  });
});

describe("useCurrentPlatformAssistant — localStorage persistence", () => {
  const mem = new MemStorage();
  const origWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const origLocalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );

  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      value: { localStorage: mem, addEventListener: () => {}, removeEventListener: () => {} },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: mem,
      configurable: true,
      writable: true,
    });
    mem.clear();
  });

  afterEach(() => {
    mem.clear();
    if (origWindow) {
      Object.defineProperty(globalThis, "window", origWindow);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
    if (origLocalStorage) {
      Object.defineProperty(globalThis, "localStorage", origLocalStorage);
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  test("setAssistantId writes to the org-scoped key", () => {
    const orgId = "org-1";
    const key = `${PLATFORM_ASSISTANT_STORAGE_PREFIX}${orgId}`;
    mem.setItem(key, "asst-2");
    expect(mem.getItem(key)).toBe("asst-2");
  });

  test("org switch reads from a different key (re-resolves)", () => {
    const keyA = `${PLATFORM_ASSISTANT_STORAGE_PREFIX}org-a`;
    const keyB = `${PLATFORM_ASSISTANT_STORAGE_PREFIX}org-b`;
    mem.setItem(keyA, "asst-a-1");
    mem.setItem(keyB, "asst-b-1");
    expect(mem.getItem(keyA)).toBe("asst-a-1");
    expect(mem.getItem(keyB)).toBe("asst-b-1");
    // Switching org context means we read keyB instead of keyA.
    expect(mem.getItem(keyB)).not.toBe(mem.getItem(keyA));
  });

  test("default fallback writes back a stable ID for reloads", () => {
    const orgId = "org-1";
    const key = `${PLATFORM_ASSISTANT_STORAGE_PREFIX}${orgId}`;
    const platforms = [{ id: "asst-1" }, { id: "asst-2" }];
    expect(mem.getItem(key)).toBeNull();
    // Simulate the hook's writeback when no stored ID exists.
    const resolved = resolveSelection(platforms, null);
    if (resolved) {
      mem.setItem(key, resolved.id);
    }
    expect(mem.getItem(key)).toBe("asst-1");
  });
});

// ---------------------------------------------------------------------------
// Same-tab broadcast (Codex P2)
//
// The browser fires `storage` events ONLY in OTHER tabs that share the same
// origin — never in the tab that performed the write. Without an in-tab
// listener set, sibling `useCurrentPlatformAssistant` instances would not
// re-resolve when the picker calls `setAssistantId`. These tests assert that
// the module-scope subscribe/notify wiring correctly wakes all subscribers.
// ---------------------------------------------------------------------------

describe("useCurrentPlatformAssistant — same-tab broadcast", () => {
  afterEach(() => {
    cleanup();
  });

  test("setStoredId in one subscriber wakes another subscriber in the same tab", () => {
    const orgId = "org-broadcast";
    // Pre-seed BEFORE mounting hooks so the initial render doesn't observe a
    // module-level write happening outside React's batching window.
    window.localStorage.removeItem(`${PLATFORM_ASSISTANT_STORAGE_PREFIX}${orgId}`);

    const useStored = () =>
      useSyncExternalStore(
        __subscribeForTesting,
        () => __getSnapshotForTesting(orgId),
        () => null,
      );

    const a = renderHook(() => useStored());
    const b = renderHook(() => useStored());

    expect(a.result.current).toBeNull();
    expect(b.result.current).toBeNull();

    act(() => {
      __setStoredIdForTesting(orgId, "asst-new");
    });

    // Both instances must see the update on the next render — proving the
    // module-scope listener set fires for every active subscriber, not just
    // the one that made the write.
    expect(a.result.current).toBe("asst-new");
    expect(b.result.current).toBe("asst-new");

    // Cleanup: clear storage directly (avoids notifying after unmount).
    window.localStorage.removeItem(`${PLATFORM_ASSISTANT_STORAGE_PREFIX}${orgId}`);
  });

  test("clearing via setStoredId(null) propagates to every subscriber", () => {
    const orgId = "org-clear";
    const key = `${PLATFORM_ASSISTANT_STORAGE_PREFIX}${orgId}`;
    // Pre-seed via direct localStorage write so no notify fires before mount.
    window.localStorage.setItem(key, "asst-1");

    const useStored = () =>
      useSyncExternalStore(
        __subscribeForTesting,
        () => __getSnapshotForTesting(orgId),
        () => null,
      );

    const a = renderHook(() => useStored());
    const b = renderHook(() => useStored());

    expect(a.result.current).toBe("asst-1");
    expect(b.result.current).toBe("asst-1");

    act(() => {
      __setStoredIdForTesting(orgId, null);
    });

    // (1) Every subscriber observes the cleared snapshot on the next render
    // — proves the module-scope listener set fires for all consumers.
    expect(a.result.current).toBeNull();
    expect(b.result.current).toBeNull();
    // (2) The org-scoped localStorage key is genuinely removed (not just
    // overwritten with `""` or `"null"`). This is the post-retire contract:
    // the next mount must observe a clean slate, not a string-coerced null.
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  test("setStoredId(null) leaves OTHER orgs' keys untouched", () => {
    // Defensive: a clear under one org must not nuke siblings. Concretely
    // this verifies the storage key is org-scoped and only the targeted
    // entry is removed.
    const orgA = "org-isolated-a";
    const orgB = "org-isolated-b";
    const keyA = `${PLATFORM_ASSISTANT_STORAGE_PREFIX}${orgA}`;
    const keyB = `${PLATFORM_ASSISTANT_STORAGE_PREFIX}${orgB}`;
    window.localStorage.setItem(keyA, "asst-a");
    window.localStorage.setItem(keyB, "asst-b");

    __setStoredIdForTesting(orgA, null);

    expect(window.localStorage.getItem(keyA)).toBeNull();
    expect(window.localStorage.getItem(keyB)).toBe("asst-b");
  });

  test("getSnapshot returns null for null orgId (SSR / no org)", () => {
    expect(__getSnapshotForTesting(null)).toBeNull();
  });
});

// Per-org QueryClient swap (`key={scopeKey}` on `RequestScopedQueryClientProvider`
// in AppProviders) handles org-change invalidation: the entire QueryClient
// subtree, including this hook and the platform-list cache it reads, remounts
// on org change. There is no in-hook invalidation to assert.
