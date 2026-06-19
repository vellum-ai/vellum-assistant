import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Controllable mock state
// ---------------------------------------------------------------------------

let deviceDiagnostics = false;
let platformSession = "absent";
let mockClient:
  | { getOptions: () => { enabled?: boolean }; close: () => Promise<boolean> }
  | undefined;
let deviceWatchCallback: (() => void) | null = null;
let authSubscriber:
  | ((state: { platformSession: string }, prev: { platformSession: string }) => void)
  | null = null;

const initMock = mock((_opts: Record<string, unknown>) => {});
const setClientMock = mock((_client: unknown) => {});
const syncDiagnosticsToMainMock = mock((_enabled: boolean) => {});

mock.module("@sentry/react", () => ({
  init: initMock,
  getClient: () => mockClient,
  getCurrentScope: () => ({ setClient: setClientMock }),
}));

mock.module("@/utils/device-settings", () => ({
  getDeviceBool: (_key: string, _dflt: boolean) => deviceDiagnostics,
  watchDeviceSetting: (_name: string, cb: () => void) => {
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
    getState: () => ({ platformSession }),
    subscribe: (cb: typeof authSubscriber) => {
      authSubscriber = cb;
      return () => {
        authSubscriber = null;
      };
    },
  },
}));

const { syncSentryClient, diagnosticsConsentGranted, installSentryControlListeners } =
  await import("@/lib/sentry/sentry-control");

const OPTIONS = { dsn: "https://public@example.test/1" };

beforeEach(() => {
  initMock.mockReset();
  setClientMock.mockReset();
  syncDiagnosticsToMainMock.mockReset();
  mockClient = undefined;
  deviceDiagnostics = false;
  platformSession = "absent";
  deviceWatchCallback = null;
  authSubscriber = null;
});

describe("diagnosticsConsentGranted", () => {
  test("false without a live platform session even when the toggle is on", () => {
    deviceDiagnostics = true;
    platformSession = "absent";
    expect(diagnosticsConsentGranted()).toBe(false);
  });

  test("true only with a live session and the toggle on", () => {
    platformSession = "present";
    deviceDiagnostics = true;
    expect(diagnosticsConsentGranted()).toBe(true);
    deviceDiagnostics = false;
    expect(diagnosticsConsentGranted()).toBe(false);
  });
});

describe("syncSentryClient consent gate", () => {
  test("no live platform session: does not init even when the device toggle is on", () => {
    deviceDiagnostics = true;
    platformSession = "absent";
    syncSentryClient(OPTIONS);
    expect(initMock).not.toHaveBeenCalled();
  });

  test("live session + toggle on: inits the client enabled", () => {
    deviceDiagnostics = true;
    platformSession = "present";
    syncSentryClient(OPTIONS);
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock.mock.calls[0][0]).toMatchObject({ enabled: true });
  });

  test("live session + toggle off: closes a running client", () => {
    deviceDiagnostics = false;
    platformSession = "present";
    const closeMock = mock(() => Promise.resolve(true));
    mockClient = { getOptions: () => ({ enabled: true }), close: closeMock };
    syncSentryClient(OPTIONS);
    expect(initMock).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalled();
    expect(setClientMock).toHaveBeenCalledWith(undefined);
  });

  test("session lost while toggle on: closes the client (fail-closed offline)", () => {
    deviceDiagnostics = true;
    platformSession = "absent";
    const closeMock = mock(() => Promise.resolve(true));
    mockClient = { getOptions: () => ({ enabled: true }), close: closeMock };
    syncSentryClient(OPTIONS);
    expect(initMock).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalled();
  });
});

describe("installSentryControlListeners drives the Electron main process", () => {
  test("device toggle change syncs main with the session-gated value", () => {
    platformSession = "present";
    deviceDiagnostics = true;
    const stop = installSentryControlListeners(OPTIONS);

    syncDiagnosticsToMainMock.mockReset();
    deviceWatchCallback?.();
    expect(syncDiagnosticsToMainMock).toHaveBeenCalledWith(true);

    // Offline, the same toggle value tells main to disable.
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

    initMock.mockReset();
    syncDiagnosticsToMainMock.mockReset();
    platformSession = "present";
    authSubscriber?.({ platformSession: "present" }, { platformSession: "absent" });

    expect(initMock).toHaveBeenCalled();
    expect(syncDiagnosticsToMainMock).toHaveBeenCalledWith(true);

    stop();
  });
});
