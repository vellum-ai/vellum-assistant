import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { BrowserOptions, ErrorEvent } from "@sentry/react";

import { recordUpdate, resetCommitPressure } from "@/lib/commit-pressure";

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
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => nativePlatform,
}));
mock.module("@/runtime/is-electron", () => ({ isElectron: () => electron }));

// Distinct per-host DSNs so a swapped branch is caught (readonly at the type
// level only; the underlying object is writable at runtime).
const env = import.meta.env as Record<string, string | undefined>;
env.VITE_SENTRY_DSN = "https://web@example.com/web";
env.VITE_SENTRY_DSN_IOS = "https://ios@example.com/ios";
env.VITE_SENTRY_DSN_MACOS = "https://macos@example.com/macos";

const { initSentry } = await import("@/lib/sentry/sentry-init");

beforeEach(() => {
  syncedOptions = undefined;
  nativePlatform = false;
  electron = false;
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

describe("initSentry commit-pressure enrichment", () => {
  function sendEvent(message: string): ErrorEvent | null {
    initSentry();
    const beforeSend = syncedOptions?.beforeSend;
    if (!beforeSend) {
      throw new Error("beforeSend not configured");
    }
    const event = {
      exception: { values: [{ type: "Error", value: message }] },
    } as ErrorEvent;
    return beforeSend(event, {}) as ErrorEvent | null;
  }

  beforeEach(() => {
    resetCommitPressure();
  });

  test("attaches the pressure snapshot to a max-update-depth event", () => {
    recordUpdate("smooth-stream");
    recordUpdate("avatar-morph");
    recordUpdate("smooth-stream");

    const sent = sendEvent(
      "Maximum update depth exceeded. This can happen when a component repeatedly calls setState...",
    );

    const pressure = sent?.contexts?.commit_pressure as
      { updates: number; sources: Record<string, number> } | undefined;
    expect(pressure?.updates).toBe(3);
    expect(pressure?.sources["smooth-stream"]).toBe(2);
  });

  test("attaches to the MINIFIED form the production bundle actually throws", () => {
    // `react-dom-client.production.js` contains no occurrence of the expanded
    // sentence — it throws `formatProdErrorMessage(185)`. Sentry expands it
    // server-side, so an events-page reading of the message is misleading:
    // `beforeSend` sees this string. Matching only the dev text meant the
    // enrichment never ran in the builds it was written for.
    recordUpdate("smooth-stream");

    const sent = sendEvent(
      "Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.",
    );

    expect(sent?.contexts?.commit_pressure).toBeDefined();
  });

  test("does not match a different minified React error", () => {
    recordUpdate("smooth-stream");

    const sent = sendEvent(
      "Minified React error #186; visit https://react.dev/errors/186 for the full message.",
    );

    expect(sent?.contexts?.commit_pressure).toBeUndefined();
  });

  test("does not match a longer code that merely starts with 185", () => {
    recordUpdate("smooth-stream");

    const sent = sendEvent(
      "Minified React error #1850; visit https://react.dev/errors/1850 for the full message.",
    );

    expect(sent?.contexts?.commit_pressure).toBeUndefined();
  });

  test("leaves unrelated errors untouched", () => {
    recordUpdate("smooth-stream");

    const sent = sendEvent("Something else broke");

    expect(sent?.contexts?.commit_pressure).toBeUndefined();
  });

  test("passes the event through when the probe has no data", () => {
    const sent = sendEvent("Maximum update depth exceeded.");

    expect(sent).not.toBeNull();
    expect(sent?.contexts?.commit_pressure).toBeUndefined();
  });
});
