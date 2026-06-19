/**
 * Matrix tests for the diagnostics-consent chokepoint.
 *
 * The chokepoint splits two values: the SAVED PREFERENCE
 * (`device:share_diagnostics`, applied via the `setShareDiagnostics` mock) and
 * the EFFECTIVE GATE (`device:diagnostics_reporting` + the main-process sync,
 * written by `setDiagnosticsReportingGate`). The preference tracks the server's
 * share value direction-asymmetrically; the gate is `preference && version`.
 *
 * `@/runtime/diagnostics` and `@/utils/device-settings` are mocked so the gate
 * writes are observable without a DOM/localStorage.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const setDeviceBool = mock((_name: string, _value: boolean) => {});
const syncDiagnosticsToMain = mock((_enabled: boolean) => {});

// Mock the full surface this module touches; `mock.module` is process-global,
// so a partial mock would strip exports other test files import.
mock.module("@/utils/device-settings", () => ({
  setDeviceBool,
  getDeviceBool: (_name: string, fallback: boolean) => fallback,
  watchDeviceSetting: () => () => {},
}));
mock.module("@/runtime/diagnostics", () => ({ syncDiagnosticsToMain }));

const { applyResolvedDiagnosticsConsent, setDiagnosticsReportingGate } =
  await import("./diagnostics-consent");

beforeEach(() => {
  setDeviceBool.mockClear();
  syncDiagnosticsToMain.mockClear();
});

/** Asserts the effective gate was written (device bool + main sync) with `value`. */
function expectGate(value: boolean): void {
  expect(setDeviceBool).toHaveBeenCalledWith("diagnosticsReporting", value);
  expect(syncDiagnosticsToMain).toHaveBeenCalledWith(value);
}

describe("applyResolvedDiagnosticsConsent — saved preference", () => {
  test("real record + true + current → preference true, gate true", () => {
    const setShareDiagnostics = mock((_: boolean) => {});
    const result = applyResolvedDiagnosticsConsent(
      {
        shareDiagnostics: true,
        diagnosticsVersionCurrent: true,
        hasServerRecord: true,
      },
      setShareDiagnostics,
    );
    expect(result).toBe(true);
    expect(setShareDiagnostics).toHaveBeenCalledWith(true);
    expectGate(true);
  });

  // KEY REGRESSION: a stale-version opt-in must PRESERVE the preference as
  // `true` (so the re-consent UI can't silently drop it) while turning the
  // effective gate OFF.
  test("real record + true + STALE version → preference PRESERVED true, gate false", () => {
    const setShareDiagnostics = mock((_: boolean) => {});
    const result = applyResolvedDiagnosticsConsent(
      {
        shareDiagnostics: true,
        diagnosticsVersionCurrent: false,
        hasServerRecord: true,
      },
      setShareDiagnostics,
    );
    expect(result).toBe(true);
    expect(setShareDiagnostics).toHaveBeenCalledWith(true);
    expect(setShareDiagnostics).not.toHaveBeenCalledWith(false);
    expectGate(false);
  });

  test("real record + false → preference false, gate false", () => {
    const setShareDiagnostics = mock((_: boolean) => {});
    const result = applyResolvedDiagnosticsConsent(
      {
        shareDiagnostics: false,
        diagnosticsVersionCurrent: true,
        hasServerRecord: true,
      },
      setShareDiagnostics,
    );
    expect(result).toBe(false);
    expect(setShareDiagnostics).toHaveBeenCalledWith(false);
    expectGate(false);
  });

  test("null + no record → preference unchanged, gate not forced on", () => {
    const setShareDiagnostics = mock((_: boolean) => {});
    const result = applyResolvedDiagnosticsConsent(
      {
        shareDiagnostics: null,
        diagnosticsVersionCurrent: false,
        hasServerRecord: false,
      },
      setShareDiagnostics,
    );
    expect(result).toBeNull();
    expect(setShareDiagnostics).not.toHaveBeenCalled();
    expectGate(false);
  });

  test("null grant with a server record → preference unchanged, gate false", () => {
    const setShareDiagnostics = mock((_: boolean) => {});
    const result = applyResolvedDiagnosticsConsent(
      {
        shareDiagnostics: null,
        diagnosticsVersionCurrent: true,
        hasServerRecord: true,
      },
      setShareDiagnostics,
    );
    expect(result).toBeNull();
    expect(setShareDiagnostics).not.toHaveBeenCalled();
    expectGate(false);
  });

  test("true grant but no server record → preference unchanged, gate false", () => {
    const setShareDiagnostics = mock((_: boolean) => {});
    const result = applyResolvedDiagnosticsConsent(
      {
        shareDiagnostics: true,
        diagnosticsVersionCurrent: true,
        hasServerRecord: false,
      },
      setShareDiagnostics,
    );
    expect(result).toBeNull();
    expect(setShareDiagnostics).not.toHaveBeenCalled();
    expectGate(false);
  });

  test("explicit false with no prior record → preference false (eager revoke), gate false", () => {
    const setShareDiagnostics = mock((_: boolean) => {});
    const result = applyResolvedDiagnosticsConsent(
      {
        shareDiagnostics: false,
        diagnosticsVersionCurrent: false,
        hasServerRecord: false,
      },
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
