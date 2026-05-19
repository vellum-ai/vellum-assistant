/**
 * Tests for BillingPortalReturnHandler.
 *
 * The web workspace doesn't pull in @testing-library/react, so we exercise
 * the pure helpers (`pickPortalReturnToast`, snapshot read/clear) and the
 * effect-driven flow indirectly by importing the module-level subject and
 * driving its surfaces with mocks (sessionStorage shim, mocked
 * react-query / next-navigation / Toast modules).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import * as realRQ from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Module mocks — registered before the subject is imported.
// ---------------------------------------------------------------------------

let searchParam: string | null = null;
const replaceMock = mock((..._args: unknown[]) => {});

mock.module("next/navigation", () => ({
  useSearchParams: () => ({
    get: (key: string) => (key === "portal_return" ? searchParam : null),
  }),
  useRouter: () => ({
    replace: replaceMock,
    push: () => {},
    back: () => {},
    prefetch: () => {},
    refresh: () => {},
  }),
}));

interface FetchedSubscription {
  cancel_at_period_end: boolean;
  cancel_at: string | null;
  plan_id: string;
}

let fetchQueue: FetchedSubscription[] = [];
const fetchQueryMock = mock(async () => {
  if (fetchQueue.length > 1) {
    return fetchQueue.shift()!;
  }
  return fetchQueue[0];
});
const invalidateQueriesMock = mock(async (..._args: unknown[]) => undefined);

mock.module("@tanstack/react-query", () => ({
  ...realRQ,
  useQueryClient: () => ({
    fetchQuery: fetchQueryMock,
    invalidateQueries: invalidateQueriesMock,
  }),
}));

const toastInfoMock = mock((..._args: unknown[]) => {});
const toastSuccessMock = mock((..._args: unknown[]) => {});

mock.module("@/components/app/core/Toast", () => ({
  toast: {
    info: toastInfoMock,
    success: toastSuccessMock,
  },
}));

// ---------------------------------------------------------------------------
// Subject (imported AFTER mocks)
// ---------------------------------------------------------------------------
import {
  clearPortalReturnSnapshot,
  PORTAL_RETURN_SNAPSHOT_KEY,
  type PortalReturnSnapshot,
  readPortalReturnSnapshot,
} from "@/lib/billing/use-billing-portal-session.js";

import {
  BillingPortalReturnHandler,
  pickPortalReturnToast,
} from "@/components/app/settings/BillingPortalReturnHandler.js";

// ---------------------------------------------------------------------------
// sessionStorage shim — bun test runs in node-style env without window.
// ---------------------------------------------------------------------------

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

const memorySessionStorage = new MemoryStorage();
// Install only on globalThis (do NOT touch `window`). Trampling
// `globalThis.window` causes downstream tests that rely on a fully populated
// window (e.g. SSR via renderToStaticMarkup, which probes
// window.location/matchMedia) to fail when this test file loads first.
// Helpers in BillingPortalReturnHandler.tsx reference the global
// `sessionStorage` directly, so this is sufficient.
(globalThis as unknown as { sessionStorage: MemoryStorage }).sessionStorage =
  memorySessionStorage;

beforeEach(() => {
  memorySessionStorage.clear();
  searchParam = null;
  fetchQueue = [];
  replaceMock.mockClear();
  fetchQueryMock.mockClear();
  invalidateQueriesMock.mockClear();
  toastInfoMock.mockClear();
  toastSuccessMock.mockClear();
});

afterEach(() => {
  memorySessionStorage.clear();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("PORTAL_RETURN_SNAPSHOT_KEY", () => {
  test("matches the contract value the writer hook will use", () => {
    // PR 3 will write to this exact key. Do not change without updating PR 3.
    expect(PORTAL_RETURN_SNAPSHOT_KEY).toBe("billing-portal-return-snapshot");
  });
});

describe("readPortalReturnSnapshot", () => {
  test("returns null when no snapshot is present", () => {
    expect(readPortalReturnSnapshot()).toBeNull();
  });

  test("returns null when the snapshot JSON is malformed", () => {
    memorySessionStorage.setItem(PORTAL_RETURN_SNAPSHOT_KEY, "{not json");
    expect(readPortalReturnSnapshot()).toBeNull();
  });

  test("returns null when required fields are missing", () => {
    memorySessionStorage.setItem(
      PORTAL_RETURN_SNAPSHOT_KEY,
      JSON.stringify({ plan_id: "pro" }),
    );
    expect(readPortalReturnSnapshot()).toBeNull();
  });

  test("returns the parsed snapshot when valid", () => {
    const snapshot: PortalReturnSnapshot = {
      cancel_at_period_end: true,
      cancel_at: "2026-06-01T12:00:00Z",
      plan_id: "pro",
    };
    memorySessionStorage.setItem(
      PORTAL_RETURN_SNAPSHOT_KEY,
      JSON.stringify(snapshot),
    );
    expect(readPortalReturnSnapshot()).toEqual(snapshot);
  });
});

describe("clearPortalReturnSnapshot", () => {
  test("removes the snapshot from sessionStorage", () => {
    memorySessionStorage.setItem(
      PORTAL_RETURN_SNAPSHOT_KEY,
      JSON.stringify({
        cancel_at_period_end: false,
        cancel_at: null,
        plan_id: "pro",
      }),
    );
    clearPortalReturnSnapshot();
    expect(memorySessionStorage.getItem(PORTAL_RETURN_SNAPSHOT_KEY)).toBeNull();
  });
});

describe("pickPortalReturnToast", () => {
  test("returns generic info copy when snapshot is null", () => {
    expect(
      pickPortalReturnToast(null, {
        cancel_at_period_end: false,
        cancel_at: null,
      }),
    ).toEqual({ kind: "info", message: "Subscription updated." });
  });

  test("returns cancel-with-grace-date copy on a false → true diff", () => {
    const result = pickPortalReturnToast(
      { cancel_at_period_end: false, cancel_at: null, plan_id: "pro" },
      {
        cancel_at_period_end: true,
        cancel_at: "2026-06-15T12:00:00Z",
      },
    );
    expect(result.kind).toBe("info");
    expect(result.message.startsWith("Pro plan canceled.")).toBe(true);
    // Locale-stable: must contain the year, even if month name varies.
    expect(result.message).toContain("2026");
  });

  test("returns cancel-with-fallback-phrase when current.cancel_at is null", () => {
    const result = pickPortalReturnToast(
      { cancel_at_period_end: false, cancel_at: null, plan_id: "pro" },
      { cancel_at_period_end: true, cancel_at: null },
    );
    expect(result).toEqual({
      kind: "info",
      message: "Pro plan canceled. You'll have access until the end of your billing period.",
    });
  });

  test("returns success copy on a true → false diff", () => {
    const result = pickPortalReturnToast(
      { cancel_at_period_end: true, cancel_at: "2026-06-01T12:00:00Z", plan_id: "pro" },
      { cancel_at_period_end: false, cancel_at: null },
    );
    expect(result).toEqual({ kind: "success", message: "Pro plan reactivated." });
  });

  test("returns generic info copy when no diff is observed", () => {
    expect(
      pickPortalReturnToast(
        { cancel_at_period_end: false, cancel_at: null, plan_id: "pro" },
        { cancel_at_period_end: false, cancel_at: null },
      ),
    ).toEqual({ kind: "info", message: "Subscription updated." });
  });
});

// ---------------------------------------------------------------------------
// Effect-driven flow — drive the component's useEffect by rendering it on
// the server. `useEffect` does not fire during SSR, so we instead exercise
// the same effect body by reading the module's exports + driving the
// underlying primitives directly.
//
// Because we can't render the React tree to DOM here, we assert the
// component's contract surface (exported symbols + the toast/router/query
// integrations) instead of the lifecycle. The integration shape is covered
// by source-pinning so regressions surface in review.
// ---------------------------------------------------------------------------

describe("BillingPortalReturnHandler — exported surface", () => {
  test("exports a function component", () => {
    expect(typeof BillingPortalReturnHandler).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Source-pinning — guard the wiring that the unit tests above can't reach
// without a DOM. These pin the load-bearing strings and shape so a future
// refactor can't silently break the portal-return flow.
// ---------------------------------------------------------------------------

describe("BillingPortalReturnHandler — source pinning", () => {
  let source = "";

  beforeEach(async () => {
    if (source) return;
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    source = await fs.readFile(
      path.join(import.meta.dir, "BillingPortalReturnHandler.tsx"),
      "utf-8",
    );
  });

  test("guards against React Strict Mode double-mount via per-effect unmountedRef", () => {
    // Strict Mode runs the effect twice in dev: the first run's cleanup flips
    // this tracker so the first IIFE bails; the second run starts fresh and
    // completes. We deliberately do NOT use a useRef-based handled flag — that
    // dual-guard pattern silently no-ops in Strict Mode because the second run
    // sees the flag already set and bails while the first run's polling has
    // already been cancelled by cleanup.
    expect(source).toContain("const unmountedRef = { current: false }");
    expect(source).toContain("unmountedRef.current = true");
    expect(source).not.toContain("handledRef");
  });

  test("only fires when ?portal_return=true is present", () => {
    expect(source).toContain('searchParams.get("portal_return") !== "true"');
  });

  test("uses a stable toast id to dedupe", () => {
    expect(source).toContain('TOAST_ID = "billing-portal-return"');
    expect(source).toContain("{ id: TOAST_ID }");
  });

  test("polls via fetchQuery + invalidateQueries against the subscription key", () => {
    expect(source).toContain("organizationsBillingSubscriptionRetrieveOptions");
    expect(source).toContain("organizationsBillingSubscriptionRetrieveQueryKey");
    expect(source).toContain("queryClient.invalidateQueries");
    expect(source).toContain("queryClient.fetchQuery");
  });

  test("clears the snapshot and replaces the URL after firing", () => {
    expect(source).toContain("clearPortalReturnSnapshot()");
    expect(source).toContain("router.replace(routes.settings.billing)");
  });

  test("falls back to a generic toast when polling throws", () => {
    expect(source).toContain('toast.info("Subscription updated."');
  });
});
