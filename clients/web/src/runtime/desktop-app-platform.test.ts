import { afterEach, expect, mock, test } from "bun:test";

let electron = false;

mock.module("@/runtime/is-electron", () => ({ isElectron: () => electron }));

const { detectDesktopAppPlatform, isKnownUnsupportedDesktopBrowser } =
  await import("@/runtime/desktop-app-platform");

const ORIGINAL_UA = navigator.userAgent;
const ORIGINAL_PLATFORM = navigator.platform;
const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function setUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: userAgent,
  });
}

function setPlatform(platform: string): void {
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: platform,
  });
}

function setUserAgentPlatform(platform?: string): void {
  Object.defineProperty(navigator, "userAgentData", {
    configurable: true,
    value: platform ? { platform } : undefined,
  });
}

function setElectronHost(hostOS: "macos" | "windows"): void {
  electron = true;
  (
    window as unknown as {
      vellum?: { platform: "electron"; hostOS: "macos" | "windows" };
    }
  ).vellum = { platform: "electron", hostOS };
}

afterEach(() => {
  electron = false;
  delete (window as unknown as { vellum?: unknown }).vellum;
  setUserAgent(ORIGINAL_UA);
  setPlatform(ORIGINAL_PLATFORM);
  setUserAgentPlatform();
});

test("uses the Electron host OS", () => {
  setElectronHost("windows");
  expect(detectDesktopAppPlatform()).toBe("windows");

  setElectronHost("macos");
  expect(detectDesktopAppPlatform()).toBe("macos");
});

test("detects Windows from browser platform signals", () => {
  setUserAgentPlatform("Windows");
  setPlatform("MacIntel");
  expect(detectDesktopAppPlatform()).toBe("windows");

  setUserAgentPlatform();
  setPlatform("Win32");
  expect(detectDesktopAppPlatform()).toBe("windows");

  setPlatform("");
  setUserAgent(WINDOWS_UA);
  expect(detectDesktopAppPlatform()).toBe("windows");
});

test("defaults unknown browser platforms to macOS", () => {
  setUserAgent("Mozilla/5.0 AppleWebKit/537.36 Safari/537.36");
  setPlatform("");
  expect(detectDesktopAppPlatform()).toBe("macos");
  expect(isKnownUnsupportedDesktopBrowser()).toBe(false);
});

test("identifies known unsupported desktop browsers", () => {
  setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36");
  setPlatform("Linux x86_64");
  expect(isKnownUnsupportedDesktopBrowser()).toBe(true);

  setUserAgent("Mozilla/5.0 (X11; CrOS x86_64 16093.68.0) AppleWebKit/537.36");
  setPlatform("Linux x86_64");
  expect(isKnownUnsupportedDesktopBrowser()).toBe(true);
});
