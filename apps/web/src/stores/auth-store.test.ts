import { beforeEach, describe, expect, mock, test } from "bun:test";

type MockSessionUser = {
  id?: string;
  username?: string;
  email?: string;
};

let sessionUser: MockSessionUser | null = null;
let getSessionCallCount = 0;
let getSessionFailFirstCall = false;
// Transport-failure controls: `getSessionThrows` simulates a fetch
// rejection; `getSessionFailStatus` sets the status of the !sessionUser
// failure result (401 = settled "no session"; 429/502 = non-authoritative).
let getSessionThrows = false;
let getSessionFailStatus: number | undefined = 401;
// When set to an array, each `getSession` call blocks until its release fn
// (pushed here in call order) is invoked, so a test can hold one or more
// probes in flight and settle them in a chosen order.
let getSessionGates: Array<() => void> | null = null;

let mockIsGatewayAuth = false;
let mockIsLocalMode = false;
let mockIsRemoteGatewayMode = false;
let mockPlatformAssistants: unknown[] = [];
let mockPrimeError: Error | null = null;
const setSelectedAssistantMock = mock(async (_id: string | null) => {});
const setFromApiMock = mock((_assistants: unknown) => {});
const primeLocalGatewayConnectionMock = mock(async () => {
  if (mockPrimeError) throw mockPrimeError;
});
const primeLocalGatewayConnectionWithRepairMock = mock(async () => {
  if (mockPrimeError) throw mockPrimeError;
});
const ensureGatewayTokenMock = mock(async () => {});
const restoreConsentForUserMock = mock((_userId: string | null) => ({
  tos: false,
  ai: false,
}));
const persistConsentForUserMock = mock(
  (_userId: string | null, _tos: boolean, _ai: boolean) => {},
);
const resolveServerConsentMock = mock((_consent: unknown) => ({
  tos: false,
  ai: false,
  shareAnalytics: null,
  shareDiagnostics: null,
}));

let mockFetchMeResult: unknown = {
  id: "user-1",
  username: "test",
  email: "test@example.com",
  first_name: "",
  last_name: "",
  consent: null,
};
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
const syncPlatformAssistantsToLockfileMock = mock(
  async (_list: unknown, _orgId?: string) => {},
);

mock.module("@/lib/auth/allauth-client", () => ({
  getSession: async () => {
    getSessionCallCount++;
    if (getSessionGates) {
      await new Promise<void>((resolve) => {
        getSessionGates!.push(resolve);
      });
    }
    if (getSessionThrows) {
      throw new TypeError("Failed to fetch");
    }
    if (getSessionFailFirstCall && getSessionCallCount === 1) {
      return { ok: false, status: 401, error: { detail: "Unauthorized" } };
    }
    if (!sessionUser) {
      return {
        ok: false,
        status: getSessionFailStatus,
        error: { detail: "Unauthorized" },
      };
    }
    return { ok: true, data: { user: sessionUser } };
  },
  logout: logoutMock,
}));

let mockElectronSessionToken: string | null = null;
mock.module("@/runtime/session-token", () => ({
  getElectronSessionToken: () => mockElectronSessionToken,
  primeElectronSessionToken: () => {},
  __resetForTesting: () => {},
}));

mock.module("@/lib/auth/gateway-session", () => ({
  isGatewayAuthEnabled: () => mockIsGatewayAuth,
  isGatewayAuthMode: () => mockIsGatewayAuth,
  ensureGatewayToken: ensureGatewayTokenMock,
  clearGatewayToken: () => {},
  getLocalTokenUrl: () => "http://localhost/token",
}));

mock.module("@/lib/local-mode", () => ({
  isLocalMode: () => mockIsLocalMode,
  isRemoteGatewayMode: () => mockIsRemoteGatewayMode,
  isLocalAssistant: (a: {
    cloud?: string;
    resources?: { gatewayPort?: number };
  }) => a.cloud !== "vellum" && a.resources?.gatewayPort != null,
  isPlatformAssistant: (a: { cloud?: string }) => a.cloud === "vellum",
  getPlatformAssistants: () => mockPlatformAssistants,
  getLocalAssistants: () => [],
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

mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    getState: () => ({
      setFromApi: setFromApiMock,
    }),
  },
}));

// Auth-store writes the selection through the public wrapper, not the store
// action — mock the wrapper module so the real one (and its local-mode deps)
// never loads.
mock.module("@/assistant/selection", () => ({
  setSelectedAssistant: setSelectedAssistantMock,
}));

mock.module("@/stores/organization-store", () => ({
  clearOrganization: clearOrganizationMock,
  useOrganizationStore: {
    getState: () => ({
      fetchOrganizations: async () => {},
      currentOrganizationId: "org-test",
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
const lifecycleCheckAssistantMock = mock(async () => {});
mock.module("@/assistant/lifecycle-service", () => ({
  lifecycleService: {
    resetForLogout: lifecycleResetForLogoutMock,
    checkAssistant: lifecycleCheckAssistantMock,
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
  getSessionThrows = false;
  getSessionFailStatus = 401;
  getSessionGates = null;
  mockElectronSessionToken = null;
  localStorage.removeItem("vellum:auth:userSnapshot");
  mockIsGatewayAuth = false;
  mockIsLocalMode = false;
  mockIsRemoteGatewayMode = false;
  mockPlatformAssistants = [];
  mockIsNativePlatform = false;
  mockIsBiometricEnabled = false;
  mockBiometricToken = null;
  mockPrimeError = null;
  setSelectedAssistantMock.mockClear();
  setFromApiMock.mockClear();
  primeLocalGatewayConnectionMock.mockClear();
  primeLocalGatewayConnectionWithRepairMock.mockClear();
  ensureGatewayTokenMock.mockClear();
  restoreConsentForUserMock.mockClear();
  persistConsentForUserMock.mockClear();
  resolveServerConsentMock.mockClear();
  fetchMeMock.mockClear();
  patchConsentMock.mockClear();
  mockFetchMeResult = {
    id: "user-1",
    username: "test",
    email: "test@example.com",
    first_name: "",
    last_name: "",
    consent: null,
  };
  mockFetchMeError = null;
  clearOrganizationMock.mockClear();
  clearUserScopedStorageMock.mockClear();
  logoutMock.mockClear();
  deleteBiometricTokenMock.mockClear();
  installSessionCookiesMock.mockClear();
  retrieveBiometricTokenMock.mockClear();
  lifecycleResetForLogoutMock.mockClear();
  lifecycleCheckAssistantMock.mockClear();
  mockListAssistantsResult = [];
  listAssistantsMock.mockClear();
  syncPlatformAssistantsToLockfileMock.mockClear();
  resetAuthStore();
});

describe("auth store onboarding flag reconciliation", () => {
  test("initSession treats remote-gateway mode as an authenticated local session", async () => {
    mockIsRemoteGatewayMode = true;

    await useAuthStore.getState().initSession();

    expect(primeLocalGatewayConnectionMock).not.toHaveBeenCalled();
    expect(getSessionCallCount).toBe(0);
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().user?.id).toBe("gateway-local");
    expect(useAuthStore.getState().platformSession).toBe("absent");
  });

  test("refreshSession keeps remote-gateway mode authenticated without minting a local token", async () => {
    mockIsRemoteGatewayMode = true;
    mockIsGatewayAuth = true;

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(ensureGatewayTokenMock).not.toHaveBeenCalled();
    expect(primeLocalGatewayConnectionMock).not.toHaveBeenCalled();
    expect(getSessionCallCount).toBe(0);
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().user?.id).toBe("gateway-local");
    expect(useAuthStore.getState().platformSession).toBe("absent");
  });

  test("initSession uses server consent when server has a consent record", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockFetchMeResult = {
      id: "user-1",
      username: "test",
      email: "test@example.com",
      first_name: "",
      last_name: "",
      consent: {
        tos_accepted_version: "2026-06-08",
        privacy_policy_accepted_version: "2026-06-08",
        ai_data_sharing_accepted_version: "2026-06-08",
        share_analytics: true,
        share_diagnostics: true,
      },
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
      id: "user-1",
      username: "test",
      email: "test@example.com",
      first_name: "",
      last_name: "",
      consent: {
        tos_accepted_version: "2026-06-08",
        privacy_policy_accepted_version: "2026-06-08",
        ai_data_sharing_accepted_version: "2026-06-08",
        share_analytics: true,
        share_diagnostics: true,
      },
    };

    await useAuthStore.getState().initSession();

    expect(fetchMeMock).toHaveBeenCalled();
    expect(resolveServerConsentMock).toHaveBeenCalled();
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
  });

  test("refreshSession fetches consent from server for platform users", async () => {
    sessionUser = { id: "user-2", email: "user@example.com" };
    mockFetchMeResult = {
      id: "user-2",
      username: "test",
      email: "user@example.com",
      first_name: "",
      last_name: "",
      consent: {
        tos_accepted_version: "2026-06-08",
        privacy_policy_accepted_version: "2026-06-08",
        ai_data_sharing_accepted_version: "2026-06-08",
        share_analytics: true,
        share_diagnostics: true,
      },
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
      data: [
        {
          id: "assistant-3",
          name: "My Assistant",
          is_local: false,
          created: "2026-06-05T00:00:00Z",
        },
      ],
    };

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(listAssistantsMock).toHaveBeenCalled();
    expect(syncPlatformAssistantsToLockfileMock).toHaveBeenCalledWith(
      [
        {
          id: "assistant-3",
          name: "My Assistant",
          is_local: false,
          created: "2026-06-05T00:00:00Z",
        },
      ],
      "org-test",
    );
  });

  test("refreshSession skips lockfile sync outside local mode", async () => {
    // Platform mode has no lockfile host — the sync must not run there.
    mockIsLocalMode = false;
    sessionUser = { id: "user-4", email: "user@example.com" };
    mockListAssistantsResult = {
      ok: true,
      status: 200,
      data: [
        { id: "assistant-4", is_local: false, created: "2026-06-05T00:00:00Z" },
      ],
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

  // The lifecycle reset must run BEFORE the selection clear in both branches:
  // the lifecycle's selection subscription skips writes while the state is
  // `loading`, so this order is what prevents the clear from resurrecting an
  // active state mid-logout.
  test("gateway logout resets the lifecycle before clearing the selection", async () => {
    mockIsGatewayAuth = true;
    useAuthStore.setState({ sessionStatus: "authenticated" });
    const order: string[] = [];
    lifecycleResetForLogoutMock.mockImplementationOnce(() => {
      order.push("reset");
    });
    setSelectedAssistantMock.mockImplementationOnce(async (id) => {
      order.push(`clear:${String(id)}`);
    });

    await useAuthStore.getState().logout();

    expect(order).toEqual(["reset", "clear:null"]);
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });

  test("non-gateway logout clears the selection slice after the lifecycle reset", async () => {
    const order: string[] = [];
    lifecycleResetForLogoutMock.mockImplementationOnce(() => {
      order.push("reset");
    });
    setSelectedAssistantMock.mockImplementationOnce(async (id) => {
      order.push(`clear:${String(id)}`);
    });

    await useAuthStore.getState().logout();

    expect(order).toEqual(["reset", "clear:null"]);
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
  test("primes the connection BEFORE selecting the assistant, then logs in", async () => {
    mockIsLocalMode = true;
    mockPlatformAssistants = [];
    // Prime must complete before the selection write becomes observable —
    // the lifecycle's selection subscription republishes the connection
    // synchronously on the write, with whatever token is cached.
    const order: string[] = [];
    primeLocalGatewayConnectionWithRepairMock.mockImplementationOnce(
      async () => {
        order.push("prime");
      },
    );
    setSelectedAssistantMock.mockImplementationOnce(async (id) => {
      order.push(`select:${String(id)}`);
    });

    await useAuthStore.getState().connectLocalAssistant("local-a");

    expect(order).toEqual(["prime", "select:local-a"]);
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().user?.id).toBe("gateway-local");
    // No platform assistants — nothing to probe, so the status settles
    // directly to "absent" rather than staying "unknown".
    expect(useAuthStore.getState().platformSession).toBe("absent");
  });

  test("drives the lifecycle to publish active state, even when the selection is unchanged", async () => {
    // The lifecycle's selection subscription only republishes
    // `activeAssistantId` when `selectedAssistantId` changes. Reconnecting to
    // the already-selected assistant — the common case after guardian-token
    // repair retries the same assistant — would otherwise leave the active id
    // stale, so `connectLocalAssistant` must drive `checkAssistant()` itself.
    mockIsLocalMode = true;
    mockPlatformAssistants = [];
    // setSelectedAssistant is a no-op write here (already selected); the only
    // thing that publishes active state is the explicit checkAssistant call.
    setSelectedAssistantMock.mockImplementationOnce(async () => {});

    await useAuthStore.getState().connectLocalAssistant("local-a");

    expect(lifecycleCheckAssistantMock).toHaveBeenCalledTimes(1);
  });

  test("rethrows the prime failure without selecting or marking the session logged in", async () => {
    mockIsLocalMode = true;
    mockPrimeError = new Error("Guardian token not found");

    await expect(
      useAuthStore.getState().connectLocalAssistant("local-a"),
    ).rejects.toThrow("Guardian token not found");

    // A failed connect leaves the previous selection in place.
    expect(setSelectedAssistantMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().sessionStatus).not.toBe("authenticated");
  });
});

// ---------------------------------------------------------------------------
// Offline session restore (LUM-2412)
//
// A transport-failed session probe (offline boot, tray reopen before
// Wi-Fi reassociates, platform outage) says nothing about the session.
// With a local credential (Electron session token) and a persisted user
// snapshot, the store settles authenticated instead of bouncing a
// logged-in user to the login screen. Only a settled "no session"
// answer (401, or 2xx without user) ends the session — and it also
// invalidates the snapshot so a revoked session can't be resurrected.
// ---------------------------------------------------------------------------

const SNAPSHOT_KEY = "vellum:auth:userSnapshot";

function seedSnapshot(): void {
  localStorage.setItem(
    SNAPSHOT_KEY,
    JSON.stringify({
      id: "user-cached",
      username: "cached",
      email: "cached@example.com",
      isStaff: false,
      firstName: "Cached",
      lastName: "User",
    }),
  );
}

describe("offline session restore (LUM-2412)", () => {
  test("transport-failed boot (thrown fetch) with token + snapshot settles authenticated from cache", async () => {
    getSessionThrows = true;
    mockElectronSessionToken = "tok-1";
    seedSnapshot();

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().user?.id).toBe("user-cached");
    // The snapshot only exists for a confirmed platform session, and no
    // probe runs offline to settle an "unknown" — so the restore settles
    // "present" (believed state); reconnect revalidation corrects it.
    expect(useAuthStore.getState().platformSession).toBe("present");
  });

  test("transport-failed boot (proxy 502) with token + snapshot settles authenticated from cache", async () => {
    getSessionFailStatus = 502;
    mockElectronSessionToken = "tok-1";
    seedSnapshot();

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().user?.id).toBe("user-cached");
  });

  test("rate-limited boot (429) is non-authoritative — restores from cache instead of logging out", async () => {
    getSessionFailStatus = 429;
    mockElectronSessionToken = "tok-1";
    seedSnapshot();

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().user?.id).toBe("user-cached");
    expect(localStorage.getItem(SNAPSHOT_KEY)).not.toBeNull();
  });

  test("rate-limited refresh (429) keeps the authenticated session", async () => {
    sessionUser = { id: "user-9", username: "nine", email: "nine@example.com" };
    await useAuthStore.getState().initSession();
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");

    sessionUser = null;
    getSessionFailStatus = 429;
    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(localStorage.getItem(SNAPSHOT_KEY)).not.toBeNull();
  });

  test("transport-failed boot without a local credential stays unauthenticated (web behavior)", async () => {
    getSessionThrows = true;
    mockElectronSessionToken = null;
    seedSnapshot();

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
    // Transport failure must not invalidate the snapshot.
    expect(localStorage.getItem(SNAPSHOT_KEY)).not.toBeNull();
  });

  test("transport-failed boot with token but no snapshot stays unauthenticated", async () => {
    getSessionThrows = true;
    mockElectronSessionToken = "tok-1";

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });

  test("settled 401 boot stays unauthenticated and invalidates the snapshot", async () => {
    getSessionFailStatus = 401;
    mockElectronSessionToken = "tok-1";
    seedSnapshot();

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
  });

  test("successful boot persists the snapshot for later offline restores", async () => {
    sessionUser = { id: "user-9", username: "nine", email: "nine@example.com" };

    await useAuthStore.getState().initSession();

    const raw = localStorage.getItem(SNAPSHOT_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toMatchObject({
      id: "user-9",
      email: "nine@example.com",
    });
  });

  test("local-mode platform-assistants boot also restores from cache on transport failure", async () => {
    mockIsLocalMode = true;
    mockPlatformAssistants = [{ assistantId: "p1", cloud: "vellum" }];
    getSessionThrows = true;
    mockElectronSessionToken = "tok-1";
    seedSnapshot();

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().user?.id).toBe("user-cached");
  });

  test("refreshSession transport failure keeps the authenticated session (offline resume)", async () => {
    // Boot online…
    sessionUser = { id: "user-9", username: "nine", email: "nine@example.com" };
    await useAuthStore.getState().initSession();
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");

    // …then the resume-driven refresh fires while offline.
    getSessionThrows = true;
    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().user?.id).toBe("user-9");
  });

  test("refreshSession transport failure while unauthenticated reports false without state churn", async () => {
    getSessionThrows = true;
    useAuthStore.setState({ sessionStatus: "unauthenticated", user: null });

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(false);

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });

  test("refreshSession settled 401 ends the session and invalidates the snapshot (reconnect revalidation)", async () => {
    // Boot from cache while offline…
    getSessionThrows = true;
    mockElectronSessionToken = "tok-1";
    seedSnapshot();
    await useAuthStore.getState().initSession();
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");

    // …network returns, the platform says the session was revoked.
    getSessionThrows = false;
    getSessionFailStatus = 401;
    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(false);

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
  });

  test("a corrupt snapshot is ignored — transport-failed boot stays unauthenticated", async () => {
    getSessionThrows = true;
    mockElectronSessionToken = "tok-1";
    localStorage.setItem(SNAPSHOT_KEY, "{not json");

    await useAuthStore.getState().initSession();

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
  });
});
