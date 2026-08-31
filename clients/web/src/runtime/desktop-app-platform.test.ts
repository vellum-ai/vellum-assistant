import { afterEach, expect, mock, test } from "bun:test";

let electron = false;

mock.module("@/runtime/is-electron", () => ({ isElectron: () => electron }));

const { detectDesktopAppPlatform } = await import(
  "@/runtime/desktop-app-platform"
);

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
  setPlatform("Linux x86_64");
  expect(detectDesktopAppPlatform()).toBe("macos");
});
