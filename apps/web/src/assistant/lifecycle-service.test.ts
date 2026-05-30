/**
 * Direct unit tests for the lifecycle state machine — no React tree,
 * no `renderHook`. Demonstrates the testability that moving the
 * machine out of React unlocks.
 *
 * Side-effect helpers (`setSelfHostedConnection`, `isGatewayAuthMode`,
 * etc.) are mocked at module scope. API calls go through mock
 * versions of `getAssistant` / `hatchAssistant` / `retireAssistantById`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";

// --- module mocks --- //

const getAssistantMock = mock(async () => ({ ok: false, status: 404 }));
const hatchAssistantMock = mock(
  async (
    _opts?: { version?: string },
  ): Promise<
    | { ok: true; status: number; data: { id: string; status?: string } }
    | { ok: false; status: number; error?: { message?: string } }
  > => ({ ok: true, status: 201, data: { id: "asst-1" } }),
);
const retireAssistantMock = mock(async () => ({ ok: true, status: 200 }));

mock.module("@/assistant/api", () => ({
  getAssistant: getAssistantMock,
  hatchAssistant: hatchAssistantMock,
  retireAssistantById: retireAssistantMock,
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
mock.module("@/lib/local-mode", () => ({
  isLocalMode: isLocalModeMock,
  getSelectedAssistant: () => null,
  getLocalGatewayUrl: () => null,
}));

// Sentry is a side-effect-only dep here; silence it.
mock.module("@sentry/react", () => ({
  captureException: () => {},
  captureMessage: () => {},
}));

// --- imports under test --- //

const { lifecycleService } = await import("./lifecycle-service");
const { useAssistantLifecycleStore } = await import("./lifecycle-store");
const { useAssistantSelectionStore } = await import("./selection-store");

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
  isLoggedIn: true,
  isLoading: false,
  isRetired: false,
  isNonProduction: false,
  hasPlatformSession: true,
  onRedirect: () => {},
  resolveOnboardingRedirect: () => null,
};

beforeEach(() => {
  getAssistantMock.mockClear();
  hatchAssistantMock.mockClear();
  retireAssistantMock.mockClear();
  setSelfHostedConnectionMock.mockClear();
  // Re-baseline implementations every test so a `mockImplementationOnce`
  // or `mockImplementation` from a prior test doesn't leak.
  // `mockClear` resets only the call history, not the implementation —
  // any new mocked dep added here MUST re-set its baseline below or
  // tests will silently inherit the previous test's stub.
  isGatewayAuthModeMock.mockImplementation(() => false);
  isLocalModeMock.mockImplementation(() => false);
  hatchAssistantMock.mockImplementation(async () => ({
    ok: true,
    status: 201,
    data: { id: "asst-1" },
  }));
  getAssistantMock.mockImplementation(async () => ({ ok: false, status: 404 }));
  lifecycleService.__resetForTesting();
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
      useAssistantSelectionStore.getState().activeAssistantId,
    ).toBe("asst-1");
    expect(useAssistantLifecycleStore.getState().assistantState).toEqual({
      kind: "active",
      isLocal: false,
      maintenanceMode: { enabled: false },
    });
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
      useAssistantSelectionStore.getState().activeAssistantId,
    ).toBe("asst-local-1");
    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "self_hosted",
    );
  });
});

describe("lifecycleService — bootstrap branches", () => {
  test("logout clears both stores", async () => {
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

    // Now flip isLoggedIn false and reconcile.
    lifecycleService.setInputs({
      ...baseInputs,
      isLoggedIn: false,
      queryClient: makeQueryClient(),
    });
    await lifecycleService.respondToInputs();

    expect(
      useAssistantSelectionStore.getState().activeAssistantId,
    ).toBeNull();
    expect(useAssistantLifecycleStore.getState().assistantState).toEqual({
      kind: "loading",
    });
  });

  test("gateway-auth short-circuit writes active state without calling the server", async () => {
    isGatewayAuthModeMock.mockImplementation(() => true);

    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });
    await lifecycleService.respondToInputs();

    expect(getAssistantMock).not.toHaveBeenCalled();
    expect(useAssistantLifecycleStore.getState().assistantState).toEqual({
      kind: "active",
      isLocal: true,
    });
  });
});

describe("lifecycleService — auto-hatch cascade", () => {
  test("404 → auto_hatch path issues hatchAssistant and lands the seeded id", async () => {
    // checkAssistant fetches the cache, gets a 404, which
    // resolves to `auto_hatch`. With no onboarding redirect and
    // isNonProduction=false, the service then issues hatchAssistant,
    // which succeeds and seeds the cache.
    getAssistantMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 404,
    }));
    hatchAssistantMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 201,
      data: { id: "asst-hatched-1", status: "initializing" },
    }));

    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });
    await lifecycleService.checkAssistant();

    expect(hatchAssistantMock).toHaveBeenCalledTimes(1);
    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "initializing",
    );
  });

  test("auto_hatch + nonprod transitions to awaiting_version_selection instead of hatching", async () => {
    getAssistantMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 404,
    }));

    lifecycleService.setInputs({
      ...baseInputs,
      isNonProduction: true,
      queryClient: makeQueryClient(),
    });
    await lifecycleService.checkAssistant();

    expect(hatchAssistantMock).not.toHaveBeenCalled();
    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "awaiting_version_selection",
    );
  });

  test("auto_hatch + isRetired transitions to retired (no hatch)", async () => {
    getAssistantMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 404,
    }));

    lifecycleService.setInputs({
      ...baseInputs,
      isRetired: true,
      queryClient: makeQueryClient(),
    });
    await lifecycleService.checkAssistant();

    expect(hatchAssistantMock).not.toHaveBeenCalled();
    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "retired",
    );
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

describe("lifecycleService — retry budget exhaustion", () => {
  test("3 recoverable hatch failures in the auto-hatch poll loop surface as error", async () => {
    // Server says 404 (no assistant) → service hits the auto_hatch
    // branch → calls hatchAssistant. The mock returns a recoverable
    // 5xx, so each pass increments `hatchRetryCount` without ever
    // succeeding. Three failed `checkAssistant`s reach the budget;
    // the fourth surfaces the terminal error state.
    getAssistantMock.mockImplementation(async () => ({
      ok: false,
      status: 404,
    }));
    hatchAssistantMock.mockImplementation(async () => ({
      ok: false,
      status: 502,
      error: { message: "bad gateway" },
    }));

    lifecycleService.setInputs({
      ...baseInputs,
      queryClient: makeQueryClient(),
    });

    await lifecycleService.checkAssistant();
    await lifecycleService.checkAssistant();
    await lifecycleService.checkAssistant();
    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "initializing",
    );

    await lifecycleService.checkAssistant();
    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "error",
    );
  });
});

