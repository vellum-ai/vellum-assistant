/**
 * Tests for the `AppIcon` bridge.
 *
 * The contract under test is skew-safety: the iOS shell ships through App
 * Store review while this bundle deploys continuously, so an arbitrarily old
 * shell can host it with no such plugin compiled in. Every degrade path
 * (non-iOS platform, missing plugin, a rejecting bridge) must resolve the
 * feature-off state without throwing and without touching the bridge.
 *
 * Self-contained mocks: run this file solo (`mock.module` leaks across a
 * shared `bun test` run).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let onNativeIOS = true;
let pluginAvailable = true;

mock.module("@/runtime/platform-detection", () => ({
  isNativeIOS: () => onNativeIOS,
}));

interface NativeState {
  supported?: boolean;
  current?: string | null;
  available?: string[];
}

let stateResult: NativeState = {
  supported: true,
  current: null,
  available: ["avatar-a", "avatar-b"],
};
let stateRejects = false;
let setResult: { ok?: boolean; error?: string } = { ok: true };
let setRejects = false;

const getStateMock = mock(async (): Promise<NativeState> => {
  if (stateRejects) {
    throw new Error("AppIcon.getState() is not implemented on ios");
  }
  return stateResult;
});
const setMock = mock(async (_options: { name: string | null }) => {
  if (setRejects) {
    throw new Error("AppIcon.set() is not implemented on ios");
  }
  return setResult;
});

mock.module("@capacitor/core", () => ({
  Capacitor: {
    isPluginAvailable: () => pluginAvailable,
  },
  registerPlugin: () => ({ getState: getStateMock, set: setMock }),
}));

const captureErrorMock = mock(() => {});
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: captureErrorMock,
}));

const { getAppIconState, setAppIcon } = await import("@/runtime/app-icon");

const OFF = { supported: false, current: null, available: [] };

beforeEach(() => {
  onNativeIOS = true;
  pluginAvailable = true;
  stateResult = {
    supported: true,
    current: null,
    available: ["avatar-a", "avatar-b"],
  };
  stateRejects = false;
  setResult = { ok: true };
  setRejects = false;
  getStateMock.mockClear();
  setMock.mockClear();
  captureErrorMock.mockClear();
});

describe("getAppIconState", () => {
  test("reports what the shell says when the plugin answers", async () => {
    stateResult = {
      supported: true,
      current: "avatar-b",
      available: ["avatar-a", "avatar-b"],
    };

    expect(await getAppIconState()).toEqual({
      supported: true,
      current: "avatar-b",
      available: ["avatar-a", "avatar-b"],
    });
  });

  test("degrades to feature-off without calling the bridge off iOS", async () => {
    onNativeIOS = false;

    expect(await getAppIconState()).toEqual(OFF);
    expect(getStateMock).not.toHaveBeenCalled();
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  test("degrades to feature-off on a shell without the plugin", async () => {
    pluginAvailable = false;

    expect(await getAppIconState()).toEqual(OFF);
    expect(getStateMock).not.toHaveBeenCalled();
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  test("degrades to feature-off when the bridge call rejects", async () => {
    stateRejects = true;

    expect(await getAppIconState()).toEqual(OFF);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
  });

  test("fills in fields an older or newer shell omits", async () => {
    stateResult = {};

    expect(await getAppIconState()).toEqual(OFF);
  });
});

describe("setAppIcon", () => {
  test("resolves true only when the shell applied the change", async () => {
    expect(await setAppIcon("avatar-a")).toBe(true);
    expect(setMock).toHaveBeenCalledWith({ name: "avatar-a" });

    expect(await setAppIcon(null)).toBe(true);
    expect(setMock).toHaveBeenCalledWith({ name: null });
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  test("resolves false when the shell refuses the icon", async () => {
    setResult = { ok: false, error: "The icon is not in the bundle." };

    expect(await setAppIcon("avatar-missing")).toBe(false);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
  });

  test("resolves false when the bridge call rejects", async () => {
    setRejects = true;

    expect(await setAppIcon("avatar-a")).toBe(false);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
  });

  test("resolves false without calling the bridge off iOS or with no plugin", async () => {
    onNativeIOS = false;
    expect(await setAppIcon("avatar-a")).toBe(false);

    onNativeIOS = true;
    pluginAvailable = false;
    expect(await setAppIcon("avatar-a")).toBe(false);

    expect(setMock).not.toHaveBeenCalled();
    expect(captureErrorMock).not.toHaveBeenCalled();
  });
});
