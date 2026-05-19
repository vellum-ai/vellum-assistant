/**
 * Tests for the billing-portal session helpers.
 *
 * The bun test runner has no jsdom; we install in-memory `sessionStorage`
 * shims directly on `globalThis`, mirroring the pattern in
 * `web/src/lib/onboarding/prechat.test.ts`.
 *
 * The hook itself wires `useMutation`, `useQueryClient`, and `useEffect`,
 * none of which run cleanly outside a React renderer. To keep this file
 * renderer-free (and avoid a process-wide `mock.module("react", ...)`
 * that leaks into other test files in the bun suite), the mutation
 * config is exposed via a separate factory `buildBillingPortalSession-
 * MutationConfig` that we drive directly. The listener-registration
 * contract is covered by a source-level guard at the bottom of this
 * file, mirroring the existing pattern.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// sessionStorage shim — installed on globalThis only (never window) so we
// don't leak a fabricated window across bun-test files.
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

class ThrowingStorage extends MemoryStorage {
  override setItem(_key: string, _value: string): void {
    throw new Error("QuotaExceededError");
  }
  override getItem(_key: string): string | null {
    throw new Error("StorageDisabled");
  }
  override removeItem(_key: string): void {
    throw new Error("StorageDisabled");
  }
}

class WriteOnlyThrowingStorage extends MemoryStorage {
  // setItem throws but removeItem + getItem still work — used to assert
  // that a failed write still clears stale data via the pre-write
  // removeItem call. `seed` lets the test pre-populate without going
  // through the throwing setItem.
  seed(key: string, value: string): void {
    super.setItem(key, value);
  }
  override setItem(_key: string, _value: string): void {
    throw new Error("QuotaExceededError");
  }
}

function installStorage(storage: Storage): void {
  (globalThis as { sessionStorage?: Storage }).sessionStorage = storage;
}

function uninstallStorage(): void {
  delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
}

// ---------------------------------------------------------------------------
// Module mocks — registered before the subject is imported.
// ---------------------------------------------------------------------------

// Use the REAL `@/clients/platform/@tanstack/react-query.gen` module —
// `buildBillingPortalSessionMutationConfig` spreads its options into the
// returned config but never invokes the `mutationFn`, so no network
// happens. Avoiding `mock.module` here is intentional: bun-test's module
// mocks are process-wide and leak into other test files in the suite.

const openUrlMock = mock(async (..._args: unknown[]) => {});

mock.module("@/lib/browser.js", () => ({
  openUrl: openUrlMock,
  openUrlFinishedListener: () => () => {},
}));

const toastErrorMock = mock((..._args: unknown[]) => {});

mock.module("@/components/app/core/Toast", () => ({
  toast: {
    error: toastErrorMock,
    info: () => {},
    success: () => {},
    warning: () => {},
  },
}));

// ---------------------------------------------------------------------------
// Subject (imported AFTER mocks).
// ---------------------------------------------------------------------------

import {
  buildBillingPortalSessionMutationConfig,
  buildPortalReturnSnapshot,
  clearPortalReturnSnapshot,
  formatGraceDate,
  PORTAL_RETURN_SNAPSHOT_KEY,
  type PortalReturnSnapshot,
  readPortalReturnSnapshot,
  writePortalReturnSnapshot,
} from "@/lib/billing/use-billing-portal-session.js";

const SNAPSHOT: PortalReturnSnapshot = {
  cancel_at_period_end: false,
  cancel_at: null,
  plan_id: "pro",
};

beforeEach(() => {
  uninstallStorage();
  installStorage(new MemoryStorage());
  openUrlMock.mockClear();
  toastErrorMock.mockClear();
});

afterAll(() => {
  uninstallStorage();
});

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

describe("portal return snapshot helpers", () => {
  test("write + read round-trips the snapshot", () => {
    writePortalReturnSnapshot(SNAPSHOT);
    expect(readPortalReturnSnapshot()).toEqual(SNAPSHOT);
  });

  test("uses the documented sessionStorage key", () => {
    writePortalReturnSnapshot(SNAPSHOT);
    const raw = (globalThis as { sessionStorage: Storage }).sessionStorage.getItem(
      PORTAL_RETURN_SNAPSHOT_KEY,
    );
    expect(raw).toBe(JSON.stringify(SNAPSHOT));
  });

  test("clear removes a previously-written snapshot", () => {
    writePortalReturnSnapshot(SNAPSHOT);
    clearPortalReturnSnapshot();
    expect(readPortalReturnSnapshot()).toBeNull();
  });

  test("read returns null when no snapshot is present", () => {
    expect(readPortalReturnSnapshot()).toBeNull();
  });

  test("read returns null on malformed JSON", () => {
    (globalThis as { sessionStorage: Storage }).sessionStorage.setItem(
      PORTAL_RETURN_SNAPSHOT_KEY,
      "{not valid json",
    );
    expect(readPortalReturnSnapshot()).toBeNull();
  });

  test("read returns null when required fields are missing", () => {
    (globalThis as { sessionStorage: Storage }).sessionStorage.setItem(
      PORTAL_RETURN_SNAPSHOT_KEY,
      JSON.stringify({ plan_id: "pro" }),
    );
    expect(readPortalReturnSnapshot()).toBeNull();
  });

  test("read returns null when cancel_at_period_end is the wrong type", () => {
    (globalThis as { sessionStorage: Storage }).sessionStorage.setItem(
      PORTAL_RETURN_SNAPSHOT_KEY,
      JSON.stringify({ cancel_at_period_end: "yes", plan_id: "pro" }),
    );
    expect(readPortalReturnSnapshot()).toBeNull();
  });

  test("read normalizes a missing cancel_at to null", () => {
    (globalThis as { sessionStorage: Storage }).sessionStorage.setItem(
      PORTAL_RETURN_SNAPSHOT_KEY,
      JSON.stringify({ cancel_at_period_end: false, plan_id: "pro" }),
    );
    expect(readPortalReturnSnapshot()).toEqual({
      cancel_at_period_end: false,
      cancel_at: null,
      plan_id: "pro",
    });
  });

  test("write swallows sessionStorage errors", () => {
    installStorage(new ThrowingStorage());
    expect(() => writePortalReturnSnapshot(SNAPSHOT)).not.toThrow();
  });

  test("write clears stale snapshot before setItem so a failed write degrades to no snapshot", () => {
    const storage = new WriteOnlyThrowingStorage();
    installStorage(storage);
    storage.seed(
      PORTAL_RETURN_SNAPSHOT_KEY,
      JSON.stringify({ cancel_at_period_end: true, cancel_at: null, plan_id: "stale" }),
    );

    // The throwing setItem will fire AFTER the removeItem clears the stale
    // snapshot, so the storage should end up empty rather than holding the
    // stale value — the return-handler will fall back to the generic toast
    // instead of showing the wrong contextual one.
    expect(() => writePortalReturnSnapshot(SNAPSHOT)).not.toThrow();
    expect(storage.getItem(PORTAL_RETURN_SNAPSHOT_KEY)).toBeNull();
  });

  test("read swallows sessionStorage errors and returns null", () => {
    installStorage(new ThrowingStorage());
    expect(readPortalReturnSnapshot()).toBeNull();
  });

  test("clear swallows sessionStorage errors", () => {
    installStorage(new ThrowingStorage());
    expect(() => clearPortalReturnSnapshot()).not.toThrow();
  });

  test("read returns null when sessionStorage is unavailable (SSR-style)", () => {
    uninstallStorage();
    expect(readPortalReturnSnapshot()).toBeNull();
  });

  test("write does not throw when sessionStorage is unavailable", () => {
    uninstallStorage();
    expect(() => writePortalReturnSnapshot(SNAPSHOT)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// formatGraceDate
// ---------------------------------------------------------------------------

describe("formatGraceDate", () => {
  test("formats a valid ISO timestamp with month + year present", () => {
    const formatted = formatGraceDate("2026-06-15T12:00:00Z");
    expect(formatted).toContain("2026");
  });

  test("falls back to the raw string for an unparseable input", () => {
    expect(formatGraceDate("not a date")).toBe("not a date");
  });
});

// ---------------------------------------------------------------------------
// buildPortalReturnSnapshot
// ---------------------------------------------------------------------------

describe("buildPortalReturnSnapshot", () => {
  test("returns null when subscription data is undefined (loading)", () => {
    expect(buildPortalReturnSnapshot(undefined)).toBeNull();
  });

  test("projects the three pinned fields off the subscription payload", () => {
    expect(
      buildPortalReturnSnapshot({
        cancel_at_period_end: true,
        cancel_at: "2026-06-15T00:00:00Z",
        plan_id: "pro",
      }),
    ).toEqual({
      cancel_at_period_end: true,
      cancel_at: "2026-06-15T00:00:00Z",
      plan_id: "pro",
    });
  });

  test("normalizes a missing/undefined cancel_at to null", () => {
    expect(
      buildPortalReturnSnapshot({
        cancel_at_period_end: false,
        cancel_at: undefined,
        plan_id: "pro",
      }),
    ).toEqual({
      cancel_at_period_end: false,
      cancel_at: null,
      plan_id: "pro",
    });
  });
});

// ---------------------------------------------------------------------------
// buildBillingPortalSessionMutationConfig — onSuccess / onError wiring
// ---------------------------------------------------------------------------

describe("buildBillingPortalSessionMutationConfig", () => {
  test("on success, writes the snapshot and redirects via openUrl", () => {
    const config = buildBillingPortalSessionMutationConfig(SNAPSHOT);

    config.onSuccess({
      portal_url: "https://billing.stripe.com/p/session/abc",
    });

    expect(readPortalReturnSnapshot()).toEqual(SNAPSHOT);
    expect(openUrlMock).toHaveBeenCalledTimes(1);
    expect(openUrlMock.mock.calls[0]?.[0]).toBe(
      "https://billing.stripe.com/p/session/abc",
    );
  });

  test("does NOT write a snapshot when caller passes null", () => {
    const config = buildBillingPortalSessionMutationConfig(null);

    config.onSuccess({
      portal_url: "https://billing.stripe.com/p/session/xyz",
    });

    expect(readPortalReturnSnapshot()).toBeNull();
    expect(openUrlMock).toHaveBeenCalledTimes(1);
    expect(openUrlMock.mock.calls[0]?.[0]).toBe(
      "https://billing.stripe.com/p/session/xyz",
    );
  });

  test("on error, fires a toast.error with the dedupe id", () => {
    const config = buildBillingPortalSessionMutationConfig(null);

    config.onError();

    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock.mock.calls[0]?.[0]).toBe(
      "Couldn't open the billing portal. Please try again.",
    );
    expect(toastErrorMock.mock.calls[0]?.[1]).toEqual({
      id: "billing-portal-session-error",
    });
  });

  test("forwards the spread mutation config from the generated factory", () => {
    const config = buildBillingPortalSessionMutationConfig(null) as {
      mutationFn?: unknown;
    };
    // The factory spreads `organizationsBillingPortalSessionCreateMutation()`
    // into the config, so its `mutationFn` must be present on the result.
    expect(config.mutationFn).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Source-level guards — keep the hook honest about its public contract.
// ---------------------------------------------------------------------------

describe("use-billing-portal-session source guards", () => {
  test("does NOT import next/navigation (must be a full-page redirect)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "use-billing-portal-session.ts"),
      "utf-8",
    );
    expect(source).not.toContain("next/navigation");
    expect(source).not.toContain("useRouter");
  });

  test("registers an openUrlFinishedListener inside a useEffect to invalidate the subscription query on Capacitor iOS portal dismissal", async () => {
    // Source-level guard: the listener wiring happens inside a React
    // `useEffect`, which can't be exercised in this bun-test file
    // without a renderer (jsdom is not installed and `mock.module` for
    // `react` would leak across test files). Verify the contract by
    // pattern-matching the source.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "use-billing-portal-session.ts"),
      "utf-8",
    );
    expect(source).toContain("openUrlFinishedListener");
    expect(source).toContain("organizationsBillingSubscriptionRetrieveOptions");
    expect(source).toContain("invalidateQueries");
    // The listener must be registered inside a useEffect so it tears
    // down on unmount via the returned cleanup. We allow either an arrow
    // body that returns the listener directly or a block body.
    expect(source).toMatch(/useEffect\(\s*\(\s*\)\s*=>\s*\{[\s\S]*?openUrlFinishedListener/);
  });

  test("uses openUrl from @/lib/browser for the redirect (Capacitor-aware)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "use-billing-portal-session.ts"),
      "utf-8",
    );
    expect(source).toContain('from "@/lib/browser.js"');
    expect(source).toContain("openUrl(data.portal_url)");
    expect(source).not.toContain("window.location.assign");
    expect(source).not.toContain("window.open");
  });
});
