/**
 * Direct unit tests for the lifecycle state machine — no React tree,
 * no `renderHook`. Demonstrates the testability that moving the
 * machine out of React unlocks.
 *
 * Side-effect helpers (`setSelfHostedConnection`, `isGatewayAuthMode`,
 * etc.) are mocked at module scope. API calls go through a mock
 * version of `getAssistant`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";

// Import the real helpers from `@/assistant/lifecycle` before mocking
// the module — we need the actual resolver / error-builder logic in
// the mocked surface but with `INITIALIZING_TIMEOUT_MS` shrunk so the
// 5-minute watchdog is reachable from a test.
import {
  buildInitializingTimeoutError,
  resolveAssistantLifecycleState,
} from "@/assistant/lifecycle";

const TEST_INITIALIZING_TIMEOUT_MS = 30;

// --- module mocks --- //

const getAssistantMock = mock(async () => ({ ok: false, status: 404 }));
const getAssistantHealthzMock = mock(async () => ({ ok: true }));

mock.module("@/assistant/api", () => ({
  getAssistant: getAssistantMock,
  getAssistantHealthz: getAssistantHealthzMock,
}));

const setSelfHostedConnectionMock = mock((_args: unknown) => {});
mock.module("@/lib/self-hosted/connection", () => ({
  setSelfHostedConnection: setSelfHostedConnectionMock,
}));

const isGatewayAuthModeMock = mock(() => false);
const getGatewayTokenMock = mock(() => "token");
mock.module("@/lib/auth/gateway-session", () => ({
  isGatewayAuthMode: isGatewayAuthModeMock,
  getGatewayToken: getGatewayTokenMock,
}));

const isLocalModeMock = mock(() => false);
const getSelectedAssistantMock = mock(
  (): { assistantId: string } | undefined => undefined,
);
const getLocalGatewayUrlMock = mock((): string | undefined => undefined);
mock.module("@/lib/local-mode", () => ({
  isLocalMode: isLocalModeMock,
  isLocalAssistant: () => false,
  isPlatformAssistant: () => false,
  getSelectedAssistant: getSelectedAssistantMock,
  getLocalGatewayUrl: getLocalGatewayUrlMock,
}));

// Sentry is a side-effect-only dep here; silence it.
mock.module("@sentry/react", () => ({
  captureException: () => {},
  captureMessage: () => {},
  addBreadcrumb: () => {},
}));

// Capture the unreachable-bus listener so tests can trigger it.
let capturedUnreachableListener: (() => void) | null = null;
mock.module("@/assistant/unreachable-bus", () => ({
  subscribeAssistantUnreachable: (listener: () => void) => {
    capturedUnreachableListener = listener;
    return () => {
      capturedUnreachableListener = null;
    };
  },
}));

mock.module("@/assistant/lifecycle", () => ({
  buildInitializingTimeoutError,
  INITIALIZING_TIMEOUT_MS: TEST_INITIALIZING_TIMEOUT_MS,
  resolveAssistantLifecycleState,
}));

// --- imports under test --- //

const { lifecycleService } = await import("./lifecycle-service");
const { useAssistantLifecycleStore } = await import("./lifecycle-store");
const { useResolvedAssistantsStore } = await import("@/stores/resolved-assistants-store");

// --- fake query client --- //

function makeQueryClient(): QueryClient {
  return {
    fetchQuery: async ({ queryFn }: { queryFn: () => Promise<unknown> }) =>
      queryFn(),
    setQueryData: () => undefined,
    invalidateQueries: async () => undefined,
  } as unknown as QueryClient;
}

const baseInputs = {
  sessionStatus: "authenticated" as const,
  hasPlatformSession: true,
};

beforeEach(() => {
  getAssistantMock.mockClear();
  getAssistantHealthzMock.mockClear();
  setSelfHostedConnectionMock.mockClear();
  // Re-baseline implementations every test so a `mockImplementationOnce`
  // or `mockImplementation` from a prior test doesn't leak.
  // `mockClear` resets only the call history, not the implementation —
  // any new mocked dep added here MUST re-set its baseline below or
  // tests will silently inherit the previous test's stub.
  isGatewayAuthModeMock.mockImplementation(() => false);
  isLocalModeMock.mockImplementation(() => false);
  getSelectedAssistantMock.mockImplementation(() => undefined);
  getLocalGatewayUrlMock.mockImplementation(() => undefined);
  getAssistantMock.mockImplementation(async () => ({ ok: false, status: 404 }));
  getAssistantHealthzMock.mockImplementation(async () => ({ ok: true }));
  lifecycleService.__resetForTesting();
  // Deterministic baseline for the selection subscription's diff. Reset
  // AFTER __resetForTesting (state is `loading`, gateway mode is false)
  // so the write itself can't republish.
  useResolvedAssistantsStore.setState({
    assistants: [],
    assistantsHydrated: false,
    selectedAssistantId: null,
  });
  localStorage.removeItem("vellum:selectedAssistantId");
});

afterEach(() => {
  lifecycleService.__resetForTesting();
});

describe("lifecycleService — server state projection", () => {
  test("active result writes the assistant id and flips to active", async () => {
    getAssistantMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      data: {
        id: "asst-1",
        status: "active",
        is_local: false,
        maintenance_mode: { enabled: false },
      },
    }));
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });

    await lifecycleService.checkAssistant();

    expect(
      useResolvedAssistantsStore.getState().activeAssistantId,
    ).toBe("asst-1");
    expect(
      useAssistantLifecycleStore.getState().operationalStatusAssistantId,
    ).toBe("asst-1");
    expect(useAssistantLifecycleStore.getState().assistantState).toMatchObject({
      kind: "active",
      isLocal: false,
      maintenanceMode: { enabled: false },
    });
  });

  test("cleanup result publishes an operational-status polling id without activating the assistant", async () => {
    getAssistantMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      data: {
        id: "asst-cleanup",
        status: "to_be_deleted",
        is_local: false,
        maintenance_mode: { enabled: false },
      },
    }));
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });

    await lifecycleService.checkAssistant();

    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "cleaning_up",
    );
    expect(
      useResolvedAssistantsStore.getState().activeAssistantId,
    ).toBeNull();
    expect(
      useAssistantLifecycleStore.getState().operationalStatusAssistantId,
    ).toBe("asst-cleanup");
  });

  test("self_hosted result primes the self-hosted connection and writes the id", async () => {
    getAssistantMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      data: {
        id: "asst-local-1",
        status: "active",
        is_local: true,
        ingress_url: "https://gateway.example/path",
        platform_actor_token: "tok",
      },
    }));
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });

    await lifecycleService.checkAssistant();

    expect(setSelfHostedConnectionMock).toHaveBeenCalledWith({
      url: "https://gateway.example/path",
      token: "tok",
    });
    expect(
      useResolvedAssistantsStore.getState().activeAssistantId,
    ).toBe("asst-local-1");
    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "self_hosted",
    );
  });
});
describe("lifecycleService — bootstrap branches", () => {
  test("respondToInputs with an unauthenticated session clears both stores (safety-net for token-expiry-style auth flips that don't call logout())", async () => {
    // Drive the service into an `active` state through the
    // legitimate path so its internal state mirrors the store.
    getAssistantMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      data: {
        id: "asst-prev-session",
        status: "active",
        is_local: false,
        maintenance_mode: { enabled: false },
      },
    }));
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });
    await lifecycleService.checkAssistant();
    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "active",
    );

    // Now flip the session unauthenticated and reconcile.
    lifecycleService.setInputs({
      ...baseInputs,
      sessionStatus: "unauthenticated",
      queryClient: makeQueryClient(),
    });
    await lifecycleService.respondToInputs();

    expect(
      useResolvedAssistantsStore.getState().activeAssistantId,
    ).toBeNull();
    expect(
      useAssistantLifecycleStore.getState().operationalStatusAssistantId,
    ).toBeNull();
    expect(useAssistantLifecycleStore.getState().assistantState).toEqual({
      kind: "loading",
    });
  });

  test("resetForLogout clears both stores synchronously without needing setInputs", async () => {
    // Drive into active first via the normal flow.
    getAssistantMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      data: {
        id: "asst-prev",
        status: "active",
        is_local: false,
        maintenance_mode: { enabled: false },
      },
    }));
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });
    await lifecycleService.checkAssistant();
    expect(
      useResolvedAssistantsStore.getState().activeAssistantId,
    ).toBe("asst-prev");

    // Synchronous reset — no `await`, no input flip needed.
    lifecycleService.resetForLogout();

    expect(
      useResolvedAssistantsStore.getState().activeAssistantId,
    ).toBeNull();
    expect(
      useAssistantLifecycleStore.getState().operationalStatusAssistantId,
    ).toBeNull();
    expect(useAssistantLifecycleStore.getState().assistantState).toEqual({
      kind: "loading",
    });
  });

  test("resetForLogout drops the auto-greet one-shot so the next login doesn't inherit it", () => {
    lifecycleService.markExpectingFirstMessage();
    expect(useAssistantLifecycleStore.getState().expectingFirstMessage).toBe(true);

    lifecycleService.resetForLogout();

    expect(useAssistantLifecycleStore.getState().expectingFirstMessage).toBe(false);
  });

  test("transition to error drops the auto-greet one-shot — a subsequent retry-to-existing-active won't show a spurious gate", async () => {
    // Set the flag (as auto-hatch would), then drive
    // the service into the error state via the network-error catch
    // in `checkAssistant` (the simplest reachable error transition
    // without exhausting the hatch-retry budget or the watchdog).
    lifecycleService.markExpectingFirstMessage();
    expect(useAssistantLifecycleStore.getState().expectingFirstMessage).toBe(true);

    getAssistantMock.mockImplementationOnce(async () => {
      throw new Error("network down");
    });

    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });
    await lifecycleService.checkAssistant();

    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "error",
    );
    expect(useAssistantLifecycleStore.getState().expectingFirstMessage).toBe(false);
  });

  test("gateway-auth short-circuit writes active state without calling the server", async () => {
    isGatewayAuthModeMock.mockImplementation(() => true);

    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });
    await lifecycleService.respondToInputs();

    expect(getAssistantMock).not.toHaveBeenCalled();
    const state = useAssistantLifecycleStore.getState().assistantState;
    expect(state.kind).toBe("active");
    if (state.kind === "active") {
      expect(state.isLocal).toBe(true);
    }
    // The short-circuit also starts the local health heartbeat.
    await waitFor(() => {
      const s = useAssistantLifecycleStore.getState().assistantState;
      return s.kind === "active" && s.health === "healthy";
    });
  });
});

describe("lifecycleService — 404 (no assistant)", () => {
  test("404 is a no-op — no state transition", async () => {
    getAssistantMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 404,
    }));

    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });
    await lifecycleService.checkAssistant();

    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "loading",
    );
  });

  test("404 does not mark expecting-first-message", async () => {
    getAssistantMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 404,
    }));

    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });
    await lifecycleService.checkAssistant();

    expect(useAssistantLifecycleStore.getState().expectingFirstMessage).toBe(false);
  });

  test("clearExpectingFirstMessage flips the store back to false; subsequent reads stay false", () => {
    lifecycleService.markExpectingFirstMessage();
    expect(useAssistantLifecycleStore.getState().expectingFirstMessage).toBe(true);
    lifecycleService.clearExpectingFirstMessage();
    expect(useAssistantLifecycleStore.getState().expectingFirstMessage).toBe(false);
    lifecycleService.clearExpectingFirstMessage();
    expect(useAssistantLifecycleStore.getState().expectingFirstMessage).toBe(false);
  });

  test("markExpectingFirstMessage is the public seam onboarding uses (bypasses auto-hatch)", () => {
    expect(useAssistantLifecycleStore.getState().expectingFirstMessage).toBe(false);
    lifecycleService.markExpectingFirstMessage();
    expect(useAssistantLifecycleStore.getState().expectingFirstMessage).toBe(true);
  });
});

describe("lifecycleService — pre-init guards", () => {
  test("public actions called before setInputs are no-ops, not crashes", async () => {
    // Don't call setInputs at all — simulate a child route mounting
    // a `useEffect` that calls a lifecycle action before
    // `RootLayout`'s passive effect has installed inputs.
    await lifecycleService.checkAssistant();
    lifecycleService.retryAssistant();
    await lifecycleService.respondToInputs();

    expect(getAssistantMock).not.toHaveBeenCalled();
    // Initial state should be untouched — no spurious error
    // transition (the bug the guard prevents).
    expect(useAssistantLifecycleStore.getState().assistantState).toEqual({
      kind: "loading",
    });
  });
});

describe("lifecycleService — stuck-initializing watchdog", () => {
  test("redundant initializing→initializing transitions do not reset the 5-minute clock", async () => {
    const setTimeoutSpy = mock(globalThis.setTimeout);
    const clearTimeoutSpy = mock(globalThis.clearTimeout);
    const originalSet = globalThis.setTimeout;
    const originalClear = globalThis.clearTimeout;
    globalThis.setTimeout = setTimeoutSpy as unknown as typeof setTimeout;
    globalThis.clearTimeout = clearTimeoutSpy as unknown as typeof clearTimeout;
    try {
      getAssistantMock.mockImplementation(async () => ({
        ok: true,
        status: 200,
        data: { id: "asst-init", status: "initializing" },
      }));
      lifecycleService.setInputs({
        ...baseInputs,
        queryClient: makeQueryClient(),
      });

      // First check: loading → initializing → arms the watchdog
      // (one setTimeout for INITIALIZING_TIMEOUT_MS).
      await lifecycleService.checkAssistant();
      const armCalls = setTimeoutSpy.mock.calls.filter(
        (call) => typeof call[1] === "number" && call[1] > 1000,
      ).length;
      const clearCallsAfterFirst = clearTimeoutSpy.mock.calls.length;

      // Subsequent polls that re-confirm initializing must NOT
      // rearm the watchdog (would reset the clock and the recovery
      // path would never run). Driving through `checkAssistant`
      // exercises the same `applyServerStateUpdate` path the
      // background poll takes.
      await lifecycleService.checkAssistant();
      await lifecycleService.checkAssistant();

      const armCallsAfter = setTimeoutSpy.mock.calls.filter(
        (call) => typeof call[1] === "number" && call[1] > 1000,
      ).length;
      const clearCallsAfter = clearTimeoutSpy.mock.calls.length;

      expect(armCallsAfter).toBe(armCalls);
      expect(clearCallsAfter).toBe(clearCallsAfterFirst);
    } finally {
      globalThis.setTimeout = originalSet;
      globalThis.clearTimeout = originalClear;
    }
  });
});

describe("lifecycleService — repeated 404s", () => {
  test("repeated 404s are no-ops — no state change", async () => {
    getAssistantMock.mockImplementation(async () => ({
      ok: false,
      status: 404,
    }));

    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });

    await lifecycleService.checkAssistant();
    await lifecycleService.checkAssistant();
    await lifecycleService.checkAssistant();

    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "loading",
    );
  });
});

// ---------------------------------------------------------------------------
// Watchdog timeout (LUM-2067)
//
// These tests shrink `INITIALIZING_TIMEOUT_MS` to 30ms (via the
// `@/assistant/lifecycle` mock above) so the watchdog is reachable
// from a unit test without time-travel reasoning. The same 5-minute
// watchdog runs in production; only the timeout constant differs here.
// ---------------------------------------------------------------------------

/**
 * Spin until `predicate()` returns true or `timeoutMs` elapses. Bun
 * doesn't ship fake-timer helpers we can rely on for setTimeout, so
 * the watchdog tests use a small real timer and a poll loop.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function initializingResult(id: string) {
  return {
    ok: true as const,
    status: 200,
    data: {
      id,
      status: "initializing",
      is_local: false,
      maintenance_mode: { enabled: false },
    },
  };
}

describe("lifecycleService — watchdog timeout", () => {
  test("watchdog fires and transitions to error after timeout", async () => {
    getAssistantMock.mockImplementation(async () =>
      initializingResult("asst-stuck"),
    );

    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });
    await lifecycleService.checkAssistant();
    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "initializing",
    );
    expect(
      useAssistantLifecycleStore.getState().operationalStatusAssistantId,
    ).toBe("asst-stuck");

    await waitFor(
      () =>
        useAssistantLifecycleStore.getState().assistantState.kind === "error",
      1000,
    );

    const state = useAssistantLifecycleStore.getState().assistantState;
    expect(state.kind).toBe("error");
    if (state.kind === "error") {
      expect(state.message).toEqual(buildInitializingTimeoutError().message);
    }
  });
});

// ---------------------------------------------------------------------------
// Reachability probe
// ---------------------------------------------------------------------------

describe("lifecycleService — reachability probe", () => {
  test("after projectActive, reachable becomes true when healthz succeeds", async () => {
    getAssistantHealthzMock.mockImplementation(async () => ({ ok: true }));
    getAssistantMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      data: {
        id: "asst-reach-1",
        status: "active",
        is_local: false,
        maintenance_mode: { enabled: false },
      },
    }));
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });

    await lifecycleService.checkAssistant();

    await waitFor(() => {
      const s = useAssistantLifecycleStore.getState().assistantState;
      return s.kind === "active" && s.reachable === true;
    });

    const state = useAssistantLifecycleStore.getState().assistantState;
    expect(state.kind).toBe("active");
    if (state.kind === "active") {
      expect(state.reachable).toBe(true);
    }
  });

  test("after projectActive, reachable becomes false when healthz fails", async () => {
    getAssistantHealthzMock.mockImplementation(async () => ({ ok: false, status: 503 }));
    getAssistantMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      data: {
        id: "asst-reach-2",
        status: "active",
        is_local: false,
        maintenance_mode: { enabled: false },
      },
    }));
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });

    await lifecycleService.checkAssistant();

    await waitFor(() => {
      const s = useAssistantLifecycleStore.getState().assistantState;
      return s.kind === "active" && s.reachable === false;
    });

    const state = useAssistantLifecycleStore.getState().assistantState;
    expect(state.kind).toBe("active");
    if (state.kind === "active") {
      expect(state.reachable).toBe(false);
    }
  });

  test("after projectActive, reachable becomes false when healthz throws", async () => {
    getAssistantHealthzMock.mockImplementation(async () => {
      throw new Error("network error");
    });
    getAssistantMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      data: {
        id: "asst-reach-3",
        status: "active",
        is_local: false,
        maintenance_mode: { enabled: false },
      },
    }));
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });

    await lifecycleService.checkAssistant();

    await waitFor(() => {
      const s = useAssistantLifecycleStore.getState().assistantState;
      return s.kind === "active" && s.reachable === false;
    });

    const state = useAssistantLifecycleStore.getState().assistantState;
    expect(state.kind).toBe("active");
    if (state.kind === "active") {
      expect(state.reachable).toBe(false);
    }
  });

  test("unreachable bus sets reachable to false", async () => {
    getAssistantHealthzMock.mockImplementation(async () => ({ ok: true }));
    getAssistantMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      data: {
        id: "asst-unreach-1",
        status: "active",
        is_local: false,
        maintenance_mode: { enabled: false },
      },
    }));
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });

    await lifecycleService.checkAssistant();

    // Wait for the initial probe to complete with reachable=true
    await waitFor(() => {
      const s = useAssistantLifecycleStore.getState().assistantState;
      return s.kind === "active" && s.reachable === true;
    });

    // Now make the healthz fail so the retry probe doesn't flip it back
    getAssistantHealthzMock.mockImplementation(async () => ({ ok: false, status: 503 }));

    // Fire the unreachable bus listener
    expect(capturedUnreachableListener).not.toBeNull();
    capturedUnreachableListener!();

    const state = useAssistantLifecycleStore.getState().assistantState;
    expect(state.kind).toBe("active");
    if (state.kind === "active") {
      expect(state.reachable).toBe(false);
    }
  });

  test("unreachable bus is a no-op when not in active state", () => {
    // Service is in loading state (never driven to active)
    expect(capturedUnreachableListener).not.toBeNull();
    capturedUnreachableListener!();

    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "loading",
    );
  });
});

// ---------------------------------------------------------------------------
// Local health heartbeat
// ---------------------------------------------------------------------------

describe("lifecycleService — local health heartbeat", () => {
  test("self-hosted projection starts a heartbeat that writes health", async () => {
    getAssistantHealthzMock.mockImplementation(async () => ({ ok: true }));
    getAssistantMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      data: {
        id: "asst-local-1",
        status: "active",
        is_local: true,
        ingress_url: "https://gateway.example.test",
        platform_actor_token: "actor-token",
      },
    }));
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });

    await lifecycleService.checkAssistant();

    await waitFor(() => {
      const s = useAssistantLifecycleStore.getState().assistantState;
      return s.kind === "self_hosted" && s.health === "healthy";
    });
    expect(getAssistantHealthzMock).toHaveBeenCalled();
  });

  test("heartbeat maps a degraded daemon status to unhealthy while reachable", async () => {
    isGatewayAuthModeMock.mockImplementation(() => true);
    getAssistantHealthzMock.mockImplementation(async () => ({
      ok: true,
      data: { status: "degraded" },
    }));
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });

    await lifecycleService.respondToInputs();

    await waitFor(() => {
      const s = useAssistantLifecycleStore.getState().assistantState;
      return s.kind === "active" && s.health === "unhealthy";
    });
    const state = useAssistantLifecycleStore.getState().assistantState;
    expect(state.kind).toBe("active");
    if (state.kind === "active") {
      expect(state.reachable).toBe(true);
    }
  });

  test("triggerReachabilityProbe pulls the heartbeat forward without flipping health optimistically", async () => {
    isGatewayAuthModeMock.mockImplementation(() => true);
    getAssistantHealthzMock.mockImplementation(async () => ({ ok: true }));
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });
    await lifecycleService.respondToInputs();
    await waitFor(() => {
      const s = useAssistantLifecycleStore.getState().assistantState;
      return s.kind === "active" && s.health === "healthy";
    });

    getAssistantHealthzMock.mockImplementation(async () => ({
      ok: false,
      status: 503,
    }));
    lifecycleService.triggerReachabilityProbe();

    // Synchronously after the trigger: the acute `reachable` signal
    // flips for the chat overlay, but `health` keeps its last
    // probe-confirmed value so the banner doesn't flash.
    const optimistic = useAssistantLifecycleStore.getState().assistantState;
    expect(optimistic.kind).toBe("active");
    if (optimistic.kind === "active") {
      expect(optimistic.reachable).toBe(false);
      expect(optimistic.health).toBe("healthy");
    }

    // Once the pulled-forward probe completes, health follows.
    await waitFor(() => {
      const s = useAssistantLifecycleStore.getState().assistantState;
      return (
        s.kind === "active" &&
        s.health === "unreachable" &&
        s.reachable === false
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Selection subscription — gateway-mode republish
//
// The service subscribes to the resolved-assistants store's
// `selectedAssistantId` slice (real store here, so the store action
// exercises the subscription directly): any selection write while
// gateway-auth mode is on and the lifecycle is past `loading`
// re-runs the gateway short-circuit, republishing `activeAssistantId`
// and the self-hosted connection.
// ---------------------------------------------------------------------------

describe("lifecycleService — selection subscription", () => {
  /** Drive the service into the gateway-auth active state. */
  async function driveGatewayActive(assistantId: string): Promise<void> {
    isGatewayAuthModeMock.mockImplementation(() => true);
    getLocalGatewayUrlMock.mockImplementation(
      () => "/assistant/__gateway/1111",
    );
    getSelectedAssistantMock.mockImplementation(() => ({ assistantId }));
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });
    await lifecycleService.respondToInputs();
    expect(
      useResolvedAssistantsStore.getState().activeAssistantId,
    ).toBe(assistantId);
  }

  test("selection write republishes activeAssistantId and the connection", async () => {
    await driveGatewayActive("asst-a");
    getLocalGatewayUrlMock.mockImplementation(
      () => "/assistant/__gateway/2222",
    );
    getSelectedAssistantMock.mockImplementation(() => ({
      assistantId: "asst-b",
    }));
    setSelfHostedConnectionMock.mockClear();

    useResolvedAssistantsStore.getState().setSelectedAssistant("asst-b");

    expect(
      useResolvedAssistantsStore.getState().activeAssistantId,
    ).toBe("asst-b");
    expect(setSelfHostedConnectionMock).toHaveBeenCalledTimes(1);
    const arg = setSelfHostedConnectionMock.mock.calls[0]![0] as {
      url: string;
    };
    expect(arg.url).toContain("/assistant/__gateway/2222");
  });

  test("no republish while the lifecycle is still loading", () => {
    isGatewayAuthModeMock.mockImplementation(() => true);

    useResolvedAssistantsStore.getState().setSelectedAssistant("asst-early");

    expect(
      useResolvedAssistantsStore.getState().activeAssistantId,
    ).toBeNull();
    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "loading",
    );
    expect(setSelfHostedConnectionMock).not.toHaveBeenCalled();
  });

  test("no republish outside gateway-auth mode", async () => {
    // Drive to active via the platform path.
    getAssistantMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      data: {
        id: "asst-platform",
        status: "active",
        is_local: false,
        maintenance_mode: { enabled: false },
      },
    }));
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });
    await lifecycleService.checkAssistant();
    setSelfHostedConnectionMock.mockClear();

    useResolvedAssistantsStore.getState().setSelectedAssistant("asst-other");

    expect(
      useResolvedAssistantsStore.getState().activeAssistantId,
    ).toBe("asst-platform");
    expect(setSelfHostedConnectionMock).not.toHaveBeenCalled();
  });

  test("same-id write does not republish", async () => {
    await driveGatewayActive("asst-a");
    useResolvedAssistantsStore.getState().setSelectedAssistant("asst-a");
    setSelfHostedConnectionMock.mockClear();

    useResolvedAssistantsStore.getState().setSelectedAssistant("asst-a");

    expect(setSelfHostedConnectionMock).not.toHaveBeenCalled();
  });

  test("reconcile-driven clear republishes the fallback assistant", async () => {
    await driveGatewayActive("asst-gone");
    useResolvedAssistantsStore.getState().setSelectedAssistant("asst-gone");
    // After the ghost is reconciled away, the lockfile fallback wins.
    getSelectedAssistantMock.mockImplementation(() => ({
      assistantId: "asst-fallback",
    }));

    // Lockfile load without the selected id → reconcile clears the slice
    // → subscription republishes from the lockfile fallback.
    useResolvedAssistantsStore
      .getState()
      .setFromLockfile({ assistants: [], activeAssistant: null });

    expect(
      useResolvedAssistantsStore.getState().selectedAssistantId,
    ).toBeNull();
    expect(
      useResolvedAssistantsStore.getState().activeAssistantId,
    ).toBe("asst-fallback");
  });

  test("selection clear after resetForLogout does not resurrect an active state", async () => {
    await driveGatewayActive("asst-a");
    useResolvedAssistantsStore.getState().setSelectedAssistant("asst-a");

    lifecycleService.resetForLogout();
    useResolvedAssistantsStore.getState().setSelectedAssistant(null);

    expect(
      useResolvedAssistantsStore.getState().activeAssistantId,
    ).toBeNull();
    expect(useAssistantLifecycleStore.getState().assistantState).toEqual({
      kind: "loading",
    });
  });
});
