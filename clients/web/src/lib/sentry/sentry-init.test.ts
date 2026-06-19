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
mock.module("@/runtime/diagnostics", () => ({ syncDiagnosticsToMain: () => {} }));
mock.module("@/utils/device-settings", () => ({
  getDeviceBool: () => false,
  watchDeviceSetting: () => () => {},
}));

let nativePlatform = false;
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => nativePlatform,
}));

// Distinct per-host DSNs so a swapped branch is caught (readonly at the type
// level only; the underlying object is writable at runtime).
const env = import.meta.env as Record<string, string | undefined>;
env.VITE_SENTRY_DSN = "https://web@example.com/web";
env.VITE_SENTRY_DSN_IOS = "https://ios@example.com/ios";

const { initSentry } = await import("@/lib/sentry/sentry-init");

beforeEach(() => {
  syncedOptions = undefined;
  nativePlatform = false;
});

describe("initSentry DSN selection", () => {
  test("uses the web DSN off-native", () => {
    nativePlatform = false;
    initSentry();
    expect(syncedOptions?.dsn).toBe(import.meta.env.VITE_SENTRY_DSN);
  });

  test("uses the iOS DSN on native", () => {
    nativePlatform = true;
    initSentry();
    expect(syncedOptions?.dsn).toBe(import.meta.env.VITE_SENTRY_DSN_IOS);
  });
});
