/**
 * Unit tests for `initNativePlatformAttributes`.
 *
 * The marker powers `native-mobile:` Tailwind utilities and platform-scoped
 * CSS, so these pin both Capacitor shells and repeated calls.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

let mockIsNativeIOS = false;
let mockIsNativeAndroid = false;
mock.module("@/runtime/platform-detection", () => ({
  isNativeIOS: () => mockIsNativeIOS,
  isNativeAndroid: () => mockIsNativeAndroid,
}));

const { initNativePlatformAttributes } =
  await import("@/runtime/native-platform-attributes");

afterEach(() => {
  mockIsNativeIOS = false;
  mockIsNativeAndroid = false;
  delete document.documentElement.dataset.nativePlatform;
});

describe("initNativePlatformAttributes", () => {
  test("leaves the marker unset outside native shells", () => {
    initNativePlatformAttributes();
    expect(document.documentElement.dataset.nativePlatform).toBeUndefined();
  });

  test("stamps the marker inside the native iOS shell", () => {
    mockIsNativeIOS = true;
    initNativePlatformAttributes();
    expect(document.documentElement.dataset.nativePlatform).toBe("ios");
  });

  test("stamps the marker inside the native Android shell", () => {
    mockIsNativeAndroid = true;
    initNativePlatformAttributes();
    expect(document.documentElement.dataset.nativePlatform).toBe("android");
  });

  test("is idempotent across repeated calls", () => {
    mockIsNativeIOS = true;
    initNativePlatformAttributes();
    initNativePlatformAttributes();
    expect(document.documentElement.dataset.nativePlatform).toBe("ios");
  });
});
