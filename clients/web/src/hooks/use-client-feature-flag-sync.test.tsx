import { useLayoutEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { shouldRetryQuery } from "@/utils/query-retry";

const originalFetch = globalThis.fetch;

function jsonResponse(flags: Record<string, boolean | string>): Response {
  return new Response(JSON.stringify({ flags }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** A server evaluation of the pricing-funnel kill switch. */
function flagResponse(marketingPricingTakeover: boolean): Response {
  return jsonResponse({
    "marketing-pricing-takeover": marketingPricingTakeover,
  });
}

const fetchMock = mock(async () => jsonResponse({}));

const ANONYMOUS_SCOPE = "anonymous:org:none";
const SIGNED_IN_SCOPE = "user:user-123:org:org-abc";

// Org-header readiness drives whether the authenticated fetch may go out at
// all. Mutable so tests can hold it mid-resolution and then let it land.
let orgReadinessValue: "ready" | "resolving" | "unavailable" = "ready";
mock.module("@/hooks/use-is-org-ready", () => ({
  useOrgHeaderReadiness: () => orgReadinessValue,
  useIsOrgReady: () => orgReadinessValue === "ready",
}));

const { useClientFeatureFlagSync } =
  await import("@/hooks/use-client-feature-flag-sync");
const { useClientFeatureFlagStore } =
  await import("@/stores/client-feature-flag-store");
const { featureFlagsClientFlagValuesRetrieveQueryKey } =
  await import("@/generated/api/@tanstack/react-query.gen");

const FLAG_QUERY_KEY = featureFlagsClientFlagValuesRetrieveQueryKey();
const initialFlagState = useClientFeatureFlagStore.getState();

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

function freshQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

beforeEach(() => {
  window.__VELLUM_CONFIG__ = undefined;
  fetchMock.mockClear();
  fetchMock.mockImplementation(async () => jsonResponse({}));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  orgReadinessValue = "ready";
  useClientFeatureFlagStore.setState(initialFlagState, true);
});

afterEach(() => {
  cleanup();
  window.__VELLUM_CONFIG__ = undefined;
  orgReadinessValue = "ready";
  globalThis.fetch = originalFetch;
});

describe("useClientFeatureFlagSync", () => {
  test("fetches client flags when enabled outside remote-gateway mode", async () => {
    const queryClient = freshQueryClient();
    renderHook(() => useClientFeatureFlagSync(true), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  test("reuses client flags when the hook remounts in the same session", async () => {
    const queryClient = freshQueryClient();
    const first = renderHook(() => useClientFeatureFlagSync(true), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    first.unmount();

    renderHook(() => useClientFeatureFlagSync(true), {
      wrapper: createWrapper(queryClient),
    });
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("does not retry a rate-limited client flag request", async () => {
    const rateLimitedFetch = mock(
      async () => new Response("slow down", { status: 429 }),
    );
    globalThis.fetch = rateLimitedFetch as unknown as typeof fetch;
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: shouldRetryQuery,
          retryDelay: () => 1,
        },
      },
    });
    renderHook(() => useClientFeatureFlagSync(true), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(queryClient.getQueryState(FLAG_QUERY_KEY)?.status).toBe("error");
    });
    expect(rateLimitedFetch).toHaveBeenCalledTimes(1);
  });

  test("does not fetch platform client flags in remote-gateway mode", async () => {
    window.__VELLUM_CONFIG__ = { mode: "remote-gateway" };
    const queryClient = freshQueryClient();
    renderHook(() => useClientFeatureFlagSync(true), {
      wrapper: createWrapper(queryClient),
    });

    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("settles the store when no server values are coming", async () => {
    // Surfaces that wait for `hydrated` before acting on a default-off flag
    // would hang forever otherwise.
    window.__VELLUM_CONFIG__ = { mode: "remote-gateway" };
    const queryClient = freshQueryClient();
    renderHook(() => useClientFeatureFlagSync(true), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(useClientFeatureFlagStore.getState().hydrated).toBe(true);
    });
  });

  test("settles the store when the flag fetch fails", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("boom", { status: 500 }),
      )) as unknown as typeof fetch;
    const queryClient = freshQueryClient();
    renderHook(() => useClientFeatureFlagSync(true), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(
      () => {
        expect(useClientFeatureFlagStore.getState().hydrated).toBe(true);
      },
      { timeout: 5000 },
    );
  });

  test("keeps the values it already has when a refresh fails", async () => {
    // A failed background refresh is not evidence the feature turned off.
    // Falling back to registry defaults would switch a legitimately-enabled
    // funnel off mid-session, possibly with the user already in checkout.
    useClientFeatureFlagStore
      .getState()
      .setFlags({ marketingPricingTakeover: true }, null);
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("boom", { status: 500 }),
      )) as unknown as typeof fetch;
    const queryClient = freshQueryClient();
    renderHook(() => useClientFeatureFlagSync(true), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(
      () => {
        expect(queryClient.getQueryState(FLAG_QUERY_KEY)?.status).toBe("error");
      },
      { timeout: 5000 },
    );
    const state = useClientFeatureFlagStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.marketingPricingTakeover).toBe(true);
  });

  test("stays unsettled while the org header source is still resolving", async () => {
    // Authenticated cold load with no stored organization id: the session has
    // settled but the org store has not. Firing now sends a header-less request
    // the endpoint rejects, and settling on that failure would publish the
    // default-off registry value as the answer — bouncing a valid pricing deep
    // link to plans before the real value could ever land.
    orgReadinessValue = "resolving";
    const queryClient = freshQueryClient();
    renderHook(() => useClientFeatureFlagSync(true), {
      wrapper: createWrapper(queryClient),
    });

    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useClientFeatureFlagStore.getState().hydrated).toBe(false);
  });

  test("fetches once the org header source lands", async () => {
    orgReadinessValue = "resolving";
    const queryClient = freshQueryClient();
    const { rerender } = renderHook(() => useClientFeatureFlagSync(true), {
      wrapper: createWrapper(queryClient),
    });

    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();

    orgReadinessValue = "ready";
    rerender();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(useClientFeatureFlagStore.getState().hydrated).toBe(true);
    });
  });

  test("settles once org resolution concludes without an organization", async () => {
    // The bound on the wait above: the org store lands on a terminal state for
    // every fetch outcome, and a terminal failure means the header — and so the
    // server value — is never arriving. Staying pending forever would leave the
    // checkout page spinning, which is its own dead end.
    orgReadinessValue = "unavailable";
    const queryClient = freshQueryClient();
    renderHook(() => useClientFeatureFlagSync(true), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(useClientFeatureFlagStore.getState().hydrated).toBe(true);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("stays unsettled until the session is ready", async () => {
    const queryClient = freshQueryClient();
    renderHook(() => useClientFeatureFlagSync(false), {
      wrapper: createWrapper(queryClient),
    });

    await Promise.resolve();
    expect(useClientFeatureFlagStore.getState().hydrated).toBe(false);
  });

  test("hydrates the scope the response was fetched under", async () => {
    useClientFeatureFlagStore.getState().beginScope(ANONYMOUS_SCOPE);
    fetchMock.mockImplementation(async () => flagResponse(true));
    const queryClient = freshQueryClient();
    renderHook(() => useClientFeatureFlagSync(true), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(useClientFeatureFlagStore.getState().hydrated).toBe(true);
    });
    expect(useClientFeatureFlagStore.getState().marketingPricingTakeover).toBe(
      true,
    );
  });

  test("drops a response whose scope was superseded before it applied", async () => {
    // `beginScope` runs synchronously from a store subscription, so it can land
    // between the render that produced `data` and that render's passive effect.
    // `ScopeMover`'s layout effect occupies that same window: React runs every
    // layout effect in a commit before any passive effect in it.
    useClientFeatureFlagStore.getState().beginScope(ANONYMOUS_SCOPE);
    fetchMock.mockImplementation(async () => flagResponse(true));
    const queryClient = freshQueryClient();

    function ScopeMover() {
      const { data } = useQuery({
        queryKey: FLAG_QUERY_KEY,
        queryFn: () => Promise.reject(new Error("observer never fetches")),
        enabled: false,
      });
      useLayoutEffect(() => {
        if (data) {
          useClientFeatureFlagStore.getState().beginScope(SIGNED_IN_SCOPE);
        }
      }, [data]);
      return null;
    }

    function Harness() {
      useClientFeatureFlagSync(true);
      return <ScopeMover />;
    }

    render(<Harness />, { wrapper: createWrapper(queryClient) });

    await waitFor(() => {
      expect(useClientFeatureFlagStore.getState().scopeKey).toBe(
        SIGNED_IN_SCOPE,
      );
    });
    const state = useClientFeatureFlagStore.getState();
    expect(state.hydrated).toBe(false);
    expect(state.marketingPricingTakeover).toBe(false);
  });
});
