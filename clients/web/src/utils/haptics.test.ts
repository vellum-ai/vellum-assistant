import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── platform guard ───────────────────────────────────────────────────────────
//
// `native-auth` is mocked rather than loaded because its module-load
// `registerPlugin("NativeAuth")` would fail outside a Capacitor runtime
// (mirrors push-registration.test.ts).

let isNative = true;
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => isNative,
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
  isNative = true;
  pluginError = null;
  impactMock.mockClear();
  notificationMock.mockClear();
});

describe("haptic on native", () => {
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

describe("haptic on web", () => {
  test("never touches the plugin", async () => {
    isNative = false;

    await haptic.light();
    await haptic.medium();
    await haptic.success();
    await haptic.error();

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
