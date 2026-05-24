import { beforeEach, describe, expect, mock, test } from "bun:test";

type MockSessionUser = {
  id?: string;
  username?: string;
  email?: string;
};

let sessionUser: MockSessionUser | null = null;
const syncOnboardingUserMock = mock((_userId: string | null) => {});
const clearOrganizationMock = mock(() => {});
const logoutMock = mock(async () => {});

mock.module("@/lib/auth/allauth-client.js", () => ({
  getSession: async () => {
    if (!sessionUser) {
      return { ok: false, status: 401, error: { detail: "Unauthorized" } };
    }
    return { ok: true, data: { user: sessionUser } };
  },
  logout: logoutMock,
}));

mock.module("@/domains/onboarding/prefs.js", () => ({
  syncOnboardingUser: syncOnboardingUserMock,
}));

mock.module("@/stores/organization-store.js", () => ({
  clearOrganization: clearOrganizationMock,
}));

mock.module("@/stores/event-bus-store.js", () => ({
  useEventBusStore: {
    getState: () => ({
      subscribe: () => () => {},
    }),
  },
}));

const { useAuthStore } = await import("@/stores/auth-store.js");

function resetAuthStore(): void {
  useAuthStore.setState({
    isLoggedIn: false,
    isLoading: true,
    user: null,
  });
}

beforeEach(() => {
  sessionUser = null;
  syncOnboardingUserMock.mockClear();
  clearOrganizationMock.mockClear();
  logoutMock.mockClear();
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

  test("logout keeps onboarding reconciliation on the shared auth path", async () => {
    await useAuthStore.getState().logout();

    expect(logoutMock).toHaveBeenCalled();
    expect(syncOnboardingUserMock).toHaveBeenCalledWith(null);
    expect(useAuthStore.getState().isLoggedIn).toBe(false);
  });
});
