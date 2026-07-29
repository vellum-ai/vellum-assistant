/**
 * Unit tests for `initNativeKeyboard`.
 *
 * These pin the platform gate and the backwards-compat contract: shells built
 * before `@capacitor/keyboard` was linked reject the call, and boot must not
 * surface that as an error.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let mockIsNativeIOS = false;
mock.module("@/runtime/platform-detection", () => ({
  isNativeIOS: () => mockIsNativeIOS,
}));

const setAccessoryBarVisible = mock(
  async (_options: { isVisible: boolean }) => {},
);
mock.module("@capacitor/keyboard", () => ({
  Keyboard: { setAccessoryBarVisible },
}));

const { initNativeKeyboard } = await import("@/runtime/native-keyboard");

beforeEach(() => {
  mockIsNativeIOS = false;
  setAccessoryBarVisible.mockClear();
});

describe("initNativeKeyboard", () => {
  test("never touches the plugin outside the native iOS shell", async () => {
    await initNativeKeyboard();
    expect(setAccessoryBarVisible).not.toHaveBeenCalled();
  });

  test("declares the accessory bar hidden inside the native iOS shell", async () => {
    mockIsNativeIOS = true;
    await initNativeKeyboard();
    expect(setAccessoryBarVisible).toHaveBeenCalledTimes(1);
    expect(setAccessoryBarVisible).toHaveBeenCalledWith({ isVisible: false });
  });

  test("swallows a rejection from a shell without the plugin", async () => {
    mockIsNativeIOS = true;
    setAccessoryBarVisible.mockImplementationOnce(async () => {
      throw new Error("not implemented");
    });
    await initNativeKeyboard();
    expect(setAccessoryBarVisible).toHaveBeenCalledTimes(1);
  });
});
