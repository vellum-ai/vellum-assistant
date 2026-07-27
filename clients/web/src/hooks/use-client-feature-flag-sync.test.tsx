import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

const originalFetch = globalThis.fetch;
const fetchMock = mock(async () =>
  new Response(JSON.stringify({ flags: {} }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }),
);

const { useClientFeatureFlagSync } = await import(
  "@/hooks/use-client-feature-flag-sync"
);
const { useClientFeatureFlagStore } = await import(
  "@/stores/client-feature-flag-store"
);
const { featureFlagsClientFlagValuesRetrieveQueryKey } = await import(
  "@/generated/api/@tanstack/react-query.gen"
);

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
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  useClientFeatureFlagStore.setState(initialFlagState, true);
});

afterEach(() => {
  cleanup();
  window.__VELLUM_CONFIG__ = undefined;
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

    // The query retries once before giving up, so allow for its backoff.
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
      .setFlags({ marketingPricingTakeover: true });
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

  test("stays unsettled until the session is ready", async () => {
    const queryClient = freshQueryClient();
    renderHook(() => useClientFeatureFlagSync(false), {
      wrapper: createWrapper(queryClient),
    });

    await Promise.resolve();
    expect(useClientFeatureFlagStore.getState().hydrated).toBe(false);
  });
});
