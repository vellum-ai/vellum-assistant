import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Controllable mock state
// ---------------------------------------------------------------------------

let deviceDiagnostics = false;
let platformSession = "absent";
let mockClient:
  | { getOptions: () => { enabled?: boolean }; close: () => Promise<boolean> }
  | undefined;

const initMock = mock((_opts: Record<string, unknown>) => {});
const setClientMock = mock((_client: unknown) => {});

mock.module("@sentry/react", () => ({
  init: initMock,
  getClient: () => mockClient,
  getCurrentScope: () => ({ setClient: setClientMock }),
}));

mock.module("@/utils/device-settings", () => ({
  getDeviceBool: (_key: string, _dflt: boolean) => deviceDiagnostics,
  watchDeviceSetting: () => () => {},
}));

mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    getState: () => ({ platformSession }),
    subscribe: () => () => {},
  },
}));

const { syncSentryClient } = await import("@/lib/sentry/sentry-control");

const OPTIONS = { dsn: "https://public@example.test/1" };

beforeEach(() => {
  initMock.mockReset();
  setClientMock.mockReset();
  mockClient = undefined;
  deviceDiagnostics = false;
  platformSession = "absent";
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
