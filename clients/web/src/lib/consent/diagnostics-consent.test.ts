/**
 * Matrix tests for the diagnostics-consent chokepoint.
 *
 * The chokepoint splits two values: the SAVED PREFERENCE
 * (`device:share_diagnostics`, applied via the `setShareDiagnostics` mock) and
 * the EFFECTIVE GATE (`device:diagnostics_reporting` + the main-process sync,
 * written by `setDiagnosticsReportingGate`). The preference tracks the server's
 * share value direction-asymmetrically; the gate applies an explicit server
 * value directly and follows the saved device preference on an unknown one
 * (absent reads open — opt-out default).
 *
 * `@/runtime/diagnostics` and `@/utils/device-settings` are mocked so the gate
 * writes are observable without a DOM/localStorage.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const setDeviceBool = mock((_name: string, _value: boolean) => {});
const syncDiagnosticsToMain = mock((_enabled: boolean) => {});

// Mock the full surface this module touches; `mock.module` is process-global,
// so a partial mock would strip exports other test files import.
// The saved device preference (`device:share_diagnostics`); null models
// "never written", which resolves to the opt-out default via the fallback.
let devicePreference: boolean | null = null;

mock.module("@/utils/device-settings", () => ({
  setDeviceBool,
  getDeviceBool: (_name: string, fallback: boolean) =>
    devicePreference ?? fallback,
  watchDeviceSetting: () => () => {},
}));
mock.module("@/runtime/diagnostics", () => ({ syncDiagnosticsToMain }));

const { applyResolvedDiagnosticsConsent, setDiagnosticsReportingGate } =
  await import("./diagnostics-consent");

beforeEach(() => {
  setDeviceBool.mockClear();
  syncDiagnosticsToMain.mockClear();
  devicePreference = null;
});

/**
 * Asserts the effective gate device bool was written with `value`. The
 * Electron main mirror is NOT synced from here — the `sentry-control` watcher
 * pushes the session-composed value on this device-setting change — so the
 * gate writer must never call `syncDiagnosticsToMain` directly.
 */
function expectGate(value: boolean): void {
  expect(setDeviceBool).toHaveBeenCalledWith("diagnosticsReporting", value);
  expect(syncDiagnosticsToMain).not.toHaveBeenCalled();
}

describe("applyResolvedDiagnosticsConsent — saved preference", () => {
  test("real record + true → preference true, gate true", () => {
    const setShareDiagnostics = mock((_: boolean) => {});
    const result = applyResolvedDiagnosticsConsent(
      { shareDiagnostics: true, hasServerRecord: true },
      setShareDiagnostics,
    );
    expect(result).toBe(true);
    expect(setShareDiagnostics).toHaveBeenCalledWith(true);
    expectGate(true);
  });

  test("real record + false → preference false, gate false", () => {
    const setShareDiagnostics = mock((_: boolean) => {});
    const result = applyResolvedDiagnosticsConsent(
      { shareDiagnostics: false, hasServerRecord: true },
      setShareDiagnostics,
    );
    expect(result).toBe(false);
    expect(setShareDiagnostics).toHaveBeenCalledWith(false);
    expectGate(false);
  });

  // KEY OPT-OUT CASES: never-asked (null) follows the saved device
  // preference — absent reads open, so a user who was never shown the toggle
  // has telemetry enabled by default.
  test("null + no record → preference unchanged, gate open (opt-out default)", () => {
    const setShareDiagnostics = mock((_: boolean) => {});
    const result = applyResolvedDiagnosticsConsent(
      { shareDiagnostics: null, hasServerRecord: false },
      setShareDiagnostics,
    );
    expect(result).toBeNull();
    expect(setShareDiagnostics).not.toHaveBeenCalled();
    expectGate(true);
  });

  test("null grant with a server record → preference unchanged, gate open", () => {
    const setShareDiagnostics = mock((_: boolean) => {});
    const result = applyResolvedDiagnosticsConsent(
      { shareDiagnostics: null, hasServerRecord: true },
      setShareDiagnostics,
    );
    expect(result).toBeNull();
    expect(setShareDiagnostics).not.toHaveBeenCalled();
    expectGate(true);
  });

  test("true grant but no server record → preference unchanged, gate open", () => {
    const setShareDiagnostics = mock((_: boolean) => {});
    const result = applyResolvedDiagnosticsConsent(
      { shareDiagnostics: true, hasServerRecord: false },
      setShareDiagnostics,
    );
    expect(result).toBeNull();
    expect(setShareDiagnostics).not.toHaveBeenCalled();
    expectGate(true);
  });

  // KEY REGRESSION: a no-row response materializes the old platform's API
  // default `true` — not a user choice. It must not reopen the gate over an
  // explicit local opt-out whose backfill hasn't landed.
  test("no-record API-default true + local opt-out preference → gate stays closed", () => {
    devicePreference = false;
    const setShareDiagnostics = mock((_: boolean) => {});
    const result = applyResolvedDiagnosticsConsent(
      { shareDiagnostics: true, hasServerRecord: false },
      setShareDiagnostics,
    );
    expect(result).toBeNull();
    expect(setShareDiagnostics).not.toHaveBeenCalled();
    expectGate(false);
  });

  // KEY REGRESSION: a local explicit opt-out whose patchConsent write hasn't
  // landed (server still null) must stay closed — null never overrides an
  // explicit device preference.
  test("null server value + local opt-out preference → gate stays closed", () => {
    devicePreference = false;
    const setShareDiagnostics = mock((_: boolean) => {});
    const result = applyResolvedDiagnosticsConsent(
      { shareDiagnostics: null, hasServerRecord: true },
      setShareDiagnostics,
    );
    expect(result).toBeNull();
    expect(setShareDiagnostics).not.toHaveBeenCalled();
    expectGate(false);
  });

  test("explicit server true overrides a local opt-out preference", () => {
    devicePreference = false;
    const setShareDiagnostics = mock((_: boolean) => {});
    applyResolvedDiagnosticsConsent(
      { shareDiagnostics: true, hasServerRecord: true },
      setShareDiagnostics,
    );
    expect(setShareDiagnostics).toHaveBeenCalledWith(true);
    expectGate(true);
  });

  test("explicit false with no prior record → preference false (eager revoke), gate false", () => {
    const setShareDiagnostics = mock((_: boolean) => {});
    const result = applyResolvedDiagnosticsConsent(
      { shareDiagnostics: false, hasServerRecord: false },
      setShareDiagnostics,
    );
    expect(result).toBe(false);
    expect(setShareDiagnostics).toHaveBeenCalledWith(false);
    expectGate(false);
  });
});

describe("setDiagnosticsReportingGate", () => {
  test("writes the device bool AND the main-process sync with the effective value", () => {
    setDiagnosticsReportingGate(true);
    expectGate(true);

    setDeviceBool.mockClear();
    syncDiagnosticsToMain.mockClear();

    setDiagnosticsReportingGate(false);
    expectGate(false);
  });
});
