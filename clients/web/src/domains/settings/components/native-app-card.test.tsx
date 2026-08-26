/**
 * Pins which device the card promotes which store to, and the one device that
 * gets no card at all.
 *
 * Driven through `navigator.userAgent` rather than a module mock, so the real
 * detection helpers are what decide. `mock.module` here would replace
 * `platform-detection` for every other file in the same `bun test` run,
 * including the sibling suites that drive those helpers for real.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { NativeAppCard } from "@/domains/settings/components/native-app-card";
import { ANDROID_PLAY_STORE_URL } from "@/hooks/use-native-app-nudge";

const IPHONE_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
// A phone whose OS neither the iOS nor the Android check can name, caught
// only by the `Mobi` token.
const UNIDENTIFIED_PHONE_UA =
  "Mozilla/5.0 (Mobile; rv:109.0) Gecko/109.0 Firefox/115.0";
const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const ORIGINAL_UA = navigator.userAgent;
const ORIGINAL_PLATFORM = navigator.platform;

function setUserAgent(ua: string): void {
  Object.defineProperty(navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
}

function setPlatform(platform: string): void {
  Object.defineProperty(navigator, "platform", {
    value: platform,
    configurable: true,
  });
}

const env = import.meta.env as Record<string, string | undefined>;
const originalPlayStoreUrl = env.VITE_ANDROID_PLAY_STORE_URL;
const originalWindowOpen = window.open;

beforeEach(() => {
  localStorage.clear();
  delete env.VITE_ANDROID_PLAY_STORE_URL;
  setUserAgent(DESKTOP_CHROME_UA);
  setPlatform("Win32");
});

afterEach(() => {
  cleanup();
  window.open = originalWindowOpen;
  setUserAgent(ORIGINAL_UA);
  setPlatform(ORIGINAL_PLATFORM);
  if (originalPlayStoreUrl === undefined) {
    delete env.VITE_ANDROID_PLAY_STORE_URL;
  } else {
    env.VITE_ANDROID_PLAY_STORE_URL = originalPlayStoreUrl;
  }
});

describe("NativeAppCard", () => {
  test("promotes the App Store listing on iOS", () => {
    setUserAgent(IPHONE_CHROME_UA);
    const open = mock(() => null);
    window.open = open as typeof window.open;

    render(<NativeAppCard />);

    expect(screen.getByText("Get the iOS App")).toBeDefined();
    expect(
      screen.getByText("The Vellum iOS app gives you a native experience."),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    expect(open).toHaveBeenCalledWith(
      "https://apps.apple.com/us/app/vellum-assistant/id6759934423",
      "_blank",
      "noopener,noreferrer",
    );
    expect(localStorage.getItem("app.iosNudge.downloaded")).toBe("true");
  });

  test("promotes the App Store listing on iOS Safari", () => {
    // `useIsIOSWeb` opts Safari out (Apple's Smart App Banner covers it), but
    // the card still names the store rather than the generic downloads page.
    setUserAgent(IPHONE_SAFARI_UA);
    const open = mock(() => null);
    window.open = open as typeof window.open;

    render(<NativeAppCard />);

    expect(screen.getByText("Get the iOS App")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    expect(open).toHaveBeenCalledWith(
      "https://apps.apple.com/us/app/vellum-assistant/id6759934423",
      "_blank",
      "noopener,noreferrer",
    );
  });

  test("opens a configured Android listing and records the action", () => {
    setUserAgent(ANDROID_UA);
    env.VITE_ANDROID_PLAY_STORE_URL =
      "https://play.google.com/store/apps/details?id=ai.vellum.assistant";
    const open = mock(() => null);
    window.open = open as typeof window.open;
    render(<NativeAppCard />);

    expect(screen.getByText("Get the Android App")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    expect(open).toHaveBeenCalledWith(
      ANDROID_PLAY_STORE_URL,
      "_blank",
      "noopener,noreferrer",
    );
    expect(localStorage.getItem("app.androidNudge.downloaded")).toBe("true");
    expect(localStorage.getItem("app.iosNudge.downloaded")).toBeNull();
  });

  test("offers the downloads page when no Play listing is configured", () => {
    setUserAgent(ANDROID_UA);
    const open = mock(() => null);
    window.open = open as typeof window.open;

    render(<NativeAppCard />);

    expect(screen.getByText("Get the Vellum Mobile App")).toBeDefined();
    expect(
      screen.getByText("The Vellum mobile app gives you a native experience."),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    expect(open).toHaveBeenCalledWith(
      "https://www.vellum.ai/downloads",
      "_blank",
      "noopener,noreferrer",
    );
    expect(localStorage.getItem("app.mobileNudge.downloaded")).toBe("true");
    expect(localStorage.getItem("app.androidNudge.downloaded")).toBeNull();
  });

  test("promotes the app on a mobile browser it cannot identify", () => {
    setUserAgent(UNIDENTIFIED_PHONE_UA);

    render(<NativeAppCard />);

    expect(screen.getByText("Get the Vellum Mobile App")).toBeDefined();
  });

  test("renders nothing outside mobile web", () => {
    const { container } = render(<NativeAppCard />);

    expect(container.innerHTML).toBe("");
  });

  test("records the download before opening the store", () => {
    setUserAgent(UNIDENTIFIED_PHONE_UA);
    // Opening the store can navigate the page away, so the flag has to land
    // first or the nudge comes back on the next visit.
    const downloadedWhenOpened: Array<string | null> = [];
    window.open = mock(() => {
      downloadedWhenOpened.push(
        localStorage.getItem("app.mobileNudge.downloaded"),
      );
      return null;
    }) as typeof window.open;

    render(<NativeAppCard />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    expect(downloadedWhenOpened).toEqual(["true"]);
  });
});
