import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { BrowserOptions } from "@sentry/react";

// Capture the options the init path dispatches so we can assert the resolved DSN.
let syncedOptions: BrowserOptions | undefined;

mock.module("@/lib/sentry/sentry-control", () => ({
  syncSentryClient: (options: BrowserOptions) => {
    syncedOptions = options;
  },
  installSentryControlListeners: () => () => {},
}));
mock.module("@/lib/sentry/consent-gate", () => ({
  diagnosticsConsentGranted: () => false,
}));
mock.module("@/runtime/diagnostics", () => ({
  syncDiagnosticsToMain: () => {},
}));
mock.module("@/utils/device-settings", () => ({
  getDeviceBool: () => false,
  watchDeviceSetting: () => () => {},
}));

let nativePlatform = false;
let electron = false;
let capacitorPlatform = "web";
mock.module("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => capacitorPlatform,
  },
}));
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => nativePlatform,
}));
mock.module("@/runtime/is-electron", () => ({ isElectron: () => electron }));

// Distinct per-host DSNs so a swapped branch is caught (readonly at the type
// level only; the underlying object is writable at runtime).
const env = import.meta.env as Record<string, string | undefined>;
env.VITE_SENTRY_DSN = "https://web@example.com/web";
env.VITE_SENTRY_DSN_IOS = "https://ios@example.com/ios";
env.VITE_SENTRY_DSN_ANDROID = "https://android@example.com/android";
env.VITE_SENTRY_DSN_MACOS = "https://macos@example.com/macos";

const { initSentry } = await import("@/lib/sentry/sentry-init");

beforeEach(() => {
  syncedOptions = undefined;
  nativePlatform = false;
  electron = false;
  capacitorPlatform = "web";
});

describe("initSentry DSN selection", () => {
  test("uses the web DSN off-native", () => {
    nativePlatform = false;
    initSentry();
    expect(syncedOptions?.dsn).toBe(import.meta.env.VITE_SENTRY_DSN);
  });

  test("uses the iOS DSN on native iOS", () => {
    nativePlatform = true;
    capacitorPlatform = "ios";
    initSentry();
    expect(syncedOptions?.dsn).toBe(import.meta.env.VITE_SENTRY_DSN_IOS);
  });

  test("uses the Android DSN on native Android", () => {
    nativePlatform = true;
    capacitorPlatform = "android";
    initSentry();
    expect(syncedOptions?.dsn).toBe(import.meta.env.VITE_SENTRY_DSN_ANDROID);
  });

  test("uses the macOS DSN in the Electron renderer", () => {
    electron = true;
    initSentry();
    expect(syncedOptions?.dsn).toBe(import.meta.env.VITE_SENTRY_DSN_MACOS);
  });
});

describe("initSentry client_os tag", () => {
  function clientOsTag(): unknown {
    return (
      syncedOptions?.initialScope as
        { tags?: Record<string, unknown> } | undefined
    )?.tags?.client_os;
  }

  test("tags every event with the detected OS surface (web off-native)", () => {
    initSentry();
    expect(clientOsTag()).toBe("web");
  });

  test("tags macos in the Electron renderer", () => {
    electron = true;
    initSentry();
    expect(clientOsTag()).toBe("macos");
  });
});
