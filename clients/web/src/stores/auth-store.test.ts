import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup } from "@testing-library/react";


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
// The assistant `getSelectedAssistant()` resolves; `undefined` means none selected.
let mockSelectedAssistant: { assistantId: string; cloud: string } | undefined;
let mockPlatformAssistants: unknown[] = [];
let mockPrimeError: Error | null = null;
let mockGatewayToken: string | null = null;
const setSelectedAssistantMock = mock(async (_id: string | null) => {});
const primeLocalGatewayConnectionMock = mock(async () => {
  if (mockPrimeError) throw mockPrimeError;
});
const primeLocalGatewayConnectionWithRepairMock = mock(async () => {
  if (mockPrimeError) throw mockPrimeError;
});
const ensureGatewayTokenMock = mock(async () => {});
const refreshRemoteGatewaySessionMock = mock(async () => false);
const restoreConsentForUserMock = mock(
  (
    _userId: string | null,
  ): {
    tos: boolean;
    privacy: boolean;
    diagnosticsCurrent: boolean;
  } => ({
    tos: false,
    privacy: false,
    diagnosticsCurrent: false,
  }),
);
const persistConsentForUserMock = mock(
  (_userId: string | null, _tos: boolean, _privacy: boolean) => {},
);
const persistToggleConsentMock = mock(
  (_userId: string | null, _acks: { diagnosticsCurrent?: boolean }) => {},
);
const resolveServerConsentMock = mock(
  (
    _consent: unknown,
  ): {
    tos: boolean;
    privacy: boolean;
    shareAnalytics: boolean | null;
    shareDiagnostics: boolean | null;
    analyticsEffective: boolean;
    diagnosticsEffective: boolean;
    analyticsCurrent: boolean;
    diagnosticsCurrent: boolean;
    analyticsVersionCurrent: boolean;
    diagnosticsVersionCurrent: boolean;
    hasServerRecord: boolean;
  } => ({
    tos: false,
    privacy: false,
    shareAnalytics: null,
    shareDiagnostics: null,
    analyticsEffective: true,
    diagnosticsEffective: true,
    analyticsCurrent: false,
    diagnosticsCurrent: false,
    analyticsVersionCurrent: false,
    diagnosticsVersionCurrent: false,
    hasServerRecord: false,
  }),
);

const EMPTY_CONSENT = {
  tos_accepted_version: "",
  tos_accepted_at: null,
  privacy_policy_accepted_version: "",
  privacy_policy_accepted_at: null,
  ai_data_sharing_accepted_version: "",
  ai_data_sharing_accepted_at: null,
  share_analytics: false,
  share_diagnostics: false,
};
let mockFetchConsentResult: unknown = EMPTY_CONSENT;
let mockFetchConsentError: Error | null = null;
const fetchConsentMock = mock(async () => {
  if (mockFetchConsentError) throw mockFetchConsentError;
  return mockFetchConsentResult;
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
const bootstrapLocalAssistantPlatformIdentityMock = mock(
  (_assistantId?: string) => {},
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
  isGatewayAuthMode: () => mockIsGatewayAuth && mockGatewayToken !== null,
  ensureGatewayToken: ensureGatewayTokenMock,
  clearGatewayToken: () => {},
  getGatewayToken: () => mockGatewayToken,
  getLocalTokenUrl: () => "http://localhost/token",
}));

mock.module("@/lib/auth/remote-gateway-session", () => ({
  refreshRemoteGatewaySession: refreshRemoteGatewaySessionMock,
}));

mock.module("@/lib/local-mode", () => ({
  isLocalMode: () => mockIsLocalMode,
  isRemoteGatewayMode: () => mockIsRemoteGatewayMode,
  isLocalAssistant: (a: { cloud?: string }) => a.cloud === "local",
  isPlatformAssistant: (a: { cloud?: string }) => a.cloud === "vellum",
  getPlatformAssistants: () => mockPlatformAssistants,
  getLocalAssistants: () => [],
  getSelectedAssistant: () => mockSelectedAssistant,
  primeLocalGatewayConnection: primeLocalGatewayConnectionMock,
  primeLocalGatewayConnectionWithRepair:
    primeLocalGatewayConnectionWithRepairMock,
  syncPlatformAssistantsToLockfile: syncPlatformAssistantsToLockfileMock,
}));

mock.module("@/lib/local-platform-identity", () => ({
  bootstrapLocalAssistantPlatformIdentity:
    bootstrapLocalAssistantPlatformIdentityMock,
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
  fetchConsent: fetchConsentMock,
  patchConsent: patchConsentMock,
}));

mock.module("@/utils/onboarding-cleanup", () => ({
  restoreConsentForUser: restoreConsentForUserMock,
  persistConsentForUser: persistConsentForUserMock,
  persistToggleConsent: persistToggleConsentMock,
  resolveServerConsent: resolveServerConsentMock,
  TOS_CONSENT_VERSION: "2026-06-08",
  PRIVACY_CONSENT_VERSION: "2026-06-08",
  ANALYTICS_CONSENT_VERSION: "2026-06-08",
  DIAGNOSTICS_CONSENT_VERSION: "2026-06-08",
}));

const setTosAcceptedMock = mock((_value: boolean) => {});
const setPrivacyConsentMock = mock((_value: boolean) => {});
const setAnalyticsConsentCurrentMock = mock((_value: boolean) => {});
const setDiagnosticsConsentCurrentMock = mock((_value: boolean) => {});
const setShareAnalyticsMock = mock((_value: boolean | null) => {});
const setShareDiagnosticsMock = mock((_value: boolean | null) => {});
const setConsentHydratedMock = mock((_value: boolean) => {});
// Mirror the store's device-initialized tri-state share values (null = never
// asked); the backfill reads these to send an explicit device choice
// alongside the accepted version.
let mockStoreShareAnalytics: boolean | null = null;
let mockStoreShareDiagnostics: boolean | null = null;

mock.module("@/domains/onboarding/onboarding-store", () => ({
  useOnboardingStore: {
    getState: () => ({
      setTosAccepted: setTosAcceptedMock,
      setPrivacyConsent: setPrivacyConsentMock,
      setShareAnalytics: setShareAnalyticsMock,
      setShareDiagnostics: setShareDiagnosticsMock,
      setAnalyticsConsentCurrent: setAnalyticsConsentCurrentMock,
      setDiagnosticsConsentCurrent: setDiagnosticsConsentCurrentMock,
      setConsentHydrated: setConsentHydratedMock,
      shareAnalytics: mockStoreShareAnalytics,
      shareDiagnostics: mockStoreShareDiagnostics,
    }),
  },
}));

mock.module("@/lib/auth/session-cleanup", () => ({
  clearUserScopedStorage: clearUserScopedStorageMock,
}));

// Use the REAL resolved-assistants store: the auth-store init path calls its
// `.getState().setFromApi(...)`, which a plain stub can't provide. It's
// dependency-light, so loading it for real is cheap.

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
const { useAssistantLifecycleStore } = await import(
  "@/assistant/lifecycle-store"
);
const { useResolvedAssistantsStore } = await import(
  "@/stores/resolved-assistants-store"
);

function resetAuthStore(): void {
  useAuthStore.setState({
    sessionStatus: "initializing",
    user: null,
    platformSession: "unknown",
  });
}

function authenticatedLocalUserForTest() {
  return {
    sessionStatus: "authenticated" as const,
    user: {
      kind: "local" as const,
      id: "gateway-local",
      username: "local",
      email: null,
      isStaff: false,
      firstName: "Local",
      lastName: "User",
    },
    platformSession: "absent" as const,
  };
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
  localStorage.removeItem("device:share_diagnostics");
  localStorage.removeItem("device:diagnostics_reporting");
  mockIsGatewayAuth = false;
  mockIsLocalMode = false;
  mockIsRemoteGatewayMode = false;
  mockSelectedAssistant = undefined;
  mockPlatformAssistants = [];
  mockIsNativePlatform = false;
  mockIsBiometricEnabled = false;
  mockBiometricToken = null;
  mockGatewayToken = null;
  mockPrimeError = null;
  setSelectedAssistantMock.mockClear();
  primeLocalGatewayConnectionMock.mockClear();
  primeLocalGatewayConnectionWithRepairMock.mockClear();
  ensureGatewayTokenMock.mockClear();
  refreshRemoteGatewaySessionMock.mockClear();
  restoreConsentForUserMock.mockClear();
  persistConsentForUserMock.mockClear();
  persistToggleConsentMock.mockClear();
  resolveServerConsentMock.mockClear();
  setTosAcceptedMock.mockClear();
  setPrivacyConsentMock.mockClear();
  setAnalyticsConsentCurrentMock.mockClear();
  setDiagnosticsConsentCurrentMock.mockClear();
  setShareAnalyticsMock.mockClear();
  setShareDiagnosticsMock.mockClear();
  setConsentHydratedMock.mockClear();
  mockStoreShareAnalytics = null;
  mockStoreShareDiagnostics = null;
  fetchConsentMock.mockClear();
  patchConsentMock.mockClear();
  mockFetchConsentResult = EMPTY_CONSENT;
  mockFetchConsentError = null;
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
  bootstrapLocalAssistantPlatformIdentityMock.mockClear();
  resetAuthStore();
  // Reset the lifecycle and resolved-assistants stores so each test starts from
  // a known connection/selection state.
  useAssistantLifecycleStore.setState({ assistantState: { kind: "loading" } });
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

afterEach(() => {
  cleanup();
});

describe("auth store onboarding flag reconciliation", () => {
  test("initSession treats remote-gateway mode as an authenticated local session", async () => {
    mockIsRemoteGatewayMode = true;
    refreshRemoteGatewaySessionMock.mockImplementationOnce(async () => true);

    await useAuthStore.getState().initSession();

    expect(primeLocalGatewayConnectionMock).not.toHaveBeenCalled();
    expect(refreshRemoteGatewaySessionMock).toHaveBeenCalledTimes(1);
    expect(getSessionCallCount).toBe(0);
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().user?.id).toBe("gateway-local");
    expect(useAuthStore.getState().platformSession).toBe("absent");
  });

  test("refreshSession keeps remote-gateway mode authenticated without minting a local token", async () => {
    mockIsRemoteGatewayMode = true;
    mockIsGatewayAuth = true;
    refreshRemoteGatewaySessionMock.mockImplementationOnce(async () => true);

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(ensureGatewayTokenMock).not.toHaveBeenCalled();
    expect(refreshRemoteGatewaySessionMock).toHaveBeenCalledTimes(1);
    expect(primeLocalGatewayConnectionMock).not.toHaveBeenCalled();
    expect(getSessionCallCount).toBe(0);
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().user?.id).toBe("gateway-local");
    expect(useAuthStore.getState().platformSession).toBe("absent");
  });

  test("initSession leaves remote-gateway mode unauthenticated when cookie refresh fails and no token exists", async () => {
    mockIsRemoteGatewayMode = true;

    await useAuthStore.getState().initSession();

    expect(refreshRemoteGatewaySessionMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().platformSession).toBe("absent");
  });

  test("refreshSession ends remote-gateway sessions when refresh fails and no token exists", async () => {
    mockIsRemoteGatewayMode = true;
    useAuthStore.setState({ ...authenticatedLocalUserForTest() });

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(false);

    expect(refreshRemoteGatewaySessionMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated");
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().platformSession).toBe("absent");
  });

  test("refreshSession keeps remote-gateway sessions when refresh throws but a token is still valid", async () => {
    mockIsRemoteGatewayMode = true;
    mockGatewayToken = "access-token";
    refreshRemoteGatewaySessionMock.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(refreshRemoteGatewaySessionMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().user?.id).toBe("gateway-local");
    expect(useAuthStore.getState().platformSession).toBe("absent");
  });

  test("refreshSession keeps the local gateway session but clears stale platform state on a settled 401", async () => {
    // Local gateway is the auth source (enabled) but its token isn't minted yet.
    // The user had also signed into the platform; the platform session now
    // settles negative (401). The local session stays authenticated, but the
    // stale platform user and "present" status are cleared.
    mockIsLocalMode = true;
    mockIsGatewayAuth = true; // isGatewayAuthEnabled() === true
    mockGatewayToken = null; // isGatewayAuthMode() === false (token not minted)
    sessionUser = null; // platform probe settles 401
    useAuthStore.setState({
      sessionStatus: "authenticated",
      platformSession: "present",
    });

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(getSessionCallCount).toBe(1); // probe ran — a success could still update the store
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated"); // local session not ended
    expect(useAuthStore.getState().user?.id).toBe("gateway-local"); // demoted to local user
    expect(useAuthStore.getState().platformSession).toBe("absent"); // stale platform state cleared
  });

  test("refreshSession leaves an unauthenticated session untouched in the gateway window", async () => {
    // Mid cold-start hatch: gateway enabled, token not minted, session not yet
    // established. A settled 401 must not promote to authenticated — the gateway
    // settles the session once its token mints (via connectLocalAssistant).
    mockIsLocalMode = true;
    mockIsGatewayAuth = true;
    mockGatewayToken = null;
    sessionUser = null;
    useAuthStore.setState({
      sessionStatus: "unauthenticated",
      user: null,
      platformSession: "absent",
    });

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(false);

    expect(useAuthStore.getState().sessionStatus).toBe("unauthenticated"); // not promoted
  });

  test("refreshSession in gateway mode still adopts a successful platform session", async () => {
    // A local user who also signs into the platform (e.g. ProviderCallbackPage
    // after an allauth login) must have the successful probe update the store,
    // even while the gateway token isn't minted.
    mockIsLocalMode = true;
    mockIsGatewayAuth = true;
    mockGatewayToken = null;
    sessionUser = { id: "user-1", email: "user@example.com" };
    useAuthStore.setState({ platformSession: "absent" });

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(getSessionCallCount).toBe(1);
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
    expect(useAuthStore.getState().user?.id).toBe("user-1");
    expect(useAuthStore.getState().platformSession).toBe("present");
    // A live probe confirmed it — not a believed offline restore.
    expect(useAuthStore.getState().platformSessionRestoredOffline).toBe(false);
  });

  test("successful local platform probe bootstraps the selected local assistant identity", async () => {
    mockIsLocalMode = true;
    mockIsGatewayAuth = true;
    mockGatewayToken = "access-token";
    mockSelectedAssistant = { assistantId: "local-a", cloud: "local" };
    sessionUser = { id: "user-1", email: "user@example.com" };

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(bootstrapLocalAssistantPlatformIdentityMock).toHaveBeenCalledWith();
  });

  test("initSession uses server consent when server has a consent record", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockFetchConsentResult = {
      tos_accepted_version: "2026-06-08",
      tos_accepted_at: "2026-06-08T00:00:00Z",
      privacy_policy_accepted_version: "2026-06-08",
      privacy_policy_accepted_at: "2026-06-08T00:00:00Z",
      ai_data_sharing_accepted_version: "2026-06-08",
      ai_data_sharing_accepted_at: "2026-06-08T00:00:00Z",
      share_analytics: true,
      share_diagnostics: true,
    };
    resolveServerConsentMock.mockReturnValueOnce({
      tos: true,
      privacy: true,
      shareAnalytics: true,
      shareDiagnostics: true,
      analyticsEffective: true,
      diagnosticsEffective: true,
      analyticsCurrent: true,
      diagnosticsCurrent: true,
      analyticsVersionCurrent: true,
      diagnosticsVersionCurrent: true,
      hasServerRecord: true,
    });

    await useAuthStore.getState().initSession();

    expect(fetchConsentMock).toHaveBeenCalled();
    expect(resolveServerConsentMock).toHaveBeenCalled();
    expect(restoreConsentForUserMock).not.toHaveBeenCalled();
    // The explicit server choice is adopted unconditionally.
    expect(setShareAnalyticsMock).toHaveBeenCalledWith(true);
    // Currency flags hydrate from the resolved server consent.
    expect(setAnalyticsConsentCurrentMock).toHaveBeenCalledWith(true);
    expect(setDiagnosticsConsentCurrentMock).toHaveBeenCalledWith(true);
    // Only diagnostics carries a device ack — analytics has none.
    expect(persistToggleConsentMock).toHaveBeenCalledWith("user-1", {
      diagnosticsCurrent: true,
    });
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
  });

  test("never-asked analytics (null on a real record) hydrates current but earns no device ack", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };
    resolveServerConsentMock.mockReturnValueOnce({
      tos: true,
      privacy: true,
      shareAnalytics: null,
      shareDiagnostics: true,
      analyticsEffective: true,
      diagnosticsEffective: true,
      // The resolver reads a null share_analytics as "nothing to re-review".
      analyticsCurrent: true,
      diagnosticsCurrent: true,
      analyticsVersionCurrent: false,
      diagnosticsVersionCurrent: true,
      hasServerRecord: true,
    });

    await useAuthStore.getState().initSession();

    // No bounce to review-terms...
    expect(setAnalyticsConsentCurrentMock).toHaveBeenCalledWith(true);
    // ...but no versioned ack either: only an explicit choice may attest a
    // confirmation that could later backfill a server version stamp.
    expect(persistToggleConsentMock).toHaveBeenCalledWith("user-1", {
      diagnosticsCurrent: true,
    });
    // Never-asked propagates: the store adopts null so tri-state chosen-ness
    // mirrors the server.
    expect(setShareAnalyticsMock).toHaveBeenCalledWith(null);
  });

  test("server null never overwrites a pending local explicit analytics opt-out", async () => {
    // The user opted out on this device; the patchConsent write is still in
    // flight (or failed), so the server still reports null. Adopting null
    // would clear the opt-out and resume uploads the user declined.
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockStoreShareAnalytics = false;
    resolveServerConsentMock.mockReturnValueOnce({
      tos: true,
      privacy: true,
      shareAnalytics: null,
      shareDiagnostics: true,
      analyticsEffective: true,
      diagnosticsEffective: true,
      analyticsCurrent: true,
      diagnosticsCurrent: true,
      analyticsVersionCurrent: false,
      diagnosticsVersionCurrent: true,
      hasServerRecord: true,
    });

    await useAuthStore.getState().initSession();

    expect(setShareAnalyticsMock).not.toHaveBeenCalled();
  });

  test("an explicit server analytics value overrides a local opt-out", async () => {
    // The server is authoritative for explicit choices — e.g. the user opted
    // back in from another device.
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockStoreShareAnalytics = false;
    resolveServerConsentMock.mockReturnValueOnce({
      tos: true,
      privacy: true,
      shareAnalytics: true,
      shareDiagnostics: true,
      analyticsEffective: true,
      diagnosticsEffective: true,
      analyticsCurrent: true,
      diagnosticsCurrent: true,
      analyticsVersionCurrent: true,
      diagnosticsVersionCurrent: true,
      hasServerRecord: true,
    });

    await useAuthStore.getState().initSession();

    expect(setShareAnalyticsMock).toHaveBeenCalledWith(true);
  });

  test("never-asked diagnostics (null on a real record) hydrates current but earns no device ack", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };
    resolveServerConsentMock.mockReturnValueOnce({
      tos: true,
      privacy: true,
      shareAnalytics: true,
      shareDiagnostics: null,
      analyticsEffective: true,
      diagnosticsEffective: true,
      analyticsCurrent: true,
      // The resolver reads a null share_diagnostics as "nothing to re-review".
      diagnosticsCurrent: true,
      analyticsVersionCurrent: true,
      diagnosticsVersionCurrent: false,
      hasServerRecord: true,
    });

    await useAuthStore.getState().initSession();

    // No bounce to review-terms...
    expect(setDiagnosticsConsentCurrentMock).toHaveBeenCalledWith(true);
    // ...but no versioned ack either: only an explicit choice may attest a
    // confirmation that could later backfill a server version stamp.
    expect(persistToggleConsentMock).toHaveBeenCalledWith("user-1", {});
    // A null server value never overwrites the device-local preference.
    expect(setShareDiagnosticsMock).not.toHaveBeenCalled();
  });

  test("no-record fallback without any device acks stays current and backfills neither toggle", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };
    restoreConsentForUserMock.mockReturnValueOnce({
      tos: true,
      privacy: true,
      diagnosticsCurrent: false,
    });

    await useAuthStore.getState().initSession();

    // Never-asked toggles (no server record, no device acks) must not bounce
    // the user to review-terms.
    expect(setAnalyticsConsentCurrentMock).toHaveBeenCalledWith(true);
    expect(setDiagnosticsConsentCurrentMock).toHaveBeenCalledWith(true);
    // The backfill seeds the server without any share-toggle version stamps —
    // the server keeps both null until the user makes an explicit choice.
    const body = patchConsentMock.mock.calls[0][0] as Record<string, unknown>;
    expect("share_analytics_accepted_version" in body).toBe(false);
    expect("share_diagnostics_accepted_version" in body).toBe(false);
    // No ack keys are written for never-asked toggles.
    expect(persistToggleConsentMock).toHaveBeenCalledWith("user-1", {});
  });

  test("no-record fallback without an analytics device ack stays current and backfills without analytics", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };
    restoreConsentForUserMock.mockReturnValueOnce({
      tos: true,
      privacy: true,
      diagnosticsCurrent: true,
    });

    await useAuthStore.getState().initSession();

    // Never-asked analytics (no server record, no device ack) must not bounce
    // the user to review-terms.
    expect(setAnalyticsConsentCurrentMock).toHaveBeenCalledWith(true);
    // The backfill seeds the server without any analytics fields — the server
    // keeps share_analytics null until the user makes an explicit choice.
    const body = patchConsentMock.mock.calls[0][0] as Record<string, unknown>;
    expect("share_analytics" in body).toBe(false);
    expect("share_analytics_accepted_version" in body).toBe(false);
    expect(body.share_diagnostics_accepted_version).toEqual(expect.any(String));
    expect(persistToggleConsentMock).toHaveBeenCalledWith("user-1", {
      diagnosticsCurrent: true,
    });
  });

  test("initSession falls through to device keys when server versions are empty", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };

    await useAuthStore.getState().initSession();

    expect(fetchConsentMock).toHaveBeenCalled();
    expect(resolveServerConsentMock).toHaveBeenCalled();
    expect(restoreConsentForUserMock).toHaveBeenCalledWith("user-1");
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
  });

  test("initSession backfills server when device keys show prior consent and server versions are empty", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };
    restoreConsentForUserMock.mockReturnValueOnce({
      tos: true,
      privacy: true,
      diagnosticsCurrent: true,
    });

    await useAuthStore.getState().initSession();

    expect(patchConsentMock).toHaveBeenCalled();
    // The backfill branch hydrates the currency flags from the device acks.
    expect(setAnalyticsConsentCurrentMock).toHaveBeenCalledWith(true);
    expect(setDiagnosticsConsentCurrentMock).toHaveBeenCalledWith(true);
    // Acks are persisted from the device-restored values, not the empty
    // server values — otherwise the fallback would clobber its own input.
    expect(persistToggleConsentMock).toHaveBeenLastCalledWith("user-1", {
      diagnosticsCurrent: true,
    });
    // Legal consent is persisted with the restored (true) values, after the
    // fallback — never the empty server values that would erase device acks.
    expect(persistConsentForUserMock).toHaveBeenLastCalledWith(
      "user-1",
      true,
      true,
    );
    // The backfill patch carries the diagnostics version (device-attested) so
    // the next server fetch doesn't re-mark it stale and re-route to
    // review-terms. Analytics has never been chosen on this device (store is
    // null), so no analytics fields are seeded — the server keeps null.
    expect(patchConsentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        share_diagnostics_accepted_version: expect.any(String),
      }),
    );
    const backfillBody = patchConsentMock.mock.calls[0][0] as Record<string, unknown>;
    expect("share_analytics" in backfillBody).toBe(false);
    expect("share_analytics_accepted_version" in backfillBody).toBe(false);
    // Never-asked propagates to the store (null adoption); the diagnostics
    // preference is left untouched by the chokepoint on an unknown input.
    expect(setShareAnalyticsMock).toHaveBeenCalledWith(null);
    expect(setShareDiagnosticsMock).not.toHaveBeenCalled();
  });

  test("backfill patch carries the device share VALUE alongside the accepted version (opt-out preserved)", async () => {
    // Truly-empty server record (hasServerRecord=false), device legal consent
    // current, and a device analytics opt-out. The backfill must send the
    // share value so the next fetch can't read the API default (true) and
    // overwrite the opt-out.
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockStoreShareAnalytics = false;
    restoreConsentForUserMock.mockReturnValueOnce({
      tos: true,
      privacy: true,
      diagnosticsCurrent: true,
    });

    await useAuthStore.getState().initSession();

    expect(patchConsentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        share_analytics_accepted_version: "2026-06-08",
        share_analytics: false,
      }),
    );
  });

  test("device-consent fallback reopens the diagnostics reporting gate for a device-confirmed opt-in", async () => {
    // Empty server record, but the user has a current device-side diagnostics
    // ack and an opted-in preference. The chokepoint resolves the unknown
    // server value from the device preference, reopening a gate an earlier
    // build left closed so a confirmed opted-in user isn't left with Sentry
    // disabled.
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockStoreShareDiagnostics = true;
    localStorage.setItem("device:share_diagnostics", "true");
    localStorage.setItem("device:diagnostics_reporting", "false");
    restoreConsentForUserMock.mockReturnValueOnce({
      tos: true,
      privacy: true,
      diagnosticsCurrent: true,
    });

    await useAuthStore.getState().initSession();

    expect(localStorage.getItem("device:diagnostics_reporting")).toBe("true");
  });

  test("device-consent fallback keeps the gate closed for a device opt-out", async () => {
    // Same empty-record fallback, but the device preference is an explicit
    // opt-out — the unknown server value must not reopen the gate even though
    // the device ack is current.
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockStoreShareDiagnostics = false;
    localStorage.setItem("device:share_diagnostics", "false");
    localStorage.setItem("device:diagnostics_reporting", "true");
    restoreConsentForUserMock.mockReturnValueOnce({
      tos: true,
      privacy: true,
      diagnosticsCurrent: true,
    });

    await useAuthStore.getState().initSession();

    expect(localStorage.getItem("device:diagnostics_reporting")).toBe("false");
    mockStoreShareDiagnostics = true;
  });

  test("failed consent fetch on a fresh device writes a conservative closed gate", async () => {
    // A confirmed session with a throwing consent fetch must not let the
    // never-written gate fall open on hydration — the server may hold an
    // explicit opt-out this device hasn't seen yet.
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockFetchConsentError = new Error("offline");
    localStorage.removeItem("device:diagnostics_reporting");

    await useAuthStore.getState().initSession();

    expect(localStorage.getItem("device:diagnostics_reporting")).toBe("false");
  });

  test("failed consent fetch leaves an already-resolved gate untouched", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockFetchConsentError = new Error("offline");
    localStorage.setItem("device:diagnostics_reporting", "true");

    await useAuthStore.getState().initSession();

    expect(localStorage.getItem("device:diagnostics_reporting")).toBe("true");
  });

  test("stale-but-real record keeps server share values authoritative", async () => {
    // hasServerRecord=true but legal consent is stale (tos=false). The server's
    // share opt-out is authoritative and must be applied. The device keys are
    // consulted for the stale version flags, but attest nothing here, so the
    // stale flags stand and no backfill fires.
    sessionUser = { id: "user-1", email: "user@example.com" };
    resolveServerConsentMock.mockReturnValueOnce({
      tos: false,
      privacy: false,
      shareAnalytics: false,
      shareDiagnostics: true,
      analyticsEffective: false,
      diagnosticsEffective: true,
      analyticsCurrent: false,
      diagnosticsCurrent: false,
      analyticsVersionCurrent: false,
      diagnosticsVersionCurrent: false,
      hasServerRecord: true,
    });

    await useAuthStore.getState().initSession();

    expect(setShareAnalyticsMock).toHaveBeenCalledWith(false);
    expect(restoreConsentForUserMock).toHaveBeenCalledWith("user-1");
    expect(setTosAcceptedMock).toHaveBeenCalledWith(false);
    expect(setPrivacyConsentMock).toHaveBeenCalledWith(false);
    expect(patchConsentMock).not.toHaveBeenCalled();
  });

  test("a fully current server record does not consult the device keys", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };
    resolveServerConsentMock.mockReturnValueOnce({
      tos: true,
      privacy: true,
      shareAnalytics: true,
      shareDiagnostics: true,
      analyticsEffective: true,
      diagnosticsEffective: true,
      analyticsCurrent: true,
      diagnosticsCurrent: true,
      analyticsVersionCurrent: true,
      diagnosticsVersionCurrent: true,
      hasServerRecord: true,
    });

    await useAuthStore.getState().initSession();

    expect(restoreConsentForUserMock).not.toHaveBeenCalled();
  });

  test("a stale server record is overridden by current-version device acks, and the backfill re-fires", async () => {
    // The device ack keys are version-stamped, so a true key attests
    // acceptance of the CURRENT terms — the stale server record just means
    // the fire-and-forget backfill write never landed. The in-memory flags
    // must stay true (no bounce into onboarding/review-terms) and the
    // backfill must be re-sent. Analytics has no device ack, so its stale
    // explicit choice stays stale (re-review) and is never backfilled.
    sessionUser = { id: "user-1", email: "user@example.com" };
    resolveServerConsentMock.mockReturnValueOnce({
      tos: false,
      privacy: false,
      shareAnalytics: true,
      shareDiagnostics: true,
      analyticsEffective: true,
      diagnosticsEffective: true,
      analyticsCurrent: false,
      diagnosticsCurrent: false,
      analyticsVersionCurrent: false,
      diagnosticsVersionCurrent: false,
      hasServerRecord: true,
    });
    restoreConsentForUserMock.mockReturnValueOnce({
      tos: true,
      privacy: true,
      diagnosticsCurrent: true,
    });

    await useAuthStore.getState().initSession();

    expect(setTosAcceptedMock).toHaveBeenCalledWith(true);
    expect(setPrivacyConsentMock).toHaveBeenCalledWith(true);
    expect(setAnalyticsConsentCurrentMock).toHaveBeenCalledWith(false);
    expect(setDiagnosticsConsentCurrentMock).toHaveBeenCalledWith(true);
    expect(persistConsentForUserMock).toHaveBeenLastCalledWith(
      "user-1",
      true,
      true,
    );
    // The backfill stamps every stale-but-attested version…
    expect(patchConsentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tos_accepted_version: expect.any(String),
        privacy_policy_accepted_version: expect.any(String),
        ai_data_sharing_accepted_version: expect.any(String),
        share_diagnostics_accepted_version: expect.any(String),
      }),
    );
    // …but never the share booleans (a real record's values are
    // authoritative) nor an analytics stamp (nothing device-side attests it).
    const body = patchConsentMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).not.toContainKey("share_analytics");
    expect(body).not.toContainKey("share_analytics_accepted_version");
    expect(body).not.toContainKey("share_diagnostics");
  });

  test("device acks override only the stale axes of a partially stale record", async () => {
    // ToS is current on the server; only privacy is stale. The device attests
    // privacy, so the backfill patches the privacy artifacts alone.
    sessionUser = { id: "user-1", email: "user@example.com" };
    resolveServerConsentMock.mockReturnValueOnce({
      tos: true,
      privacy: false,
      shareAnalytics: true,
      shareDiagnostics: true,
      analyticsEffective: true,
      diagnosticsEffective: true,
      analyticsCurrent: true,
      diagnosticsCurrent: true,
      analyticsVersionCurrent: true,
      diagnosticsVersionCurrent: true,
      hasServerRecord: true,
    });
    restoreConsentForUserMock.mockReturnValueOnce({
      tos: true,
      privacy: true,
      diagnosticsCurrent: true,
    });

    await useAuthStore.getState().initSession();

    expect(setTosAcceptedMock).toHaveBeenCalledWith(true);
    expect(setPrivacyConsentMock).toHaveBeenCalledWith(true);
    const body = patchConsentMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toContainKey("privacy_policy_accepted_version");
    expect(body).toContainKey("ai_data_sharing_accepted_version");
    expect(body).not.toContainKey("tos_accepted_version");
    expect(body).not.toContainKey("share_analytics_accepted_version");
    expect(body).not.toContainKey("share_diagnostics_accepted_version");
  });

  test("stale axes without device attestation stay stale (no override, no backfill)", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };
    resolveServerConsentMock.mockReturnValueOnce({
      tos: false,
      privacy: false,
      shareAnalytics: true,
      shareDiagnostics: true,
      analyticsEffective: true,
      diagnosticsEffective: true,
      analyticsCurrent: false,
      diagnosticsCurrent: false,
      analyticsVersionCurrent: false,
      diagnosticsVersionCurrent: false,
      hasServerRecord: true,
    });
    restoreConsentForUserMock.mockReturnValueOnce({
      tos: false,
      privacy: false,
      diagnosticsCurrent: false,
    });

    await useAuthStore.getState().initSession();

    expect(setTosAcceptedMock).toHaveBeenCalledWith(false);
    expect(setPrivacyConsentMock).toHaveBeenCalledWith(false);
    expect(patchConsentMock).not.toHaveBeenCalled();
  });

  test("syncUserScopedState marks consent hydrated on every settle path", async () => {
    // Success path (server record).
    sessionUser = { id: "user-1", email: "user@example.com" };
    await useAuthStore.getState().initSession();
    expect(setConsentHydratedMock).toHaveBeenCalledWith(true);

    // Server-fetch-failure fallback path.
    setConsentHydratedMock.mockClear();
    mockFetchConsentError = new Error("Network error");
    await useAuthStore.getState().refreshSession();
    expect(setConsentHydratedMock).toHaveBeenCalledWith(true);

    // Null-user path (settled unauthenticated).
    setConsentHydratedMock.mockClear();
    mockFetchConsentError = null;
    sessionUser = null;
    await useAuthStore.getState().initSession();
    expect(setConsentHydratedMock).toHaveBeenCalledWith(true);
  });

  test("initSession marks the assistants list hydrated even when the platform fetch fails", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };
    useResolvedAssistantsStore.setState({ assistantsHydrated: false });
    listAssistantsMock.mockImplementationOnce(async () => {
      throw new Error("Network error");
    });

    await useAuthStore.getState().initSession();

    expect(useResolvedAssistantsStore.getState().assistantsHydrated).toBe(true);
  });

  test("initSession falls back to device keys when fetchConsent fails", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockFetchConsentError = new Error("Network error");
    restoreConsentForUserMock.mockReturnValueOnce({
      tos: true,
      privacy: true,
      diagnosticsCurrent: true,
    });

    await useAuthStore.getState().initSession();

    expect(fetchConsentMock).toHaveBeenCalled();
    expect(restoreConsentForUserMock).toHaveBeenCalledWith("user-1");
    // A fully offline restore still reflects prior toggle acks.
    expect(setAnalyticsConsentCurrentMock).toHaveBeenCalledWith(true);
    expect(setDiagnosticsConsentCurrentMock).toHaveBeenCalledWith(true);
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
  });

  test("initSession fetches server consent for local-mode platform sessions", async () => {
    mockIsLocalMode = true;
    sessionUser = { id: "user-1", email: "user@example.com" };
    mockPlatformAssistants = [{ assistantId: "p1", cloud: "vellum" }];
    mockFetchConsentResult = {
      tos_accepted_version: "2026-06-08",
      tos_accepted_at: "2026-06-08T00:00:00Z",
      privacy_policy_accepted_version: "2026-06-08",
      privacy_policy_accepted_at: "2026-06-08T00:00:00Z",
      ai_data_sharing_accepted_version: "2026-06-08",
      ai_data_sharing_accepted_at: "2026-06-08T00:00:00Z",
      share_analytics: true,
      share_diagnostics: true,
    };

    await useAuthStore.getState().initSession();

    expect(fetchConsentMock).toHaveBeenCalled();
    expect(resolveServerConsentMock).toHaveBeenCalled();
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
  });

  test("refreshSession fetches consent from server for platform users", async () => {
    sessionUser = { id: "user-2", email: "user@example.com" };
    mockFetchConsentResult = {
      tos_accepted_version: "2026-06-08",
      tos_accepted_at: "2026-06-08T00:00:00Z",
      privacy_policy_accepted_version: "2026-06-08",
      privacy_policy_accepted_at: "2026-06-08T00:00:00Z",
      ai_data_sharing_accepted_version: "2026-06-08",
      ai_data_sharing_accepted_at: "2026-06-08T00:00:00Z",
      share_analytics: true,
      share_diagnostics: true,
    };

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(fetchConsentMock).toHaveBeenCalled();
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
    mockGatewayToken = "access-token";
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
    mockGatewayToken = "access-token";
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
    mockGatewayToken = "access-token";
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

  test("bootstraps a newly connected local assistant when already signed into the platform", async () => {
    mockIsLocalMode = true;
    mockPlatformAssistants = [];
    useAuthStore.setState({
      platformSession: "present",
      platformSessionRestoredOffline: false,
    });

    await useAuthStore.getState().connectLocalAssistant("local-a");

    expect(bootstrapLocalAssistantPlatformIdentityMock).toHaveBeenCalledWith(
      "local-a",
    );
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
    // The legacy snapshot `seedSnapshot()` writes carries no `kind` field;
    // the restore must default it to a platform identity (only platform users
    // are ever snapshotted), so old snapshots keep restoring correctly.
    expect(useAuthStore.getState().user?.kind).toBe("platform");
    // The snapshot only exists for a confirmed platform session, and no
    // probe runs offline to settle an "unknown" — so the restore settles
    // "present" (believed state); reconnect revalidation corrects it.
    expect(useAuthStore.getState().platformSession).toBe("present");
    // ...but it is flagged as a believed restore, so telemetry stays fail-closed.
    expect(useAuthStore.getState().platformSessionRestoredOffline).toBe(true);
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

// `kind` separates a real platform account from synthetic local gateway access.
describe("identity kind (platform vs local gateway access)", () => {
  test("a local gateway session is kind 'local' and not a platform identity, but keeps its stable id", async () => {
    mockIsLocalMode = true;
    mockPlatformAssistants = [];

    await useAuthStore.getState().initSession();

    const user = useAuthStore.getState().user;
    expect(user?.kind).toBe("local");
    expect(user?.id).toBe("gateway-local");
    // A local session stays authenticated — the discriminator does not change
    // session semantics.
    expect(useAuthStore.getState().sessionStatus).toBe("authenticated");
  });

  test("a platform session is kind 'platform' and is a platform identity", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };

    await useAuthStore.getState().initSession();

    const user = useAuthStore.getState().user;
    expect(user?.kind).toBe("platform");
    expect(user?.id).toBe("user-1");
  });

  test("an offline-restored user is a platform identity (legacy snapshot defaults to platform)", async () => {
    // `seedSnapshot()` writes a legacy snapshot with no `kind` field.
    getSessionThrows = true;
    mockElectronSessionToken = "tok-1";
    seedSnapshot();

    await useAuthStore.getState().initSession();

    const user = useAuthStore.getState().user;
    expect(user?.kind).toBe("platform");
  });
});
