import { beforeEach, describe, expect, mock, test } from "bun:test";

type MockSessionUser = {
  id?: string;
  username?: string;
  email?: string;
};

let sessionUser: MockSessionUser | null = null;
let getSessionCallCount = 0;
let getSessionFailFirstCall = false;
// When set to an array, each `getSession` call blocks until its release fn
// (pushed here in call order) is invoked, so a test can hold one or more
// probes in flight and settle them in a chosen order.
let getSessionGates: Array<() => void> | null = null;

let mockIsGatewayAuth = false;
let mockIsLocalMode = false;
let mockPlatformAssistants: unknown[] = [];
let mockPrimeError: Error | null = null;
const setSelectedAssistantIdMock = mock((_id: string) => {});
const primeLocalGatewayConnectionMock = mock(async () => {
  if (mockPrimeError) throw mockPrimeError;
});
const primeLocalGatewayConnectionWithRepairMock = mock(async () => {
  if (mockPrimeError) throw mockPrimeError;
});
const restoreConsentForUserMock = mock((_userId: string | null) => ({ tos: false, ai: false }));
const persistConsentForUserMock = mock((_userId: string | null, _tos: boolean, _ai: boolean) => {});
const resolveServerConsentMock = mock((_consent: unknown) => ({
  tos: false, ai: false, shareAnalytics: null, shareDiagnostics: null,
}));

let mockFetchMeResult: unknown = { id: "user-1", username: "test", email: "test@example.com", first_name: "", last_name: "", consent: null };
let mockFetchMeError: Error | null = null;
const fetchMeMock = mock(async () => {
  if (mockFetchMeError) throw mockFetchMeError;
  return mockFetchMeResult;
});
const clearOrganizationMock = mock(() => {});
const logoutMock = mock(async () => {});
const deleteBiometricTokenMock = mock(async () => {});

let mockIsNativePlatform = false;
let mockIsBiometricEnabled = false;
let mockBiometricToken: string | null = null;
const installSessionCookiesMock = mock((_token: string) => {});
const retrieveBiometricTokenMock = mock(async () => mockBiometricToken);

// Controls the managed-assistant list returned to the lockfile-sync path and
// spies on the sync itself. Default `listAssistants` to the legacy `[]` shape
// (whose missing `.ok` short-circuits the sync) so existing tests are
// unaffected; the reconciliation tests override it to a well-formed result.
let mockListAssistantsResult: unknown = [];
const listAssistantsMock = mock(async () => mockListAssistantsResult);
const syncPlatformAssistantsToLockfileMock = mock(async (_list: unknown) => {});

mock.module("@/lib/auth/allauth-client", () => ({
  getSession: async () => {
    getSessionCallCount++;
    if (getSessionGates) {
      await new Promise<void>((resolve) => {
        getSessionGates!.push(resolve);
      });
    }
    if (getSessionFailFirstCall && getSessionCallCount === 1) {
      return { ok: false, status: 401, error: { detail: "Unauthorized" } };
    }
    if (!sessionUser) {
      return { ok: false, status: 401, error: { detail: "Unauthorized" } };
    }
    return { ok: true, data: { user: sessionUser } };
  },
  logout: logoutMock,
}));

mock.module("@/lib/auth/gateway-session", () => ({
  isGatewayAuthEnabled: () => mockIsGatewayAuth,
  isGatewayAuthMode: () => mockIsGatewayAuth,
  ensureGatewayToken: async () => {},
  clearGatewayToken: () => {},
  getLocalTokenUrl: () => "http://localhost/token",
}));

mock.module("@/lib/local-mode", () => ({
  isLocalMode: () => mockIsLocalMode,
  isLocalAssistant: (a: { cloud?: string; resources?: { gatewayPort?: number } }) =>
    a.cloud !== "vellum" && a.resources?.gatewayPort != null,
  isPlatformAssistant: (a: { cloud?: string }) => a.cloud === "vellum",
  getPlatformAssistants: () => mockPlatformAssistants,
  getLocalAssistants: () => [],
  clearSelectedAssistant: () => {},
  setSelectedAssistantId: setSelectedAssistantIdMock,
  primeLocalGatewayConnection: primeLocalGatewayConnectionMock,
  primeLocalGatewayConnectionWithRepair:
    primeLocalGatewayConnectionWithRepairMock,
  syncPlatformAssistantsToLockfile: syncPlatformAssistantsToLockfileMock,
}));

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => mockIsNativePlatform,
  isOAuthFlowInFlight: () => false,
  installSessionCookies: installSessionCookiesMock,
  waitForNativeSessionCookie: async () => {},
}));

mock.module("@/runtime/native-biometric", () => ({
  deleteBiometricToken: deleteBiometricTokenMock,
  isBiometricEnabled: () => mockIsBiometricEnabled,
  retrieveBiometricToken: retrieveBiometricTokenMock,
}));

const clearUserScopedStorageMock = mock(() => {});

const patchConsentMock = mock(async (_consent: unknown) => {});

mock.module("@/domains/account/profile", () => ({
  fetchMe: fetchMeMock,
  patchConsent: patchConsentMock,
}));

mock.module("@/utils/onboarding-cleanup", () => ({
  restoreConsentForUser: restoreConsentForUserMock,
  persistConsentForUser: persistConsentForUserMock,
  resolveServerConsent: resolveServerConsentMock,
  CONSENT_VERSION: "2026-06-08",
}));

mock.module("@/domains/onboarding/onboarding-store", () => ({
  useOnboardingStore: {
    getState: () => ({
      setTosAccepted: () => {},
      setAiDataConsent: () => {},
      setShareAnalytics: () => {},
      setShareDiagnostics: () => {},
    }),
  },
}));

mock.module("@/lib/auth/session-cleanup", () => ({
  clearUserScopedStorage: clearUserScopedStorageMock,
}));

mock.module("@/stores/organization-store", () => ({
  clearOrganization: clearOrganizationMock,
  useOrganizationStore: {
    getState: () => ({
      fetchOrganizations: async () => {},
    }),
  },
}));

// Don't mock `@/lib/event-bus` — bun's `mock.module` is process-
// global, so any stub here shadows the real bus for every later
// test file in the run. `auth-store` only subscribes to `app.resume`
// at module load; the real bus's `subscribe` returns an unsubscribe
// and the registered handler stays inert in tests that don't publish
// `app.resume`.

const lifecycleResetForLogoutMock = mock(() => {});
mock.module("@/assistant/lifecycle-service", () => ({
  lifecycleService: {
    resetForLogout: lifecycleResetForLogoutMock,
  },
}));

// `@/assistant/api` transitively pulls in `@vellumai/assistant-api`
// exports that are currently missing on main. Mock the call sites
// `auth-store` actually uses; the real module load would crash
// before any test runs.
mock.module("@/assistant/api", () => ({
  listAssistants: listAssistantsMock,
}));

const { useAuthStore } = await import("@/stores/auth-store");

function resetAuthStore(): void {
  useAuthStore.setState({
    sessionStatus: "initializing",
    user: null,
    platformSession: "unknown",
  });
}

beforeEach(() => {
  sessionUser = null;
  getSessionCallCount = 0;
  getSessionFailFirstCall = false;
  getSessionGates = null;
  mockIsGatewayAuth = false;
  mockIsLocalMode = false;
  mockPlatformAssistants = [];
  mockIsNativePlatform = false;
  mockIsBiometricEnabled = false;
  mockBiometricToken = null;
  mockPrimeError = null;
  setSelectedAssistantIdMock.mockClear();
  primeLocalGatewayConnectionMock.mockClear();
  primeLocalGatewayConnectionWithRepairMock.mockClear();
  restoreConsentForUserMock.mockClear();
  persistConsentForUserMock.mockClear();
  resolveServerConsentMock.mockClear();
  fetchMeMock.mockClear();
  patchConsentMock.mockClear();
  mockFetchMeResult = { id: "user-1", username: "test", email: "test@example.com", first_name: "", last_name: "", consent: null };
  mockFetchMeError = null;
  clearOrganizationMock.mockClear();
  clearUserScopedStorageMock.mockClear();
  logoutMock.mockClear();
  deleteBiometricTokenMock.mockClear();
  installSessionCookiesMock.mockClear();
  retrieveBiometricTokenMock.mockClear();
  lifecycleResetForLogoutMock.mockClear();
  mockListAssistantsResult = [];
  listAssistantsMock.mockClear();
  syncPlatformAssistantsToLockfileMock.mockClear();
  resetAuthStore();
});

describe("auth store onboarding flag reconciliation", () => {
  test("initSession uses server consent when server has a consent record", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockFetchMeResult = {
      id: "user-1", username: "test", email: "test@example.com",
      first_name: "", last_name: "",
      consent: { tos_accepted_version: "2026-06-08", privacy_policy_accepted_version: "2026-06-08", ai_data_sharing_accepted_version: "2026-06-08", share_analytics: true, share_diagnostics: true },
    };

    await useAuthStore.getState().initSession();

    expect(fetchMeMock).toHaveBeenCalled();
    expect(resolveServerConsentMock).toHaveBeenCalled();
    expect(restoreConsentForUserMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
  });

  test("initSession falls through to device keys when server consent is null", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };

    await useAuthStore.getState().initSession();

    expect(fetchMeMock).toHaveBeenCalled();
    expect(resolveServerConsentMock).not.toHaveBeenCalled();
    expect(restoreConsentForUserMock).toHaveBeenCalledWith("user-1");
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
  });

  test("initSession backfills server when device keys show prior consent and server has no record", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };
    restoreConsentForUserMock.mockReturnValueOnce({ tos: true, ai: true });

    await useAuthStore.getState().initSession();

    expect(patchConsentMock).toHaveBeenCalled();
  });

  test("initSession falls back to device keys when fetchMe fails", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockFetchMeError = new Error("Network error");

    await useAuthStore.getState().initSession();

    expect(fetchMeMock).toHaveBeenCalled();
    expect(restoreConsentForUserMock).toHaveBeenCalledWith("user-1");
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
  });

  test("initSession fetches server consent for local-mode platform sessions", async () => {
    mockIsLocalMode = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockPlatformAssistants = [{ assistantId: "p1", cloud: "vellum" }];
    mockFetchMeResult = {
      id: "user-1", username: "test", email: "test@example.com",
      first_name: "", last_name: "",
      consent: { tos_accepted_version: "2026-06-08", privacy_policy_accepted_version: "2026-06-08", ai_data_sharing_accepted_version: "2026-06-08", share_analytics: true, share_diagnostics: true },
    };

    await useAuthStore.getState().initSession();

    expect(fetchMeMock).toHaveBeenCalled();
    expect(resolveServerConsentMock).toHaveBeenCalled();
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
  });

  test("refreshSession fetches consent from server for platform users", async () => {
    sessionUser = { id: "user-2", email: "user@example.com" };
    mockFetchMeResult = {
      id: "user-2", username: "test", email: "user@example.com",
      first_name: "", last_name: "",
      consent: { tos_accepted_version: "2026-06-08", privacy_policy_accepted_version: "2026-06-08", ai_data_sharing_accepted_version: "2026-06-08", share_analytics: true, share_diagnostics: true },
    };

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(fetchMeMock).toHaveBeenCalled();
    expect(resolveServerConsentMock).toHaveBeenCalled();
    expect(useAuthStore.getState().user?.id).toBe("user-2");
  });

  test("refreshSession reconciles the lockfile mirror in local mode", async () => {
    // Regression: a session refresh (app resume, profile save, provider
    // callback) must re-sync managed assistants into the lockfile — not only
    // cold `initSession` — so the macOS tray and CLI don't keep a stale list
    // until the next full boot.
    mockIsLocalMode = true;
    sessionUser = { id: "user-3", email: "user@example.com" };
    mockListAssistantsResult = {
      ok: true,
      status: 200,
      data: [{ id: "assistant-3", is_local: false, created: "2026-06-05T00:00:00Z" }],
    };

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(listAssistantsMock).toHaveBeenCalled();
    expect(syncPlatformAssistantsToLockfileMock).toHaveBeenCalledWith([
      { id: "assistant-3", is_local: false, created: "2026-06-05T00:00:00Z" },
    ]);
  });

  test("refreshSession skips lockfile sync outside local mode", async () => {
    // Platform mode has no lockfile host — the sync must not run there.
    mockIsLocalMode = false;
    sessionUser = { id: "user-4", email: "user@example.com" };
    mockListAssistantsResult = {
      ok: true,
      status: 200,
      data: [{ id: "assistant-4", is_local: false, created: "2026-06-05T00:00:00Z" }],
    };

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(syncPlatformAssistantsToLockfileMock).not.toHaveBeenCalled();
  });

  test("logout does not clear consent flags (durable device keys survive)", async () => {
    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });
});

describe("session cleanup on logout", () => {
  test("logout clears biometric token", async () => {
    await useAuthStore.getState().logout();

    expect(deleteBiometricTokenMock).toHaveBeenCalled();
  });

  test("logout clears organization state", async () => {
    await useAuthStore.getState().logout();

    expect(clearOrganizationMock).toHaveBeenCalled();
  });

  test("logout clears user-scoped browser storage", async () => {
    await useAuthStore.getState().logout();

    expect(clearUserScopedStorageMock).toHaveBeenCalled();
  });

  test("logout clears assistant lifecycle synchronously, before leaving authenticated", async () => {
    // The lifecycle reset must happen before the auth state flips,
    // otherwise sync hooks like `useAssistantResourceSync` get one
    // re-render with the previous user's assistant id and fire
    // requests that 401. The order is verified by recording the
    // session status seen at reset time vs the final transition.
    let statusAtResetTime = useAuthStore.getState().sessionStatus;
    lifecycleResetForLogoutMock.mockImplementationOnce(() => {
      statusAtResetTime = useAuthStore.getState().sessionStatus;
    });
    useAuthStore.setState({ sessionStatus: "authenticated" });

    await useAuthStore.getState().logout();

    expect(lifecycleResetForLogoutMock).toHaveBeenCalledTimes(1);
    expect(statusAtResetTime).toBe("authenticated");
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });
});

describe("platform session probe resolution", () => {
  // A returning local-gateway user re-runs the platform probe on app resume.
  // The probe must NOT reopen the "unknown" window: it leaves the last-known
  // "present"/"absent" in place until the new result lands, so a cached
  // platform assistant keeps standing in for the session and reactive
  // consumers don't flicker mid-session.
  test("a re-run gateway probe retains the last status until it settles", async () => {
    mockIsGatewayAuth = true;
    mockIsLocalMode = false;
    sessionUser = { id: "user-1", email: "user@example.com" };
    useAuthStore.setState({ platformSession: "absent" });

    const gates: Array<() => void> = [];
    getSessionGates = gates;

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    // Probe launched but not settled: the prior status is retained, not reset
    // to "unknown".
    expect(useAuthStore.getState().platformSession).toBe("absent");

    gates[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useAuthStore.getState().platformSession).toBe("present");
  });

  // Two probes can overlap — an app-resume refresh firing while the initial
  // probe is still in flight. If a slower earlier probe settles after a newer
  // one starts, its result must be discarded so it can't overwrite the newer
  // probe's outcome.
  test("a stale probe completing after a newer one does not change status", async () => {
    mockIsGatewayAuth = true;
    mockIsLocalMode = false;
    sessionUser = { id: "user-1", email: "user@example.com" };
    useAuthStore.setState({ platformSession: "absent" });

    const gates: Array<() => void> = [];
    getSessionGates = gates;

    // Launch two overlapping probes; neither has settled, so the prior status
    // is still retained.
    await useAuthStore.getState().refreshSession();
    await useAuthStore.getState().refreshSession();
    expect(gates.length).toBe(2);
    expect(useAuthStore.getState().platformSession).toBe("absent");

    // Settle the older probe first: it is stale, so it must not write status.
    gates[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useAuthStore.getState().platformSession).toBe("absent");

    // The newest probe settling is what moves status to "present".
    gates[1]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useAuthStore.getState().platformSession).toBe("present");
  });

});

describe("biometric session recovery", () => {
  test("initSession falls through to biometric recovery on native when session probe fails", async () => {
    mockIsNativePlatform = true;
    mockIsBiometricEnabled = true;
    mockBiometricToken = "recovered-session-token";
    sessionUser = { id: "user-1", email: "user@example.com" };
    getSessionFailFirstCall = true;

    await useAuthStore.getState().initSession();

    expect(installSessionCookiesMock).toHaveBeenCalledWith(
      "recovered-session-token",
    );
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().user?.id).toBe("user-1");
  });

  test("initSession skips biometric recovery on web", async () => {
    mockIsNativePlatform = false;
    sessionUser = null;

    await useAuthStore.getState().initSession();

    expect(retrieveBiometricTokenMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });

  test("initSession skips biometric recovery when biometrics disabled", async () => {
    mockIsNativePlatform = true;
    mockIsBiometricEnabled = false;
    sessionUser = null;

    await useAuthStore.getState().initSession();

    expect(retrieveBiometricTokenMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });

  test("initSession falls through to unauthenticated when biometric token is expired", async () => {
    mockIsNativePlatform = true;
    mockIsBiometricEnabled = true;
    mockBiometricToken = "expired-token";
    sessionUser = null;

    await useAuthStore.getState().initSession();

    expect(installSessionCookiesMock).toHaveBeenCalledWith("expired-token");
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
    expect(useAuthStore.getState().user).toBeNull();
  });
});

describe("connectLocalAssistant", () => {
  test("selects the assistant, primes the connection, and logs in", async () => {
    mockIsLocalMode = true;
    mockPlatformAssistants = [];

    await useAuthStore.getState().connectLocalAssistant("local-a");

    expect(setSelectedAssistantIdMock).toHaveBeenCalledWith("local-a");
    expect(primeLocalGatewayConnectionWithRepairMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().user?.id).toBe("gateway-local");
    // No platform assistants — nothing to probe, so the status settles
    // directly to "absent" rather than staying "unknown".
    expect(useAuthStore.getState().platformSession).toBe("absent");
  });

  test("rethrows the prime failure without marking the session logged in", async () => {
    mockIsLocalMode = true;
    mockPrimeError = new Error("Guardian token not found");

    await expect(
      useAuthStore.getState().connectLocalAssistant("local-a"),
    ).rejects.toThrow("Guardian token not found");

    expect(setSelectedAssistantIdMock).toHaveBeenCalledWith("local-a");
    expect(useAuthStore.getState().sessionStatus).not.toBe("authenticated");
  });
});
