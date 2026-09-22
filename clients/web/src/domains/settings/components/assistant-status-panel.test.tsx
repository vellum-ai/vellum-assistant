/**
 * Tests for `useAssistantWithHealthz`.
 *
 * Two properties carry this hook. A revisit to Settings paints the last
 * readings straight away instead of blanking the cards back to spinners, and
 * the health read does not queue behind the assistant record. The resize watch
 * is the third: the query owns its cadence, so the rule that decides it is
 * tested as a pure function and the hook test only covers the watch opening
 * and closing.
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

/** The same pod after a resize landed: more cores, more memory. */
const RESIZED: HealthzGetResponse = {
  ...HEALTHZ,
  cpu: { currentPercent: 5, maxCores: 4 },
  memory: { currentMb: 200, maxMb: 4096 },
} as HealthzGetResponse;

let healthzResponse: HealthzGetResponse = HEALTHZ;

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
  return {
    data: healthzResponse,
    error: undefined,
    response: new Response(null),
  };
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

const { useAssistantWithHealthz, resizePollInterval } =
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
  healthzResponse = HEALTHZ;
  holdHealthz = null;
  orgReadiness = "ready";
  releaseAssistant = null;
  captureErrorMock.mockClear();
  toastErrorMock.mockClear();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

afterEach(cleanup);

describe("resizePollInterval", () => {
  const watch = { baseline: HEALTHZ, until: 1_000 };

  test("does not poll when no resize is being watched", () => {
    expect(resizePollInterval(HEALTHZ, null, 0)).toBe(false);
  });

  test("stops at the deadline even if the allocation never moved", () => {
    expect(resizePollInterval(HEALTHZ, watch, 1_000)).toBe(false);
    expect(resizePollInterval(HEALTHZ, watch, 2_000)).toBe(false);
  });

  test("keeps polling while the allocation still matches the baseline", () => {
    expect(resizePollInterval(HEALTHZ, watch, 0)).toBeGreaterThan(0);
  });

  test("stops as soon as the allocation differs", () => {
    expect(resizePollInterval(RESIZED, watch, 0)).toBe(false);
  });

  test("keeps polling until a baseline exists to compare against", () => {
    // A resize started before any reading arrived: the first one back could
    // still be the pre-resize values, so it cannot end the watch.
    const unknown = { baseline: null, until: 1_000 };
    expect(resizePollInterval(undefined, unknown, 0)).toBeGreaterThan(0);
    expect(resizePollInterval(HEALTHZ, unknown, 0)).toBeGreaterThan(0);
  });

  test("keeps polling while the endpoint is still unreachable", () => {
    // Mid-restart there is no reading at all, which is not a reason to stop.
    expect(resizePollInterval(undefined, watch, 0)).toBeGreaterThan(0);
  });
});

describe("useAssistantWithHealthz", () => {
  test("a second visit paints the last readings instead of spinners", async () => {
    // GIVEN one visit to Settings that loaded the health card
    const first = renderHook(() => useAssistantWithHealthz(), { wrapper });
    await waitFor(() => expect(first.result.current.healthz).not.toBeNull());

    // WHEN the user leaves Settings and comes back
    first.unmount();
    const second = renderHook(() => useAssistantWithHealthz(), { wrapper });

    // THEN the values are on screen in the first render, with no loading state
    // to blank the cards. These are live readings, so a fresh one is still
    // fetched behind them: the cache is here to avoid the blank, not to stand
    // in for a current number.
    expect(second.result.current.healthz).toEqual(HEALTHZ);
    expect(second.result.current.healthzLoading).toBe(false);
    await waitFor(() => expect(healthzCalls).toBe(2));
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

  test("reports a failure when there is nothing to show", async () => {
    healthzFails = true;

    const { result } = renderHook(() => useAssistantWithHealthz(), { wrapper });

    await waitFor(() => expect(captureErrorMock).toHaveBeenCalledTimes(1));
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(result.current.healthz).toBeNull();
  });

  test("stays silent when a reading is already on the cards", async () => {
    // GIVEN a loaded card
    const { result } = renderHook(() => useAssistantWithHealthz(), { wrapper });
    await waitFor(() => expect(result.current.healthz).not.toBeNull());

    // WHEN a later read fails, which is what a rolling pod looks like from here
    healthzFails = true;
    await act(async () => {
      await result.current.refetch();
    });

    // THEN nothing interrupts the user, and the last reading stands. This is
    // what keeps a resize quiet, without a flag that can surface the failure
    // once the resize is over.
    expect(captureErrorMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(result.current.healthz).toEqual(HEALTHZ);
  });

  test("waits for the organization header rather than reporting no metrics", () => {
    // GIVEN a platform session whose organization header has not resolved yet
    orgReadiness = "resolving";

    const { result } = renderHook(() => useAssistantWithHealthz(), { wrapper });

    // THEN nothing is requested headerless, and the cards read as loading
    // rather than falling through to their empty dashes
    expect(healthzCalls).toBe(0);
    expect(result.current.healthzLoading).toBe(true);
  });

  test("stops waiting once organization resolution has given up", () => {
    // GIVEN organization resolution that concluded with no usable id
    orgReadiness = "unavailable";

    const { result } = renderHook(() => useAssistantWithHealthz(), { wrapper });

    // THEN the surface falls through to its empty state instead of holding a
    // spinner for as long as the page is open
    expect(healthzCalls).toBe(0);
    expect(result.current.healthzLoading).toBe(false);
    expect(result.current.healthz).toBeNull();
  });

  test("opens a resize watch and closes it when the allocation moves", async () => {
    // GIVEN a loaded card
    const { result } = renderHook(() => useAssistantWithHealthz(), { wrapper });
    await waitFor(() => expect(result.current.healthz).not.toBeNull());
    expect(result.current.healthzPolling).toBe(false);

    // WHEN a resize starts
    act(() => {
      result.current.refetchUntilResized(HEALTHZ);
    });

    // THEN the watch is open, which is what disables the resize controls
    expect(result.current.healthzPolling).toBe(true);

    // WHEN the rolled pod comes back with the new allocation
    healthzResponse = RESIZED;
    await act(async () => {
      await result.current.refetch();
    });

    // THEN the watch closes itself off the data, with no timer to cancel
    await waitFor(() => expect(result.current.healthzPolling).toBe(false));
    expect(result.current.healthz).toEqual(RESIZED);
  });

  test("the refresh affordance reflects a refresh over existing values", async () => {
    // GIVEN a card that already has its values
    const { result } = renderHook(() => useAssistantWithHealthz(), { wrapper });
    await waitFor(() => expect(result.current.healthz).not.toBeNull());
    await waitFor(() => expect(result.current.healthzFetching).toBe(false));

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
