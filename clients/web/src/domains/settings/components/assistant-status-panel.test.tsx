/**
 * Tests for `useAssistantWithHealthz`.
 *
 * The properties that matter are that the health read is cached per assistant
 * rather than re-issued on every mount of the Settings landing page, and that
 * it does not queue behind the assistant record. Both are asserted by counting
 * requests, because both were previously true only by accident of ordering.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { getAssistant } from "@/assistant/api";
import type { healthzGet } from "@/generated/daemon/sdk.gen";
import type { HealthzGetResponse } from "@/generated/daemon/types.gen";
import {
  restoreStubbedModules,
  stubModule,
} from "@/utils/module-mock.test-helper";
import type { toast } from "@vellumai/design-library";

const HEALTHZ: HealthzGetResponse = {
  version: "1.2.3",
  disk: { usedMb: 10, totalMb: 100 },
  cpu: { currentPercent: 5, maxCores: 2 },
  memory: { currentMb: 200, maxMb: 1024 },
} as HealthzGetResponse;

let healthzCalls = 0;
let healthzFails = false;
/** Set to hold the next response open, so an in-flight window is observable. */
let holdHealthz: Promise<void> | null = null;

const healthzGetMock = mock(async () => {
  healthzCalls += 1;
  if (holdHealthz !== null) {
    await holdHealthz;
  }
  if (healthzFails) {
    throw new Error("healthz unreachable");
  }
  return { data: HEALTHZ, error: undefined, response: new Response(null) };
});

let orgReadiness: "ready" | "resolving" | "unavailable" = "ready";
let assistantCalls = 0;
/** Held open by default, so "healthz did not wait for it" is observable. */
let releaseAssistant: (() => void) | null = null;

const captureErrorMock = mock((_error: unknown, _tags: unknown) => {});
const toastErrorMock = mock((_message: string) => {});

// Every module below goes through `stubModule`, which spreads the real one and
// registers the undo: `mock.module` is process-global in bun, so a partial
// shape erases a module's other exports for whatever file loads it next.
afterAll(restoreStubbedModules);

stubModule(
  "@/generated/daemon/sdk.gen",
  await import("@/generated/daemon/sdk.gen"),
  { healthzGet: healthzGetMock as unknown as typeof healthzGet },
);

stubModule("@/assistant/api", await import("@/assistant/api"), {
  getAssistant: (async () => {
    assistantCalls += 1;
    if (releaseAssistant !== null) {
      await new Promise<void>((resolve) => {
        releaseAssistant = () => resolve();
      });
    }
    return { ok: true, status: 200, data: { id: "a-1", name: "Assistant" } };
  }) as unknown as typeof getAssistant,
});

stubModule(
  "@/assistant/use-active-assistant-id",
  await import("@/assistant/use-active-assistant-id"),
  { useActiveAssistantId: () => "a-1" },
);

stubModule(
  "@/hooks/use-is-org-ready",
  await import("@/hooks/use-is-org-ready"),
  {
    useOrgHeaderReadiness: () => orgReadiness,
  },
);

stubModule(
  "@/lib/sentry/capture-error",
  await import("@/lib/sentry/capture-error"),
  { captureError: captureErrorMock },
);

stubModule(
  "@vellumai/design-library",
  await import("@vellumai/design-library"),
  {
    toast: { error: toastErrorMock } as unknown as typeof toast,
  },
);

const { useAssistantWithHealthz } =
  await import("@/domains/settings/components/assistant-status-panel");

/**
 * One client across every render in a test, so a remount reads the cache the
 * first mount populated. This is what the app does: the provider outlives any
 * one Settings visit.
 */
let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  healthzCalls = 0;
  assistantCalls = 0;
  healthzFails = false;
  holdHealthz = null;
  orgReadiness = "ready";
  releaseAssistant = null;
  captureErrorMock.mockClear();
  toastErrorMock.mockClear();
  queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 10_000, retry: false } },
  });
});

afterEach(cleanup);

describe("useAssistantWithHealthz", () => {
  test("a second visit reads the cached health instead of asking again", async () => {
    // GIVEN one visit to Settings that loaded the health card
    const first = renderHook(() => useAssistantWithHealthz(), { wrapper });
    await waitFor(() => expect(first.result.current.healthz).not.toBeNull());
    expect(healthzCalls).toBe(1);

    // WHEN the user leaves Settings and comes back inside the stale window
    first.unmount();
    const second = renderHook(() => useAssistantWithHealthz(), { wrapper });

    // THEN the card has its values with no request and no loading state, so it
    // paints immediately rather than showing spinners again
    expect(second.result.current.healthz).toEqual(HEALTHZ);
    expect(second.result.current.healthzLoading).toBe(false);
    expect(healthzCalls).toBe(1);
  });

  test("the health read does not queue behind the assistant record", async () => {
    // GIVEN an assistant record that never resolves, standing in for a slow
    // round trip over the tunnel
    releaseAssistant = () => {};

    // WHEN the hook mounts
    renderHook(() => useAssistantWithHealthz(), { wrapper });

    // THEN health is fetched anyway: the two reads go out together rather than
    // nose to tail, which over a tunnel was a whole extra round trip
    await waitFor(() => expect(healthzCalls).toBe(1));
    expect(assistantCalls).toBe(1);
  });

  test("reports a failure the user is looking at", async () => {
    healthzFails = true;

    const { result } = renderHook(() => useAssistantWithHealthz(), { wrapper });

    await waitFor(() => expect(captureErrorMock).toHaveBeenCalledTimes(1));
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(result.current.healthz).toBeNull();
  });

  test("waits for the organization header rather than reporting no metrics", async () => {
    // GIVEN a platform session whose organization header has not resolved yet
    orgReadiness = "resolving";

    const { result } = renderHook(() => useAssistantWithHealthz(), { wrapper });

    // THEN nothing is requested headerless, and the cards read as loading
    // rather than falling through to their empty dashes
    expect(healthzCalls).toBe(0);
    expect(result.current.healthzLoading).toBe(true);
  });

  test("stops waiting once organization resolution has given up", async () => {
    // GIVEN organization resolution that concluded with no usable id
    orgReadiness = "unavailable";

    const { result } = renderHook(() => useAssistantWithHealthz(), { wrapper });

    // THEN the surface falls through to its empty state instead of holding a
    // spinner for as long as the page is open
    expect(healthzCalls).toBe(0);
    expect(result.current.healthzLoading).toBe(false);
    expect(result.current.healthz).toBeNull();
  });

  test("stays silent about a failure while polling through a resize", async () => {
    // GIVEN a loaded card
    const { result, unmount } = renderHook(() => useAssistantWithHealthz(), {
      wrapper,
    });
    await waitFor(() => expect(result.current.healthz).not.toBeNull());

    // WHEN a resize poll is running and the endpoint goes unreachable, which
    // is what a rolling pod looks like from here
    healthzFails = true;
    const polling = result.current.refetchUntilResized(HEALTHZ);
    await waitFor(() => expect(result.current.healthzPolling).toBe(true));
    // The poll sleeps a whole interval before its first read, so this outwaits
    // `HEALTHZ_POLL_INTERVAL_MS` rather than the default second.
    await waitFor(() => expect(healthzCalls).toBeGreaterThan(1), {
      timeout: 10_000,
    });

    // THEN the expected unreachability is not reported to the user, and the
    // last good reading stays on the cards rather than blanking
    expect(captureErrorMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(result.current.healthz).toEqual(HEALTHZ);

    // Stand the poll down rather than leaving it running behind the suite.
    unmount();
    await polling;

    // AND the swallowed failure does not outlive the poll. A later visit reads
    // the same cache entry, so a poll failure left on it as the query's error
    // would surface as a toast for a failure nobody was meant to see.
    healthzFails = false;
    renderHook(() => useAssistantWithHealthz(), { wrapper });
    await waitFor(() => expect(healthzCalls).toBeGreaterThan(0));
    expect(captureErrorMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 30_000);

  test("the refresh affordance reflects a refresh over existing values", async () => {
    // GIVEN a card that already has its values
    const { result } = renderHook(() => useAssistantWithHealthz(), { wrapper });
    await waitFor(() => expect(result.current.healthz).not.toBeNull());
    expect(result.current.healthzFetching).toBe(false);

    // WHEN the user asks for a refresh, held open so the window is observable
    let releaseRefresh = (): void => {};
    holdHealthz = new Promise<void>((resolve) => {
      releaseRefresh = () => resolve();
    });
    let refreshing: Promise<void> = Promise.resolve();
    act(() => {
      refreshing = result.current.refetch();
    });

    // THEN the in-flight signal is raised even though there is nothing to
    // load: `healthzLoading` stays false because the values are still on
    // screen, so the button needs its own signal to spin on
    await waitFor(() => expect(result.current.healthzFetching).toBe(true));
    expect(result.current.healthzLoading).toBe(false);
    expect(result.current.healthz).toEqual(HEALTHZ);

    await act(async () => {
      releaseRefresh();
      await refreshing;
    });
    await waitFor(() => expect(result.current.healthzFetching).toBe(false));
  });
});
