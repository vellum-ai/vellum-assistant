import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { BrowserOptions } from "@sentry/react";

import type { SentryFlavor } from "@/lib/sentry/flavor";

// ---------------------------------------------------------------------------
// Flavor seam — SDK access dispatches through selectSentryFlavor()
// ---------------------------------------------------------------------------

const initMock = mock((_options: BrowserOptions) => {});
const closeMock = mock(() => {});
let clientEnabled = false;

const flavor: SentryFlavor = {
  init: initMock,
  close: closeMock,
  getClientEnabled: () => clientEnabled,
};
const selectSentryFlavorMock = mock(() => flavor);

mock.module("@/lib/sentry/flavor", () => ({
  selectSentryFlavor: selectSentryFlavorMock,
}));

// ---------------------------------------------------------------------------
// Controllable mock state for the composed gate inputs
// ---------------------------------------------------------------------------

// device:diagnostics_reporting (effective gate); null models "never written",
// which resolves to the opt-out default (open) via the read fallback.
let deviceDiagnostics: boolean | null = null;
let platformSession = "absent";
let restoredOffline = false;

const readNames: string[] = [];
const watchedNames: string[] = [];
let deviceWatchCallback: (() => void) | null = null;
let authSubscriber:
  | ((
      state: { platformSession: string; platformSessionRestoredOffline: boolean },
      prev: { platformSession: string; platformSessionRestoredOffline: boolean },
    ) => void)
  | null = null;

const syncDiagnosticsToMainMock = mock((_enabled: boolean) => {});

mock.module("@/utils/device-settings", () => ({
  getDeviceBool: (name: string, fallback: boolean) => {
    readNames.push(name);
    return deviceDiagnostics ?? fallback;
  },
  watchDeviceSetting: (name: string, cb: () => void) => {
    watchedNames.push(name);
    deviceWatchCallback = cb;
    return () => {
      deviceWatchCallback = null;
    };
  },
}));

mock.module("@/runtime/diagnostics", () => ({
  syncDiagnosticsToMain: syncDiagnosticsToMainMock,
}));

mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    getState: () => ({
      platformSession,
      platformSessionRestoredOffline: restoredOffline,
    }),
    subscribe: (cb: typeof authSubscriber) => {
      authSubscriber = cb;
      return () => {
        authSubscriber = null;
      };
    },
  },
}));

const { syncSentryClient, installSentryControlListeners } = await import(
  "@/lib/sentry/sentry-control"
);
const { diagnosticsConsentGranted } = await import("@/lib/sentry/consent-gate");

const OPTIONS: BrowserOptions = { dsn: "https://public@example.test/1" };

beforeEach(() => {
  initMock.mockClear();
  closeMock.mockClear();
  selectSentryFlavorMock.mockClear();
  syncDiagnosticsToMainMock.mockReset();
  readNames.length = 0;
  watchedNames.length = 0;
  deviceWatchCallback = null;
  authSubscriber = null;
  deviceDiagnostics = null;
  platformSession = "absent";
  restoredOffline = false;
  clientEnabled = false;
});

describe("diagnosticsConsentGranted (composed gate)", () => {
  test("reads the effective diagnosticsReporting key, not the raw preference", () => {
    // Use a confirmed-live session so the gate reaches the device-key read
    // (it short-circuits to false before reading when no session is live).
    platformSession = "present";
    restoredOffline = false;
    diagnosticsConsentGranted();
    expect(readNames).toContain("diagnosticsReporting");
    expect(readNames).not.toContain("shareDiagnostics");
  });

  test("false without a confirmed live platform session even when the gate is on", () => {
    deviceDiagnostics = true;
    platformSession = "absent";
    expect(diagnosticsConsentGranted()).toBe(false);
  });

  test("false for a believed offline restore even when present + gate on", () => {
    deviceDiagnostics = true;
    platformSession = "present";
    restoredOffline = true;
    expect(diagnosticsConsentGranted()).toBe(false);
  });

  test("true only with a confirmed-live session AND the reporting gate not opted out", () => {
    platformSession = "present";
    restoredOffline = false;
    deviceDiagnostics = true;
    expect(diagnosticsConsentGranted()).toBe(true);
    deviceDiagnostics = false;
    expect(diagnosticsConsentGranted()).toBe(false);
  });

  test("an absent gate (never written) grants with a live session — opt-out default", () => {
    platformSession = "present";
    restoredOffline = false;
    deviceDiagnostics = null;
    expect(diagnosticsConsentGranted()).toBe(true);
  });
});

describe("syncSentryClient", () => {
  test("dispatches through the selected flavor", () => {
    deviceDiagnostics = true;
    platformSession = "present";
    syncSentryClient(OPTIONS);
    expect(selectSentryFlavorMock).toHaveBeenCalled();
  });

  test("no-ops when dsn is absent (never touches the flavor)", () => {
    deviceDiagnostics = true;
    platformSession = "present";
    syncSentryClient({});
    expect(initMock).not.toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
  });

  test("confirmed-live session + gate on: inits the flavor when no client is enabled", () => {
    deviceDiagnostics = true;
    platformSession = "present";
    clientEnabled = false;
    syncSentryClient(OPTIONS);
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock.mock.calls[0]![0]).toBe(OPTIONS);
    expect(closeMock).not.toHaveBeenCalled();
  });

  test("does not re-init when a client is already enabled", () => {
    deviceDiagnostics = true;
    platformSession = "present";
    clientEnabled = true;
    syncSentryClient(OPTIONS);
    expect(initMock).not.toHaveBeenCalled();
  });

  test("no live platform session: closes (fail-closed) even when the gate is on", () => {
    deviceDiagnostics = true;
    platformSession = "absent";
    syncSentryClient(OPTIONS);
    expect(initMock).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  test("live session + explicit opt-out: closes the flavor", () => {
    deviceDiagnostics = false;
    platformSession = "present";
    syncSentryClient(OPTIONS);
    expect(initMock).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});

describe("installSentryControlListeners drives both Sentry clients", () => {
  test("watches the diagnosticsReporting key and re-syncs through the flavor", () => {
    platformSession = "present";
    const stop = installSentryControlListeners(OPTIONS);
    expect(watchedNames).toEqual(["diagnosticsReporting"]);

    deviceDiagnostics = true;
    deviceWatchCallback?.();
    expect(initMock).toHaveBeenCalledTimes(1);

    stop();
  });

  test("device gate change syncs main with the session-gated value", () => {
    platformSession = "present";
    deviceDiagnostics = true;
    const stop = installSentryControlListeners(OPTIONS);

    syncDiagnosticsToMainMock.mockReset();
    deviceWatchCallback?.();
    expect(syncDiagnosticsToMainMock).toHaveBeenCalledWith(true);

    // Offline, the same gate value tells main to disable.
    platformSession = "absent";
    syncDiagnosticsToMainMock.mockReset();
    deviceWatchCallback?.();
    expect(syncDiagnosticsToMainMock).toHaveBeenCalledWith(false);

    stop();
  });

  test("a platform-session transition re-syncs both clients", () => {
    deviceDiagnostics = true;
    platformSession = "absent";
    const stop = installSentryControlListeners(OPTIONS);

    initMock.mockClear();
    syncDiagnosticsToMainMock.mockReset();
    platformSession = "present";
    authSubscriber?.(
      { platformSession: "present", platformSessionRestoredOffline: false },
      { platformSession: "absent", platformSessionRestoredOffline: false },
    );

    expect(initMock).toHaveBeenCalled();
    expect(syncDiagnosticsToMainMock).toHaveBeenCalledWith(true);

    stop();
  });

  test("a restored-offline → confirmed transition (present unchanged) re-syncs", () => {
    deviceDiagnostics = true;
    platformSession = "present";
    restoredOffline = true; // believed offline restore: telemetry off
    const stop = installSentryControlListeners(OPTIONS);

    initMock.mockClear();
    syncDiagnosticsToMainMock.mockReset();
    // A live probe confirms the session: present is unchanged, only the marker flips.
    restoredOffline = false;
    authSubscriber?.(
      { platformSession: "present", platformSessionRestoredOffline: false },
      { platformSession: "present", platformSessionRestoredOffline: true },
    );

    expect(initMock).toHaveBeenCalled();
    expect(syncDiagnosticsToMainMock).toHaveBeenCalledWith(true);

    stop();
  });

  test("cleanup removes both the device watch and the auth subscription", () => {
    const stop = installSentryControlListeners(OPTIONS);
    expect(deviceWatchCallback).not.toBeNull();
    expect(authSubscriber).not.toBeNull();
    stop();
    expect(deviceWatchCallback).toBeNull();
    expect(authSubscriber).toBeNull();
  });
});
