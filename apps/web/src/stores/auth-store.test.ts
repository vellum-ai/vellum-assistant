import { beforeEach, describe, expect, mock, test } from "bun:test";

type MockSessionUser = {
  id?: string;
  username?: string;
  email?: string;
};

let sessionUser: MockSessionUser | null = null;
let getSessionCallCount = 0;
let getSessionFailFirstCall = false;
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

mock.module("@/domains/onboarding/prefs", () => ({
  syncOnboardingUser: syncOnboardingUserMock,
  clearOnboardingFlags: clearOnboardingFlagsMock,
}));

mock.module("@/lib/auth/session-cleanup", () => ({
  clearUserScopedStorage: clearUserScopedStorageMock,
}));

mock.module("@/stores/organization-store", () => ({
  clearOrganization: clearOrganizationMock,
}));

mock.module("@/stores/event-bus-store", () => ({
  useEventBusStore: {
    getState: () => ({
      subscribe: () => () => {},
    }),
  },
}));

const { useAuthStore } = await import("@/stores/auth-store");

function resetAuthStore(): void {
  useAuthStore.setState({
    isLoggedIn: false,
    isLoading: true,
    user: null,
  });
}

beforeEach(() => {
  sessionUser = null;
  getSessionCallCount = 0;
  getSessionFailFirstCall = false;
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
