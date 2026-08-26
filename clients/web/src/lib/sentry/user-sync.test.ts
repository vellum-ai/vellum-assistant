import { beforeEach, describe, expect, mock, test } from "bun:test";

import type * as Flavor from "@/lib/sentry/flavor";
import type * as DeviceId from "@/runtime/device-id";
import type { AuthUser } from "@/stores/auth-store";

const setUserMock = mock((_user: { id: string } | null) => {});
let deviceId: string | null = null;

mock.module(
  "@/lib/sentry/flavor",
  (): Partial<typeof Flavor> => ({
    selectSentryFlavor: () => ({
      init: () => {},
      close: () => {},
      getClientEnabled: () => true,
      setUser: setUserMock,
    }),
  }),
);
mock.module(
  "@/runtime/device-id",
  (): Partial<typeof DeviceId> => ({
    getDeviceId: () => deviceId,
  }),
);

const { installSentryUserSync, reapplySentryUser } =
  await import("@/lib/sentry/user-sync");
const { useAuthStore } = await import("@/stores/auth-store");

const PLATFORM_USER: AuthUser = {
  kind: "platform",
  id: "user-uuid-1",
  username: "ada",
  email: "ada@example.com",
  isStaff: false,
  firstName: "Ada",
  lastName: "L",
};

const LOCAL_USER: AuthUser = {
  kind: "local",
  id: "gateway-local",
  username: "local",
  email: null,
  isStaff: false,
  firstName: "",
  lastName: "",
};

describe("installSentryUserSync", () => {
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    cleanup?.();
    cleanup = null;
    setUserMock.mockClear();
    deviceId = null;
    useAuthStore.setState({ user: null });
  });

  test("stamps the platform account id and clears it on sign-out", () => {
    useAuthStore.setState({ user: PLATFORM_USER });
    cleanup = installSentryUserSync();
    expect(setUserMock).toHaveBeenLastCalledWith({ id: "user-uuid-1" });

    useAuthStore.setState({ user: null });
    expect(setUserMock).toHaveBeenLastCalledWith(null);
  });

  test("follows a user who signs in after install", () => {
    cleanup = installSentryUserSync();
    expect(setUserMock).toHaveBeenLastCalledWith(null);

    useAuthStore.setState({ user: PLATFORM_USER });
    expect(setUserMock).toHaveBeenLastCalledWith({ id: "user-uuid-1" });
  });

  test("identifies local sessions by device id, not the shared synthetic id", () => {
    deviceId = "device-abc";
    useAuthStore.setState({ user: LOCAL_USER });
    cleanup = installSentryUserSync();
    expect(setUserMock).toHaveBeenLastCalledWith({ id: "device-abc" });
  });

  test("falls back to the synthetic id when no device id exists", () => {
    useAuthStore.setState({ user: LOCAL_USER });
    cleanup = installSentryUserSync();
    expect(setUserMock).toHaveBeenLastCalledWith({ id: "gateway-local" });
  });

  test("never identifies by the email or username fallback ids", () => {
    useAuthStore.setState({
      user: { ...PLATFORM_USER, id: PLATFORM_USER.email },
    });
    cleanup = installSentryUserSync();
    expect(setUserMock).toHaveBeenLastCalledWith(null);

    useAuthStore.setState({
      user: { ...PLATFORM_USER, id: PLATFORM_USER.username },
    });
    expect(setUserMock).toHaveBeenLastCalledWith(null);
  });

  test("reapplySentryUser re-stamps the current identity on demand", () => {
    useAuthStore.setState({ user: PLATFORM_USER });
    setUserMock.mockClear();
    reapplySentryUser();
    expect(setUserMock).toHaveBeenLastCalledWith({ id: "user-uuid-1" });
  });

  test("stops following after cleanup", () => {
    cleanup = installSentryUserSync();
    setUserMock.mockClear();
    cleanup();
    cleanup = null;
    useAuthStore.setState({ user: PLATFORM_USER });
    expect(setUserMock).not.toHaveBeenCalled();
  });
});
