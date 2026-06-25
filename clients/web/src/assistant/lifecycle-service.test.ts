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
  TRANSPORT_ERROR_MESSAGE,
} from "@/assistant/lifecycle";
import { publish } from "@/lib/event-bus";
import type { LocalAssistantStatusResult } from "@/runtime/local-mode-host";

const TEST_INITIALIZING_TIMEOUT_MS = 30;
// Shrunk transient-error auto-retry delay. Large enough that a timer
// armed by an unrelated test gets cleared by `afterEach` before it
// fires; small enough for the recovery tests' `waitFor` budget.
const TEST_ERROR_RETRY_DELAY_MS = 200;

// --- module mocks --- //

const getAssistantMock = mock(async () => ({ ok: false, status: 404 }));
const getAssistantHealthzMock = mock(async () => ({ ok: true }));

mock.module("@/assistant/api", () => ({
  acknowledgeAssistantDiskPressure: async () => ({ ok: true }),
  activateAssistant: async () => ({ ok: true }),
  createAssistantBackup: async () => ({ ok: true }),
  getAssistant: getAssistantMock,
  getAssistantDiskPressureStatus: async () => ({ ok: true }),
  getAssistantHealthz: getAssistantHealthzMock,
  hatchAssistant: async () => ({ ok: true }),
  listAssistantBackups: async () => ({ ok: true, backups: [] }),
  listAssistants: async () => ({ ok: true, data: [] }),
  restartAssistant: async () => ({ ok: true }),
  restoreAssistantBackup: async () => ({ ok: true }),
  retireAssistant: async () => ({ ok: true }),
  retireAssistantById: async () => ({ ok: true }),
}));

let selfHostedConnectionMockState: {
  url: string | null;
  token: string | null;
} = { url: null, token: null };
const setSelfHostedConnectionMock = mock(
  (
    connection: {
      url: string | null;
      token: string | null;
    } | null,
  ) => {
    selfHostedConnectionMockState =
      connection === null
        ? { url: null, token: null }
        : { url: connection.url, token: connection.token };
  },
);
mock.module("@/lib/self-hosted/connection", () => ({
  getSelfHostedActorToken: () => selfHostedConnectionMockState.token,
  getSelfHostedIngressUrl: () => selfHostedConnectionMockState.url,
  setSelfHostedConnection: setSelfHostedConnectionMock,
}));

const isGatewayAuthModeMock = mock(() => false);
const getGatewayTokenMock = mock(() => "token");
mock.module("@/lib/auth/gateway-session", () => ({
  GatewayTokenError: class GatewayTokenError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
      super(message);
      this.name = "GatewayTokenError";
      this.status = status;
    }
  },
  clearGatewayToken: () => {
    for (const key of [
      "vellum:gw:token",
      "vellum:gw:expiresAt",
      "vellum:gw:tokenSource",
      "gw:token",
      "gw:expiresAt",
      "gw:tokenSource",
    ]) {
      localStorage.removeItem(key);
    }
  },
  ensureGatewayToken: async () => getGatewayTokenMock(),
  getGatewayToken: getGatewayTokenMock,
  getLocalTokenUrl: () => undefined,
  isGatewayAuthEnabled: isGatewayAuthModeMock,
  isGatewayAuthMode: isGatewayAuthModeMock,
  isRepairableGatewayTokenError: () => false,
  setRemoteGatewayToken: () => {},
}));

const isLocalModeMock = mock(() => false);
const isRemoteGatewayModeMock = mock(() => false);
const getSelectedAssistantMock = mock(
  (): { assistantId: string } | undefined => undefined,
);
const getLocalGatewayUrlMock = mock((): string | undefined => undefined);
mock.module("@/lib/local-mode", () => ({
  getActiveAssistant: () => undefined,
  getLocalAssistants: () => [],
  getLocalGatewayUrl: getLocalGatewayUrlMock,
  getLockfile: () => ({ assistants: [], activeAssistant: null }),
  getPlatformAssistants: () => [],
  getPlatformRuntimeUrl: () => window.location.origin,
  getSelectedAssistant: getSelectedAssistantMock,
  hasAssistants: () => false,
  isLocalAssistant: () => false,
  isLocalMode: isLocalModeMock,
  isPlatformAssistant: () => false,
  isPlatformDisabled: () => false,
  isRemoteGatewayMode: isRemoteGatewayModeMock,
  loadLockfile: async () => ({ assistants: [], activeAssistant: null }),
  primeLocalGatewayConnection: async () => {},
  primeLocalGatewayConnectionWithRepair: async () => {},
  reconcileSelectedAssistant: () => {},
  retireLocalAssistant: async () => ({ ok: false }),
  saveLockfileAssistant: async () => {},
  setActiveLockfileAssistant: async () => {},
  syncPlatformAssistantsToLockfile: async () => {},
}));

const getLocalAssistantStatusHostMock = mock(
  async (_assistantId: string): Promise<LocalAssistantStatusResult> => ({
    ok: false,
    status: 501,
    error: "unsupported",
  }),
);
mock.module("@/runtime/local-mode-host", () => ({
  getLocalAssistantStatusHost: getLocalAssistantStatusHostMock,
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
  UNREACHABLE_STATUS_CODES: new Set<number>([502, 503, 504]),
  notifyAssistantUnreachable: () => {},
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
  TRANSPORT_ERROR_MESSAGE,
  errorRetryDelayMs: () => TEST_ERROR_RETRY_DELAY_MS,
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
  isRemoteGatewayModeMock.mockImplementation(() => false);
  getSelectedAssistantMock.mockImplementation(() => undefined);
  getLocalGatewayUrlMock.mockImplementation(() => undefined);
  getAssistantMock.mockImplementation(async () => ({ ok: false, status: 404 }));
  getAssistantHealthzMock.mockImplementation(async () => ({ ok: true }));
  getLocalAssistantStatusHostMock.mockClear();
  getLocalAssistantStatusHostMock.mockImplementation(
    async (_assistantId: string): Promise<LocalAssistantStatusResult> => ({
      ok: false,
      status: 501,
      error: "unsupported",
    }),
  );
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
  window.history.pushState(null, "", "/");
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

  test("gateway-auth mode does NOT reset on a platform sessionStatus flip to unauthenticated", async () => {
    // Local (gateway) and platform are independent session authorities:
    // a platform identity loss must not tear down a local lifecycle.
    isGatewayAuthModeMock.mockImplementation(() => true);

    // Drive into the gateway-auth active (self-hosted/local) state.
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });
    await lifecycleService.respondToInputs();
    const activeBefore = useResolvedAssistantsStore.getState().activeAssistantId;
    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "active",
    );

    // Flip the platform session unauthenticated and reconcile — the
    // gateway authority drives the lifecycle, so no reset happens.
    lifecycleService.setInputs({
      ...baseInputs,
      sessionStatus: "unauthenticated",
      queryClient: makeQueryClient(),
    });
    await lifecycleService.respondToInputs();

    expect(getAssistantMock).not.toHaveBeenCalled();
    const state = useAssistantLifecycleStore.getState().assistantState;
    expect(state.kind).toBe("active");
    if (state.kind === "active") {
      expect(state.isLocal).toBe(true);
    }
    expect(useResolvedAssistantsStore.getState().activeAssistantId).toBe(
      activeBefore,
    );
  });

  test("platform mode (not gateway-auth) still resets on a sessionStatus flip to unauthenticated", async () => {
    // Drive into an active state through the platform path.
    getAssistantMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      data: {
        id: "asst-platform-reset",
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

    // Platform identity loss (not gateway-auth) still resets the lifecycle.
    lifecycleService.setInputs({
      ...baseInputs,
      sessionStatus: "unauthenticated",
      queryClient: makeQueryClient(),
    });
    await lifecycleService.respondToInputs();

    expect(
      useResolvedAssistantsStore.getState().activeAssistantId,
    ).toBeNull();
    expect(useAssistantLifecycleStore.getState().assistantState).toEqual({
      kind: "loading",
    });
  });

  test("remote gateway short-circuit preserves a public path prefix", async () => {
    isGatewayAuthModeMock.mockImplementation(() => true);
    isRemoteGatewayModeMock.mockImplementation(() => true);
    window.history.pushState(
      null,
      "",
      "/assistant-123/assistant/conversations/self",
    );

    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });
    await lifecycleService.respondToInputs();

    expect(setSelfHostedConnectionMock).toHaveBeenCalledWith({
      url: `${window.location.origin}/assistant-123`,
      token: "token",
    });
    expect(useResolvedAssistantsStore.getState().activeAssistantId).toBe(
      "self",
    );
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

  test("unreachable bus does not re-enter an in-flight heartbeat probe", async () => {
    isGatewayAuthModeMock.mockImplementation(() => true);
    const healthzResolver: {
      current?: (value: { ok: false; status: 503 }) => void;
    } = {};
    const healthzPending = new Promise<{ ok: false; status: 503 }>(
      (resolve) => {
        healthzResolver.current = resolve;
      },
    );
    getAssistantHealthzMock.mockImplementation(() => {
      capturedUnreachableListener?.();
      return healthzPending;
    });
    getLocalAssistantStatusHostMock.mockImplementation(
      async (_assistantId: string): Promise<LocalAssistantStatusResult> => ({
        ok: true,
        state: "sleeping",
      }),
    );
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });

    await lifecycleService.respondToInputs();

    await waitFor(() => getAssistantHealthzMock.mock.calls.length === 1);
    await Promise.resolve();
    expect(getAssistantHealthzMock).toHaveBeenCalledTimes(1);

    capturedUnreachableListener?.();
    await Promise.resolve();
    expect(getAssistantHealthzMock).toHaveBeenCalledTimes(1);

    const resolveHealthz = healthzResolver.current;
    if (!resolveHealthz) {
      throw new Error("healthz promise was not started");
    }
    resolveHealthz({ ok: false, status: 503 });
    await waitFor(() => {
      const s = useAssistantLifecycleStore.getState().assistantState;
      return (
        s.kind === "active" &&
        s.health === "sleeping" &&
        s.reachable === false
      );
    });
    expect(getAssistantHealthzMock).toHaveBeenCalledTimes(1);
  });

  test("heartbeat maps host local status to sleeping and crashed states", async () => {
    for (const runtimeState of ["sleeping", "crashed"] as const) {
      lifecycleService.__resetForTesting();
      isGatewayAuthModeMock.mockImplementation(() => true);
      getAssistantHealthzMock.mockImplementation(async () => ({
        ok: false,
        status: 503,
      }));
      getLocalAssistantStatusHostMock.mockImplementation(
        async (_assistantId: string): Promise<LocalAssistantStatusResult> => ({
          ok: true,
          state: runtimeState,
        }),
      );
      lifecycleService.setInputs({
        ...baseInputs,
        queryClient: makeQueryClient(),
      });

      await lifecycleService.respondToInputs();

      await waitFor(() => {
        const s = useAssistantLifecycleStore.getState().assistantState;
        return (
          s.kind === "active" &&
          s.health === runtimeState &&
          s.reachable === false
        );
      });
    }
  });

  test("remote gateway heartbeat does not call host local status fallback", async () => {
    isGatewayAuthModeMock.mockImplementation(() => true);
    isRemoteGatewayModeMock.mockImplementation(() => true);
    getAssistantHealthzMock.mockImplementation(async () => ({
      ok: false,
      status: 503,
    }));
    getLocalAssistantStatusHostMock.mockImplementation(
      async (_assistantId: string): Promise<LocalAssistantStatusResult> => ({
        ok: true,
        state: "sleeping",
      }),
    );
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });

    await lifecycleService.respondToInputs();

    await waitFor(() => {
      const s = useAssistantLifecycleStore.getState().assistantState;
      return (
        s.kind === "active" &&
        s.health === "unreachable" &&
        s.reachable === false
      );
    });
    expect(getLocalAssistantStatusHostMock).not.toHaveBeenCalled();
  });

  test("heartbeat asks host status for the selected local assistant when active id is internal", async () => {
    isGatewayAuthModeMock.mockImplementation(() => true);
    getSelectedAssistantMock.mockImplementation(() => ({
      assistantId: "local-selected",
    }));
    getAssistantHealthzMock.mockImplementation(async () => ({
      ok: false,
      status: 503,
    }));
    getLocalAssistantStatusHostMock.mockImplementation(
      async (_assistantId: string): Promise<LocalAssistantStatusResult> => ({
        ok: true,
        state: "sleeping",
      }),
    );
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });

    await lifecycleService.respondToInputs();

    await waitFor(() => {
      const s = useAssistantLifecycleStore.getState().assistantState;
      return (
        s.kind === "active" &&
        s.health === "sleeping" &&
        s.reachable === false
      );
    });
    expect(getLocalAssistantStatusHostMock).toHaveBeenCalledWith(
      "local-selected",
    );
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

// ---------------------------------------------------------------------------
// Transport-shaped failures (LUM-2402)
//
// A wake-time network flap must not tear down a live chat surface
// (active → full-screen error) and must never strand the user on a
// dead error screen: transient errors carry friendly copy and
// auto-retry with backoff / on network-online signals.
// ---------------------------------------------------------------------------

describe("lifecycleService — transport-shaped failures", () => {
  function activeResult(id: string) {
    return {
      ok: true as const,
      status: 200,
      data: {
        id,
        status: "active",
        is_local: false,
        maintenance_mode: { enabled: false },
      },
    };
  }

  /** The structured 502 the Electron platform proxy synthesizes. */
  const proxyNetworkErrorResult = {
    ok: false as const,
    status: 502,
    error: {
      detail: "Couldn't reach Vellum. Check your internet connection and try again.",
      code: "proxy_network_error",
    },
  };

  async function driveActive(id: string): Promise<void> {
    getAssistantMock.mockImplementationOnce(async () => activeResult(id));
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });
    await lifecycleService.checkAssistant();
    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "active",
    );
  }

  test("active + thrown re-check degrades to reachable:false instead of tearing down", async () => {
    await driveActive("asst-live");
    getAssistantMock.mockImplementationOnce(async () => {
      throw new Error("Failed to fetch");
    });

    await lifecycleService.checkAssistant();

    const state = useAssistantLifecycleStore.getState().assistantState;
    expect(state.kind).toBe("active");
    if (state.kind === "active") {
      expect(state.reachable).toBe(false);
    }
    // The degraded session keeps its operational-status polling target.
    expect(
      useAssistantLifecycleStore.getState().operationalStatusAssistantId,
    ).toBe("asst-live");
  });

  test("active + proxy-synthesized network 502 degrades instead of tearing down", async () => {
    await driveActive("asst-live-2");
    getAssistantMock.mockImplementationOnce(async () => proxyNetworkErrorResult);

    await lifecycleService.checkAssistant();

    const state = useAssistantLifecycleStore.getState().assistantState;
    expect(state.kind).toBe("active");
    if (state.kind === "active") {
      expect(state.reachable).toBe(false);
    }
    expect(
      useAssistantLifecycleStore.getState().operationalStatusAssistantId,
    ).toBe("asst-live-2");
  });

  test("active + genuine server error still tears down to the error screen", async () => {
    await driveActive("asst-live-3");
    getAssistantMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 500,
      error: { detail: "Internal server error" },
    }));

    await lifecycleService.checkAssistant();

    const state = useAssistantLifecycleStore.getState().assistantState;
    expect(state).toMatchObject({
      kind: "error",
      message: "Internal server error",
    });
    if (state.kind === "error") {
      expect(state.transient).toBeUndefined();
    }
  });

  test("initializing + transport blip stays initializing (watchdog is the backstop)", async () => {
    getAssistantMock.mockImplementationOnce(async () =>
      initializingResult("asst-init-blip"),
    );
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });
    await lifecycleService.checkAssistant();
    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "initializing",
    );

    getAssistantMock.mockImplementationOnce(async () => proxyNetworkErrorResult);
    await lifecycleService.checkAssistant();

    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "initializing",
    );
  });

  test("boot-time transport failure lands on a transient error with friendly copy", async () => {
    getAssistantMock.mockImplementationOnce(async () => {
      throw new Error("net::ERR_NETWORK_CHANGED");
    });
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });

    await lifecycleService.checkAssistant();

    expect(useAssistantLifecycleStore.getState().assistantState).toEqual({
      kind: "error",
      transient: true,
      message: TRANSPORT_ERROR_MESSAGE,
    });
  });

  test("transient error auto-retries with backoff and recovers to active", async () => {
    getAssistantMock.mockImplementationOnce(async () => {
      throw new Error("Failed to fetch");
    });
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });
    await lifecycleService.checkAssistant();
    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "error",
    );

    // Next check (fired by the armed retry timer) succeeds.
    getAssistantMock.mockImplementationOnce(async () =>
      activeResult("asst-recovered"),
    );

    await waitFor(
      () =>
        useAssistantLifecycleStore.getState().assistantState.kind === "active",
      1000,
    );
    expect(
      useResolvedAssistantsStore.getState().activeAssistantId,
    ).toBe("asst-recovered");
  });

  test("app.online retries a transient error immediately, ahead of the backoff timer", async () => {
    getAssistantMock.mockImplementationOnce(async () => {
      throw new Error("Failed to fetch");
    });
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });
    await lifecycleService.checkAssistant();
    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "error",
    );
    const callsBefore = getAssistantMock.mock.calls.length;
    getAssistantMock.mockImplementationOnce(async () =>
      activeResult("asst-online"),
    );

    publish("app.online", {});

    // The re-check starts synchronously from the online signal — no
    // backoff wait involved.
    expect(getAssistantMock.mock.calls.length).toBe(callsBefore + 1);
    await waitFor(
      () =>
        useAssistantLifecycleStore.getState().assistantState.kind === "active",
      1000,
    );
  });

  test("non-transient error does not auto-retry", async () => {
    getAssistantMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 500,
      error: { detail: "Internal server error" },
    }));
    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });
    await lifecycleService.checkAssistant();
    const callsAfterError = getAssistantMock.mock.calls.length;

    // Give a would-be retry timer ample time to fire.
    await new Promise((resolve) =>
      setTimeout(resolve, TEST_ERROR_RETRY_DELAY_MS * 2),
    );

    expect(getAssistantMock.mock.calls.length).toBe(callsAfterError);
    expect(useAssistantLifecycleStore.getState().assistantState).toMatchObject({
      kind: "error",
      message: "Internal server error",
    });
  });
});
