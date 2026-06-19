import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Unit coverage for the main-process Sentry consent gate, backed by
 * `@sentry/electron/main`.
 *
 * Two contracts compose here:
 *  - Fail-closed boot: main does NOT init from the persisted `shareDiagnostics`
 *    value, because it boots before any renderer can apply the live-session
 *    gate; it only enables when the renderer pushes effective consent over IPC,
 *    applied directly so an unchanged persisted value still enforces the gate.
 *  - One-shot init: `@sentry/electron/main` init() starts Crashpad and installs
 *    crash listeners that close() does NOT remove, so we init the SDK at most
 *    once (lazily, on first consent) and thereafter gate JS event delivery via a
 *    `beforeSend` that returns null while disabled — never close()/re-init.
 * Native crash capture rides on the default `@sentry/electron/main`
 * integrations, so init alone configures it.
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
// Captures the options object passed to the last init() call so tests can
// exercise the registered `beforeSend` consent gate.
let lastInitOptions: Record<string, unknown> | undefined;

const initMock = mock((opts: Record<string, unknown>) => {
  lastInitOptions = opts;
});
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

// NOTE: `sentry.ts` holds module-level singleton state (`initialized`, the live
// `enabled` flag, cached options) by design — init must run AT MOST ONCE per
// process. Since the module is imported once for this whole file, that state
// persists across tests. We therefore reset only the mocks (not the module
// singleton) and order tests so the fail-closed-boot / empty-DSN assertions run
// BEFORE the first enable, then drive the full lifecycle in one test below.
beforeEach(() => {
  // mockClear (not mockReset) so initMock keeps its lastInitOptions-capturing
  // implementation while clearing call history between tests.
  initMock.mockClear();
  setTagMock.mockReset();
  setClientMock.mockReset();
  writeSettingMock.mockReset();
  sentryClient = undefined;
  settingChangeCb = null;
});

describe("initSentryMain (before any consent)", () => {
  test("does not register the watcher when the DSN is empty", () => {
    (globalThis as Record<string, unknown>).__SENTRY_DSN_MACOS__ = "";
    initSentryMain();
    expect(initMock).not.toHaveBeenCalled();
    expect(settingChangeCb).toBeNull();
    (globalThis as Record<string, unknown>).__SENTRY_DSN_MACOS__ =
      "https://public@example.test/1";
  });

  test("starts fail-closed: does not initialize Sentry at boot", () => {
    initSentryMain();
    expect(initMock).not.toHaveBeenCalled();
    // ...but it does register the mid-session watcher.
    expect(settingChangeCb).not.toBeNull();
  });
});

describe("consent lifecycle (one-shot init, beforeSend gate)", () => {
  test("first enable inits the SDK once with a beforeSend gate; later toggles only flip the flag", () => {
    initSentryMain();

    // First enable via the direct apply path (not the unfired change watcher).
    setShareDiagnostics(true);
    expect(writeSettingMock).toHaveBeenCalledWith("shareDiagnostics", true);
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock.mock.calls[0][0]).toMatchObject({
      enabled: true,
      dsn: "https://public@example.test/1",
      tracesSampleRate: 0,
      attachStacktrace: true,
    });
    // Tags are applied so events carry process/arch/electron/packaged context.
    expect(setTagMock).toHaveBeenCalledWith("process", "main");

    const beforeSend = lastInitOptions?.beforeSend as
      | ((event: unknown) => unknown)
      | undefined;
    // Enabled now: beforeSend passes events through.
    const okEvent = { message: "ok" };
    expect(beforeSend?.(okEvent)).toBe(okEvent);

    // Disable: no close()/re-init churn; client stays installed, events dropped.
    const closeMock = mock(() => Promise.resolve(true));
    sentryClient = { getOptions: () => ({ enabled: true }), close: closeMock };
    setShareDiagnostics(false);
    expect(writeSettingMock).toHaveBeenCalledWith("shareDiagnostics", false);
    expect(closeMock).not.toHaveBeenCalled();
    expect(setClientMock).not.toHaveBeenCalled();
    expect(beforeSend?.({ message: "boom" })).toBeNull();

    // Re-enable: still no second init — only the flag flips back on.
    settingChangeCb?.(true);
    expect(initMock).toHaveBeenCalledTimes(1);
    const okAgain = { message: "ok-again" };
    expect(beforeSend?.(okAgain)).toBe(okAgain);
  });
});
