import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Unit coverage for the main-process Sentry consent gate. The key contract:
 * main starts fail-closed (no init from the persisted value, since main boots
 * before the renderer can apply the live-session gate) and only enables when
 * the renderer pushes the effective consent over IPC — applied directly so an
 * unchanged persisted value still enforces the gate.
 *
 * `@sentry/node`, `electron`, and `./settings` are mocked so the module runs
 * without an Electron runtime. Each test file runs in its own process
 * (scripts/run-tests.ts), so these `mock.module` overrides don't leak.
 */

// Build-time globals injected by the bundler; define them so resolveOptions
// produces a non-null options object.
(globalThis as Record<string, unknown>).__SENTRY_DSN_MACOS__ =
  "https://public@example.test/1";
(globalThis as Record<string, unknown>).__VELLUM_ENVIRONMENT__ = "test";
(globalThis as Record<string, unknown>).__VELLUM_BUILD_SHA__ = "test-sha";

let sentryClient:
  | { getOptions: () => { enabled?: boolean }; close: () => Promise<boolean> }
  | undefined;

const initMock = mock((_opts: Record<string, unknown>) => {});
const setTagMock = mock((_k: string, _v: unknown) => {});
const setClientMock = mock((_c: unknown) => {});
const captureMessageMock = mock((_m: string, _o?: unknown) => {});

mock.module("@sentry/node", () => ({
  init: initMock,
  getClient: () => sentryClient,
  getCurrentScope: () => ({ setClient: setClientMock }),
  setTag: setTagMock,
  captureMessage: captureMessageMock,
}));

mock.module("electron", () => ({
  app: {
    isPackaged: false,
    on: mock(() => {}),
  },
}));

let settingChangeCb: ((newValue: boolean | undefined) => void) | null = null;
const writeSettingMock = mock((_key: string, _value: unknown) => {});

mock.module("./settings", () => ({
  onSettingChange: (_key: string, cb: (v: boolean | undefined) => void) => {
    settingChangeCb = cb;
    return () => {
      settingChangeCb = null;
    };
  },
  writeSetting: writeSettingMock,
}));

const { initSentryMain, setShareDiagnostics } = await import("./sentry");

beforeEach(() => {
  initMock.mockReset();
  setTagMock.mockReset();
  setClientMock.mockReset();
  writeSettingMock.mockReset();
  sentryClient = undefined;
  settingChangeCb = null;
});

describe("initSentryMain", () => {
  test("starts fail-closed: does not initialize Sentry at boot", () => {
    initSentryMain();
    expect(initMock).not.toHaveBeenCalled();
    // ...but it does register the mid-session watcher.
    expect(settingChangeCb).not.toBeNull();
  });
});

describe("setShareDiagnostics", () => {
  test("persists and enables Sentry directly, even when the watcher would not fire", () => {
    initSentryMain();
    initMock.mockReset();

    setShareDiagnostics(true);

    expect(writeSettingMock).toHaveBeenCalledWith("shareDiagnostics", true);
    // Enabled via the direct apply path, not the (unfired) change watcher.
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock.mock.calls[0][0]).toMatchObject({ enabled: true });
  });

  test("disabling closes a running client", () => {
    initSentryMain();
    const closeMock = mock(() => Promise.resolve(true));
    sentryClient = { getOptions: () => ({ enabled: true }), close: closeMock };

    setShareDiagnostics(false);

    expect(writeSettingMock).toHaveBeenCalledWith("shareDiagnostics", false);
    expect(closeMock).toHaveBeenCalled();
    expect(setClientMock).toHaveBeenCalledWith(undefined);
  });
});

describe("mid-session toggle watcher", () => {
  test("flipping the stored value on enables, off closes", () => {
    initSentryMain();

    settingChangeCb?.(true);
    expect(initMock).toHaveBeenCalledTimes(1);

    sentryClient = {
      getOptions: () => ({ enabled: true }),
      close: () => Promise.resolve(true),
    };
    settingChangeCb?.(false);
    expect(setClientMock).toHaveBeenCalledWith(undefined);
  });
});
