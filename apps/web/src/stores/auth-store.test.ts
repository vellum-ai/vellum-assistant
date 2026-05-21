import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

interface SessionResult {
  ok: boolean;
  data: {
    user: {
      id?: string;
      username?: string;
      email?: string | null;
      is_staff?: boolean;
    } | null;
  };
}

const getSession = mock(
  async (): Promise<SessionResult> => ({ ok: false, data: { user: null } }),
);
const allauthLogout = mock(async () => undefined);
const isLocalMode = mock(() => false);

mock.module("@/lib/auth/allauth-client", () => ({
  getSession,
  logout: allauthLogout,
}));

mock.module("@/lib/auth/mode", () => ({
  isLocalMode,
  getAuthMode: () => (isLocalMode() ? "local" : "cloud"),
}));

// Import after mocks so the store sees them.
const { useAuthStore } = await import("./auth-store.js");

function resetStore() {
  useAuthStore.setState({ isLoggedIn: false, isLoading: true, user: null });
}

beforeEach(() => {
  getSession.mockClear();
  allauthLogout.mockClear();
  isLocalMode.mockReset();
  isLocalMode.mockImplementation(() => false);
  resetStore();
});

afterEach(() => {
  resetStore();
});

describe("auth-store — local mode", () => {
  test("initSession skips the allauth probe and boots logged-in", async () => {
    isLocalMode.mockImplementation(() => true);

    await useAuthStore.getState().initSession();

    expect(getSession).not.toHaveBeenCalled();
    const state = useAuthStore.getState();
    expect(state.isLoggedIn).toBe(true);
    expect(state.isLoading).toBe(false);
    expect(state.user).not.toBeNull();
    expect(state.user?.id).toBe("local");
  });

  test("refreshSession is a no-op that reports success", async () => {
    isLocalMode.mockImplementation(() => true);
    await useAuthStore.getState().initSession();
    getSession.mockClear();

    const ok = await useAuthStore.getState().refreshSession();

    expect(ok).toBe(true);
    expect(getSession).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isLoggedIn).toBe(true);
  });

  test("logout does not call allauth and leaves state intact", async () => {
    isLocalMode.mockImplementation(() => true);
    await useAuthStore.getState().initSession();

    await useAuthStore.getState().logout();

    expect(allauthLogout).not.toHaveBeenCalled();
    // Local mode keeps the synthetic user; logout is a no-op.
    expect(useAuthStore.getState().isLoggedIn).toBe(true);
  });
});

describe("auth-store — cloud mode (default)", () => {
  test("initSession probes allauth and sets isLoggedIn on success", async () => {
    getSession.mockImplementation(async () => ({
      ok: true,
      data: {
        user: {
          id: "cloud-user-1",
          username: "cloud",
          email: "cloud@example.com",
          is_staff: false,
        },
      },
    }));

    await useAuthStore.getState().initSession();

    expect(getSession).toHaveBeenCalledTimes(1);
    const state = useAuthStore.getState();
    expect(state.isLoggedIn).toBe(true);
    expect(state.user?.id).toBe("cloud-user-1");
  });

  test("initSession leaves the user logged-out when allauth has no session", async () => {
    getSession.mockImplementation(async () => ({
      ok: false,
      data: { user: null },
    }));

    await useAuthStore.getState().initSession();

    const state = useAuthStore.getState();
    expect(state.isLoggedIn).toBe(false);
    expect(state.user).toBeNull();
  });

  test("logout calls allauth", async () => {
    getSession.mockImplementation(async () => ({
      ok: true,
      data: {
        user: {
          id: "cloud-user-2",
          username: "cloud2",
          email: null,
        },
      },
    }));
    await useAuthStore.getState().initSession();

    await useAuthStore.getState().logout();

    expect(allauthLogout).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isLoggedIn).toBe(false);
  });
});
