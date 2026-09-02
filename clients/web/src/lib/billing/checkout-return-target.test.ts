import { afterEach, describe, expect, mock, test } from "bun:test";

// Drives `Capacitor.isNativePlatform()` so the iOS branch can be exercised.
// `registerPlugin` is a load-time dependency of `runtime/native-auth`, pulled
// in transitively via `runtime/platform-detection`.
let isNativePlatform = false;
mock.module("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => isNativePlatform,
    getPlatform: () => (isNativePlatform ? "ios" : "web"),
  },
  registerPlugin: () => ({}),
}));

const { checkoutReturnTarget } = await import("./checkout-return-target");

afterEach(() => {
  delete (window as { vellum?: unknown }).vellum;
  isNativePlatform = false;
});

describe("checkoutReturnTarget", () => {
  test("web on a plain browser: a browser can't open the vellum:// bounce", () => {
    expect(checkoutReturnTarget()).toBe("web");
  });

  test("native on Capacitor iOS: a web return would strand the session_id in the sheet", () => {
    // Checkout runs in an in-app SFSafariViewController, so the success URL
    // must bounce back through the custom scheme rather than load in the sheet.
    isNativePlatform = true;

    expect(checkoutReturnTarget()).toBe("native");
  });

  test("native inside the macOS Electron shell: Checkout opens in the system browser", () => {
    (window as { vellum?: unknown }).vellum = {
      platform: "electron",
      hostOS: "macos",
    };

    expect(checkoutReturnTarget()).toBe("native");
  });

  test("native on a legacy Electron bridge without hostOS: that shape is macOS-only", () => {
    (window as { vellum?: unknown }).vellum = { platform: "electron" };

    expect(checkoutReturnTarget()).toBe("native");
  });

  test("native inside the Windows Electron shell: argv deep links route the bounce back", () => {
    (window as { vellum?: unknown }).vellum = {
      platform: "electron",
      hostOS: "windows",
    };

    expect(checkoutReturnTarget()).toBe("native");
  });
});
