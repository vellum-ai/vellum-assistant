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

