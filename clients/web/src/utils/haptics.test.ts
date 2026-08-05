import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── platform guard ───────────────────────────────────────────────────────────
//
// Platform detection is mocked so each native shell can be exercised without
// loading the Capacitor runtime.

let nativePlatform: "ios" | "android" | null = "ios";
mock.module("@/runtime/platform-detection", () => ({
  isNativeIOS: () => nativePlatform === "ios",
  isNativeMobile: () => nativePlatform !== null,
}));

// ── @capacitor/haptics (lazy-imported plugin Proxy) ──────────────────────────

let pluginError: Error | null = null;

const impactMock = mock(async (_options: { style: string }) => {
  if (pluginError) {
    throw pluginError;
  }
});
const notificationMock = mock(async (_options: { type: string }) => {
  if (pluginError) {
    throw pluginError;
  }
});

mock.module("@capacitor/haptics", () => ({
  Haptics: {
    impact: impactMock,
    notification: notificationMock,
  },
  ImpactStyle: {
    Light: "LIGHT",
    Medium: "MEDIUM",
    Heavy: "HEAVY",
  },
  NotificationType: {
    Success: "SUCCESS",
    Warning: "WARNING",
    Error: "ERROR",
  },
}));

const { haptic } = await import("@/utils/haptics");

beforeEach(() => {
  nativePlatform = "ios";
  pluginError = null;
  impactMock.mockClear();
  notificationMock.mockClear();
});

describe("haptic on iOS", () => {
  test("light() fires a Light impact", async () => {
    await haptic.light();

    expect(impactMock).toHaveBeenCalledTimes(1);
    expect(impactMock).toHaveBeenCalledWith({ style: "LIGHT" });
  });

  test("medium() fires a Medium impact", async () => {
    await haptic.medium();

    expect(impactMock).toHaveBeenCalledTimes(1);
    expect(impactMock).toHaveBeenCalledWith({ style: "MEDIUM" });
  });

  test("success() fires a Success notification", async () => {
    await haptic.success();

    expect(notificationMock).toHaveBeenCalledTimes(1);
    expect(notificationMock).toHaveBeenCalledWith({ type: "SUCCESS" });
  });

  test("error() fires an Error notification", async () => {
    await haptic.error();

    expect(notificationMock).toHaveBeenCalledTimes(1);
    expect(notificationMock).toHaveBeenCalledWith({ type: "ERROR" });
  });
});

describe("haptic on Android", () => {
  test("only fires the pull-to-refresh threshold impact", async () => {
    nativePlatform = "android";

    await haptic.light();
    await haptic.medium();
    await haptic.success();
    await haptic.error();
    await haptic.refreshThreshold();

    expect(impactMock).toHaveBeenCalledTimes(1);
    expect(impactMock).toHaveBeenCalledWith({ style: "LIGHT" });
    expect(notificationMock).not.toHaveBeenCalled();
  });
});

describe("haptic on web", () => {
  test("never touches the plugin", async () => {
    nativePlatform = null;

    await haptic.light();
    await haptic.medium();
    await haptic.success();
    await haptic.error();
    await haptic.refreshThreshold();

    expect(impactMock).not.toHaveBeenCalled();
    expect(notificationMock).not.toHaveBeenCalled();
  });
});

describe("haptic error handling", () => {
  test("resolves even when the plugin throws (best-effort)", async () => {
    pluginError = new Error("haptics unavailable");

    await expect(haptic.light()).resolves.toBeUndefined();
    await expect(haptic.medium()).resolves.toBeUndefined();
    await expect(haptic.success()).resolves.toBeUndefined();
    await expect(haptic.error()).resolves.toBeUndefined();

    expect(impactMock).toHaveBeenCalledTimes(2);
    expect(notificationMock).toHaveBeenCalledTimes(2);
  });
});
