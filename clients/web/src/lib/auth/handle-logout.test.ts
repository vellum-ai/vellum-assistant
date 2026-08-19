/**
 * Signing out on the non-local path replaces the page with `hardNavigate`,
 * which runs no React unmount cleanup. Everything the app is publishing to a
 * surface that outlives the page has to be given up here instead, in the last
 * tick a renderer still exists to publish from.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import type * as WatchController from "@/domains/chat/watch/watch-controller";

/** Every teardown call in the order it happened, which is the whole point. */
const order: string[] = [];

const stopWatchMock = mock(() => {
  order.push("stopWatch");
});
const clearWorkingMock = mock(() => {
  order.push("clearCompanionWorking");
});
const hardNavigateMock = mock((_url: string) => {
  order.push("hardNavigate");
});
const navigateMock = mock((_to: string) => {
  order.push("navigate");
});
const logoutMock = mock(async () => {
  order.push("logout");
});

let isLocal = false;

mock.module(
  "@/domains/chat/watch/watch-controller",
  (): Partial<typeof WatchController> => ({
    stopWatch: stopWatchMock,
  }),
);

mock.module("@/runtime/companion-surface", () => ({
  clearCompanionWorking: clearWorkingMock,
}));

mock.module("@/lib/auth/hard-navigate", () => ({
  hardNavigate: hardNavigateMock,
}));

mock.module("@/lib/local-mode", () => ({
  isLocalClient: () => isLocal,
  getActiveAssistant: () => null,
  isLocalAssistant: () => false,
}));

mock.module("@/runtime/identity", () => ({
  setAssistantName: () => undefined,
}));

mock.module("@/runtime/menu", () => ({
  setMenuPlatformSession: async () => undefined,
}));

mock.module("@/domains/onboarding/gate", () => ({
  getOnboardingEntrypoint: () => "/onboarding",
}));

mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    getState: () => ({ logout: logoutMock }),
    setState: () => undefined,
  },
}));

const { handleLogout } = await import("./handle-logout");

/**
 * Where a teardown call landed, refusing an absent one rather than reporting
 * `-1`. Without this every ordering assertion below would also pass when the
 * call it is ordering is not made at all.
 */
const at = (label: string): number => {
  const index = order.indexOf(label);
  if (index === -1) {
    throw new Error(`Expected ${label} to have been called, got: ${order}`);
  }
  return index;
};

afterEach(() => {
  order.length = 0;
  stopWatchMock.mockClear();
  clearWorkingMock.mockClear();
  hardNavigateMock.mockClear();
  navigateMock.mockClear();
  logoutMock.mockClear();
  isLocal = false;
});

describe("the watch session when the user signs out", () => {
  /**
   * The failure this guards is a capture indicator that stays lit after the
   * session is gone. A user who signs out and still sees the ring has been
   * told their screen is being read when it is not, which is the same harm as
   * a real capture nothing draws.
   */
  test("is ended on the path that replaces the page", async () => {
    await handleLogout(navigateMock as never);

    expect(stopWatchMock).toHaveBeenCalledTimes(1);
  });

  test("is ended before the navigation that would strand it", async () => {
    await handleLogout(navigateMock as never);

    expect(at("stopWatch")).toBeLessThan(at("hardNavigate"));
  });

  /**
   * Stopping republishes the whole context with `working` recomputed from the
   * live stores, so a turn still in flight would put the ring back if the
   * clear ran first.
   */
  test("is ended before the working claim is given up", async () => {
    await handleLogout(navigateMock as never);

    expect(at("stopWatch")).toBeLessThan(at("clearCompanionWorking"));
  });

  test("waits for the sign-out itself, so nothing is torn down early", async () => {
    await handleLogout(navigateMock as never);

    expect(at("logout")).toBeLessThan(at("stopWatch"));
  });
});
