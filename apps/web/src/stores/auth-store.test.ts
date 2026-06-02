import { beforeEach, describe, expect, mock, test } from "bun:test";

type MockSessionUser = {
  id?: string;
  username?: string;
  email?: string;
};

let sessionUser: MockSessionUser | null = null;
let getSessionCallCount = 0;
let getSessionFailFirstCall = false;
// When set, the `getSession` probe blocks on this gate until released, so a
// test can observe store state during the in-flight-probe window.
let getSessionGate: Promise<void> | null = null;

let mockIsGatewayAuth = false;
let mockIsLocalMode = false;
let mockPlatformAssistants: unknown[] = [];
const syncOnboardingUserMock = mock((_userId: string | null) => {});
const clearOnboardingFlagsMock = mock(() => {});
const clearOrganizationMock = mock(() => {});
const logoutMock = mock(async () => {});
const deleteBiometricTokenMock = mock(async () => {});

let mockIsNativePlatform = false;
let mockIsBiometricEnabled = false;
let mockBiometricToken: string | null = null;
const installSessionCookiesMock = mock((_token: string) => {});
const retrieveBiometricTokenMock = mock(async () => mockBiometricToken);

mock.module("@/lib/auth/allauth-client", () => ({
  getSession: async () => {
    getSessionCallCount++;
    if (getSessionGate) await getSessionGate;
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
  getPlatformAssistants: () => mockPlatformAssistants,
  getLocalAssistants: () => [],
  clearSelectedAssistant: () => {},
  primeLocalGatewayConnection: async () => {},
  syncPlatformAssistantsToLockfile: async () => {},
}));

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => mockIsNativePlatform,
  installSessionCookies: installSessionCookiesMock,
  waitForNativeSessionCookie: async () => {},
}));

mock.module("@/runtime/native-biometric", () => ({
  deleteBiometricToken: deleteBiometricTokenMock,
  isBiometricEnabled: () => mockIsBiometricEnabled,
  retrieveBiometricToken: retrieveBiometricTokenMock,
}));

const clearUserScopedStorageMock = mock(() => {});

mock.module("@/utils/onboarding-cleanup", () => ({
  syncOnboardingUser: syncOnboardingUserMock,
  clearOnboardingFlags: clearOnboardingFlagsMock,
}));

mock.module("@/lib/auth/session-cleanup", () => ({
  clearUserScopedStorage: clearUserScopedStorageMock,
}));

mock.module("@/stores/organization-store", () => ({
  clearOrganization: clearOrganizationMock,
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
  listAssistants: async () => [],
}));

const { useAuthStore } = await import("@/stores/auth-store");

function resetAuthStore(): void {
  useAuthStore.setState({
    isLoggedIn: false,
    isLoading: true,
    user: null,
    hasPlatformSession: false,
    platformSessionResolved: false,
  });
}

beforeEach(() => {
  sessionUser = null;
  getSessionCallCount = 0;
  getSessionFailFirstCall = false;
  getSessionGate = null;
  mockIsGatewayAuth = false;
  mockIsLocalMode = false;
  mockPlatformAssistants = [];
  mockIsNativePlatform = false;
  mockIsBiometricEnabled = false;
  mockBiometricToken = null;
  syncOnboardingUserMock.mockClear();
  clearOnboardingFlagsMock.mockClear();
  clearOrganizationMock.mockClear();
  clearUserScopedStorageMock.mockClear();
  logoutMock.mockClear();
  deleteBiometricTokenMock.mockClear();
  installSessionCookiesMock.mockClear();
  retrieveBiometricTokenMock.mockClear();
  lifecycleResetForLogoutMock.mockClear();
  resetAuthStore();
});

describe("auth store onboarding flag reconciliation", () => {
  test("initSession reconciles onboarding flags for the signed-in user", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };

    await useAuthStore.getState().initSession();

    expect(syncOnboardingUserMock).toHaveBeenCalledWith("user-1");
    expect(useAuthStore.getState().isLoggedIn).toBe(true);
    expect(useAuthStore.getState().isLoading).toBe(false);
  });

  test("refreshSession reconciles onboarding flags for a changed user", async () => {
    sessionUser = { id: "user-2", email: "user@example.com" };

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    expect(syncOnboardingUserMock).toHaveBeenCalledWith("user-2");
    expect(useAuthStore.getState().user?.id).toBe("user-2");
  });

  test("logout clears onboarding flags directly", async () => {
    await useAuthStore.getState().logout();

    expect(logoutMock).toHaveBeenCalled();
    expect(clearOnboardingFlagsMock).toHaveBeenCalled();
    expect(useAuthStore.getState().isLoggedIn).toBe(false);
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

  test("logout clears assistant lifecycle synchronously, before flipping isLoggedIn", async () => {
    // The lifecycle reset must happen before the auth state flips,
    // otherwise sync hooks like `useAssistantResourceSync` get one
    // re-render with the previous user's assistant id and fire
    // requests that 401. The order is verified by recording the
    // sequence of side effects vs the `isLoggedIn` flip.
    let isLoggedInAtResetTime = useAuthStore.getState().isLoggedIn;
    lifecycleResetForLogoutMock.mockImplementationOnce(() => {
      isLoggedInAtResetTime = useAuthStore.getState().isLoggedIn;
    });
    useAuthStore.setState({ isLoggedIn: true });

    await useAuthStore.getState().logout();

    expect(lifecycleResetForLogoutMock).toHaveBeenCalledTimes(1);
    expect(isLoggedInAtResetTime).toBe(true);
    expect(useAuthStore.getState().isLoggedIn).toBe(false);
  });
});

describe("platform session probe resolution", () => {
  // A returning local-gateway user re-runs the platform probe on app resume.
  // The gate must re-enter the "unknown" state for the probe window instead of
  // leaving a stale `true` from the previous probe — otherwise a cached
  // platform assistant stops standing in for the session and the onboarding
  // funnel can be raced past before the probe settles.
  test("a re-run gateway probe resets platformSessionResolved until it settles", async () => {
    mockIsGatewayAuth = true;
    mockIsLocalMode = false;
    sessionUser = { id: "user-1", email: "user@example.com" };
    useAuthStore.setState({
      platformSessionResolved: true,
      hasPlatformSession: false,
    });

    let releaseProbe!: () => void;
    getSessionGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);

    // Probe launched but not settled: state is unknown again, not a stale true.
    expect(useAuthStore.getState().platformSessionResolved).toBe(false);

    releaseProbe();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useAuthStore.getState().platformSessionResolved).toBe(true);
    expect(useAuthStore.getState().hasPlatformSession).toBe(true);
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
    expect(useAuthStore.getState().isLoggedIn).toBe(true);
    expect(useAuthStore.getState().user?.id).toBe("user-1");
  });

  test("initSession skips biometric recovery on web", async () => {
    mockIsNativePlatform = false;
    sessionUser = null;

    await useAuthStore.getState().initSession();

    expect(retrieveBiometricTokenMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isLoggedIn).toBe(false);
  });

  test("initSession skips biometric recovery when biometrics disabled", async () => {
    mockIsNativePlatform = true;
    mockIsBiometricEnabled = false;
    sessionUser = null;

    await useAuthStore.getState().initSession();

    expect(retrieveBiometricTokenMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isLoggedIn).toBe(false);
  });

  test("initSession falls through to unauthenticated when biometric token is expired", async () => {
    mockIsNativePlatform = true;
    mockIsBiometricEnabled = true;
    mockBiometricToken = "expired-token";
    sessionUser = null;

    await useAuthStore.getState().initSession();

    expect(installSessionCookiesMock).toHaveBeenCalledWith("expired-token");
    expect(useAuthStore.getState().isLoggedIn).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
  });
});
