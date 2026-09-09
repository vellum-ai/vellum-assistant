import { describe, expect, test } from "bun:test";

import {
  appendLoggedInBrowserOffer,
  CHROME_WEB_STORE_INSTALL_URL,
  DESKTOP_APP_DOWNLOAD_URL,
  formatLoggedInBrowserOffer,
  isPhoneSurface,
  shouldOfferLoggedInBrowser,
} from "./capability-offer.js";

describe("isPhoneSurface", () => {
  test("is true for iOS transport and mobile client OS", () => {
    expect(isPhoneSurface({ transportInterface: "ios" })).toBe(true);
    expect(isPhoneSurface({ transportInterface: "phone" })).toBe(true);
    expect(isPhoneSurface({ clientOs: "ios" })).toBe(true);
    expect(isPhoneSurface({ clientOs: "android" })).toBe(true);
  });

  test("is false for desktop and web surfaces", () => {
    expect(isPhoneSurface({ transportInterface: "web" })).toBe(false);
    expect(isPhoneSurface({ transportInterface: "macos" })).toBe(false);
    expect(isPhoneSurface({ clientOs: "macos" })).toBe(false);
    expect(isPhoneSurface({})).toBe(false);
    expect(isPhoneSurface()).toBe(false);
  });
});

describe("shouldOfferLoggedInBrowser", () => {
  test("matches timeouts, unreachable hosts, and auth walls", () => {
    expect(
      shouldOfferLoggedInBrowser(
        "Navigation to https://intranet.example.com timed out after 15000ms",
      ),
    ).toBe(true);
    expect(shouldOfferLoggedInBrowser("net::ERR_CONNECTION_TIMED_OUT")).toBe(
      true,
    );
    expect(shouldOfferLoggedInBrowser("ENOTFOUND intranet.example.com")).toBe(
      true,
    );
    expect(shouldOfferLoggedInBrowser("host unreachable")).toBe(true);
    expect(shouldOfferLoggedInBrowser("login required")).toBe(true);
    expect(shouldOfferLoggedInBrowser("HTTP 403 Forbidden")).toBe(true);
  });

  test("does not match cancelled or invalid-input failures", () => {
    expect(shouldOfferLoggedInBrowser("operation was cancelled")).toBe(false);
    expect(shouldOfferLoggedInBrowser('Invalid browser_mode "bogus"')).toBe(
      false,
    );
    expect(shouldOfferLoggedInBrowser("url must use http or https")).toBe(false);
  });
});

describe("formatLoggedInBrowserOffer", () => {
  test("offers both install links and prefers them over a screenshot", () => {
    const offer = formatLoggedInBrowserOffer({ transportInterface: "web" });
    expect(offer).toContain(DESKTOP_APP_DOWNLOAD_URL);
    expect(offer).toContain(CHROME_WEB_STORE_INSTALL_URL);
    expect(offer).toContain("Offer those first");
    expect(offer).toContain("screenshot");
    expect(offer).not.toContain("daemon");
    expect(offer).not.toContain("browser panel");
  });

  test("is honest on a phone: no in-app browser, install on a computer", () => {
    const offer = formatLoggedInBrowserOffer({
      transportInterface: "ios",
      clientOs: "ios",
    });
    expect(offer).toContain("no in-app browser");
    expect(offer).toContain("Do not describe a browser panel");
    expect(offer).toContain("Mac or Windows PC");
    expect(offer).toContain(DESKTOP_APP_DOWNLOAD_URL);
    expect(offer).toContain(CHROME_WEB_STORE_INSTALL_URL);
  });
});

describe("appendLoggedInBrowserOffer", () => {
  test("appends the offer once", () => {
    const once = appendLoggedInBrowserOffer("Error: Navigation failed: timeout");
    expect(once).toContain("Error: Navigation failed: timeout");
    expect(once).toContain(DESKTOP_APP_DOWNLOAD_URL);
    const twice = appendLoggedInBrowserOffer(once);
    expect(twice).toBe(once);
  });
});
