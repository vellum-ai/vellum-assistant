import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Unit coverage for the main-process Sentry consent gate, now backed by
 * `@sentry/electron/main`. The key contract: strict opt-in from the persisted
 * `shareDiagnostics` value, with a mid-session watcher that inits/closes when
 * the renderer pushes a new effective gate over IPC. Native crash capture
 * (Crashpad minidumps, renderer/child process crashes) rides on the default
 * `@sentry/electron/main` integrations, so init alone configures it.
 *
 * `@sentry/electron/main`, `electron`, and `./settings` are mocked so the
 * module runs without an Electron runtime. Each test file runs in its own
 * process (scripts/run-tests.ts), so these `mock.module` overrides don't leak.
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

mock.module("@sentry/electron/main", () => ({
  init: initMock,
  getClient: () => sentryClient,
  getCurrentScope: () => ({ setClient: setClientMock }),
  setTag: setTagMock,
}));

mock.module("electron", () => ({
  app: {
    isPackaged: false,
    on: mock(() => {}),
  },
}));

let settingChangeCb: ((newValue: boolean | undefined) => void) | null = null;
let storedConsent: boolean | undefined;
const writeSettingMock = mock((_key: string, _value: unknown) => {});

mock.module("./settings", () => ({
  readSetting: (_key: string) => storedConsent,
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
  storedConsent = undefined;
  settingChangeCb = null;
});

describe("initSentryMain", () => {
  test("does not initialize Sentry when consent is absent", () => {
    storedConsent = undefined;
    initSentryMain();
    expect(initMock).not.toHaveBeenCalled();
    // ...but it does register the mid-session watcher.
    expect(settingChangeCb).not.toBeNull();
  });

  test("does not initialize Sentry when consent is explicitly false", () => {
    storedConsent = false;
    initSentryMain();
    expect(initMock).not.toHaveBeenCalled();
  });

  test("initializes Sentry when consent is stored true", () => {
    storedConsent = true;
    initSentryMain();
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock.mock.calls[0][0]).toMatchObject({
      enabled: true,
      dsn: "https://public@example.test/1",
      tracesSampleRate: 0,
      attachStacktrace: true,
    });
    // Tags are applied so events carry process/arch/electron/packaged context.
    expect(setTagMock).toHaveBeenCalledWith("process", "main");
  });

  test("does not initialize when the DSN is empty", () => {
    (globalThis as Record<string, unknown>).__SENTRY_DSN_MACOS__ = "";
    storedConsent = true;
    initSentryMain();
    expect(initMock).not.toHaveBeenCalled();
    expect(settingChangeCb).toBeNull();
    (globalThis as Record<string, unknown>).__SENTRY_DSN_MACOS__ =
      "https://public@example.test/1";
  });
});

describe("mid-session toggle watcher", () => {
  test("flipping the stored value on inits, off closes", () => {
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

  test("does not re-init when a client is already enabled", () => {
    initSentryMain();
    sentryClient = {
      getOptions: () => ({ enabled: true }),
      close: () => Promise.resolve(true),
    };

    settingChangeCb?.(true);
    expect(initMock).not.toHaveBeenCalled();
  });
});

describe("setShareDiagnostics", () => {
  test("persists consent so the watcher drives the Sentry lifecycle", () => {
    setShareDiagnostics(true);
    expect(writeSettingMock).toHaveBeenCalledWith("shareDiagnostics", true);

    setShareDiagnostics(false);
    expect(writeSettingMock).toHaveBeenCalledWith("shareDiagnostics", false);
  });
});
