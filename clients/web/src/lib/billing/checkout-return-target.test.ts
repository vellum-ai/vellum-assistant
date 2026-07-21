import { afterEach, describe, expect, test } from "bun:test";

import { checkoutReturnTarget } from "./checkout-return-target";

afterEach(() => {
  delete (window as { vellum?: unknown }).vellum;
});

describe("checkoutReturnTarget", () => {
  test("web on a plain browser — a browser can't open the vellum:// bounce", () => {
    expect(checkoutReturnTarget()).toBe("web");
  });

  test("web on Capacitor iOS — Checkout stays in the in-app browser", () => {
    // Capacitor exposes no `window.vellum`, so `isElectron()` is false there
    // and iOS keeps the existing web return.
    expect(checkoutReturnTarget()).toBe("web");
  });

  test("native inside the Electron shell — Checkout opens in the system browser", () => {
    (window as { vellum?: unknown }).vellum = { platform: "electron" };

    expect(checkoutReturnTarget()).toBe("native");
  });
});
