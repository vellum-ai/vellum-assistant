/**
 * Matrix tests for the diagnostics-consent chokepoints.
 *
 * The module splits two values: the SAVED PREFERENCE
 * (`device:share_diagnostics`, applied via the `setShareDiagnostics` mock) and
 * the EFFECTIVE GATE (`device:diagnostics_reporting`), of which this module is
 * the sole writer. The preference tracks the server's RAW share value
 * direction-asymmetrically; the gate closes on a local explicit opt-out,
 * otherwise honors the server's effective verdict when a record exists, and
 * follows the saved device preference when none does (absent reads open —
 * opt-out default).
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
// The stored effective gate (`device:diagnostics_reporting`); "" models a
// device that has never resolved a gate (unhydrated).
let storedGate = "";

mock.module("@/utils/device-settings", () => ({
  setDeviceBool,
  getDeviceBool: (_name: string, fallback: boolean) =>
    devicePreference ?? fallback,
  getDeviceSetting: (_name: string, fallback: string) =>
    storedGate === "" ? fallback : storedGate,
  watchDeviceSetting: () => () => {},
}));
mock.module("@/runtime/diagnostics", () => ({ syncDiagnosticsToMain }));

const {
  applyResolvedDiagnosticsConsent,
  applyExplicitDiagnosticsChoice,
  failCloseDiagnosticsGateUntilFirstSync,
} = await import("./diagnostics-consent");

beforeEach(() => {
  setDeviceBool.mockClear();
  syncDiagnosticsToMain.mockClear();
  devicePreference = null;
  storedGate = "";
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
      {
        shareDiagnostics: true,
        diagnosticsEffective: true,
        hasServerRecord: true,
      },
      setShareDiagnostics,
    );
    expect(result).toBe(true);
    expect(setShareDiagnostics).toHaveBeenCalledWith(true);
    expectGate(true);
  });

  test("real record + false → preference false, gate false", () => {
    const setShareDiagnostics = mock((_: boolean) => {});
    const result = applyResolvedDiagnosticsConsent(
      {
        shareDiagnostics: false,
        diagnosticsEffective: false,
        hasServerRecord: true,
      },
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
      {
        shareDiagnostics: null,
        diagnosticsEffective: true,
        hasServerRecord: false,
      },
      setShareDiagnostics,
    );
    expect(result).toBeNull();
    expect(setShareDiagnostics).not.toHaveBeenCalled();
    expectGate(true);
  });

  test("null grant with a server record → preference unchanged, gate open", () => {
    const setShareDiagnostics = mock((_: boolean) => {});
    const result = applyResolvedDiagnosticsConsent(
      {
        shareDiagnostics: null,
        diagnosticsEffective: true,
        hasServerRecord: true,
      },
      setShareDiagnostics,
    );
    expect(result).toBeNull();
    expect(setShareDiagnostics).not.toHaveBeenCalled();
    expectGate(true);
  });

  test("true grant but no server record → preference unchanged, gate open", () => {
    const setShareDiagnostics = mock((_: boolean) => {});
    const result = applyResolvedDiagnosticsConsent(
      {
        shareDiagnostics: true,
        diagnosticsEffective: true,
        hasServerRecord: false,
      },
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
      {
        shareDiagnostics: true,
        diagnosticsEffective: true,
        hasServerRecord: false,
      },
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
      {
        shareDiagnostics: null,
        diagnosticsEffective: true,
        hasServerRecord: true,
      },
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
      {
        shareDiagnostics: true,
        diagnosticsEffective: true,
        hasServerRecord: true,
      },
      setShareDiagnostics,
    );
    expect(setShareDiagnostics).toHaveBeenCalledWith(true);
    expectGate(true);
  });

  test("explicit false with no prior record → preference false (eager revoke), gate false", () => {
    const setShareDiagnostics = mock((_: boolean) => {});
    const result = applyResolvedDiagnosticsConsent(
      {
        shareDiagnostics: false,
        diagnosticsEffective: false,
        hasServerRecord: false,
      },
      setShareDiagnostics,
    );
    expect(result).toBe(false);
    expect(setShareDiagnostics).toHaveBeenCalledWith(false);
    expectGate(false);
  });

  // KEY SERVER-AUTHORITY CASES: the platform's effective verdict closes the
  // gate even where the raw value reads enabled — the raw tri-state carries
  // chosen-ness only.
  test("server-effective false with raw null → gate closed, preference untouched", () => {
    const setShareDiagnostics = mock((_: boolean) => {});
    const result = applyResolvedDiagnosticsConsent(
      {
        shareDiagnostics: null,
        diagnosticsEffective: false,
        hasServerRecord: true,
      },
      setShareDiagnostics,
    );
    expect(result).toBeNull();
    expect(setShareDiagnostics).not.toHaveBeenCalled();
    expectGate(false);
  });

  test("server-effective false with raw true → preference true (chosen-ness), gate closed", () => {
    const setShareDiagnostics = mock((_: boolean) => {});
    const result = applyResolvedDiagnosticsConsent(
      {
        shareDiagnostics: true,
        diagnosticsEffective: false,
        hasServerRecord: true,
      },
      setShareDiagnostics,
    );
    expect(result).toBe(true);
    expect(setShareDiagnostics).toHaveBeenCalledWith(true);
    expectGate(false);
  });

  test("server-effective true never reopens over a pending local opt-out", () => {
    devicePreference = false;
    const setShareDiagnostics = mock((_: boolean) => {});
    applyResolvedDiagnosticsConsent(
      {
        shareDiagnostics: null,
        diagnosticsEffective: true,
        hasServerRecord: true,
      },
      setShareDiagnostics,
    );
    expectGate(false);
  });

  // The derivation ignores prior hydration: whatever the stored gate says, an
  // unknown input re-derives the gate from the saved preference — explicit
  // false closes, true or never-asked opens.
  for (const stored of ["", "true", "false"]) {
    for (const preference of [null, true, false]) {
      const expected = preference !== false;
      test(`unknown input re-derives: stored gate ${JSON.stringify(stored)} + preference ${String(preference)} → gate ${String(expected)}`, () => {
        storedGate = stored;
        devicePreference = preference;
        applyResolvedDiagnosticsConsent(
          {
            shareDiagnostics: null,
            diagnosticsEffective: true,
            hasServerRecord: true,
          },
          mock((_: boolean) => {}),
        );
        expectGate(expected);
      });
    }
  }
});

describe("applyExplicitDiagnosticsChoice", () => {
  test("true → preference true, gate true", () => {
    const setShareDiagnostics = mock((_: boolean) => {});
    applyExplicitDiagnosticsChoice(true, setShareDiagnostics);
    expect(setShareDiagnostics).toHaveBeenCalledWith(true);
    expectGate(true);
  });

  test("false → preference false, gate false — even over a prior open gate", () => {
    storedGate = "true";
    const setShareDiagnostics = mock((_: boolean) => {});
    applyExplicitDiagnosticsChoice(false, setShareDiagnostics);
    expect(setShareDiagnostics).toHaveBeenCalledWith(false);
    expectGate(false);
  });
});

describe("failCloseDiagnosticsGateUntilFirstSync", () => {
  // An unhydrated device (gate never written) fails closed whatever the
  // saved preference says — the server may hold an opt-out it hasn't seen.
  for (const preference of [null, true, false]) {
    test(`never-resolved gate closes (preference ${String(preference)})`, () => {
      devicePreference = preference;
      failCloseDiagnosticsGateUntilFirstSync();
      expectGate(false);
    });
  }

  // A hydrated device keeps its resolved gate — the failed sync says nothing
  // new, and closing an open gate here would flap Sentry on every outage.
  for (const stored of ["true", "false"]) {
    test(`already-resolved gate ${stored} is left untouched`, () => {
      storedGate = stored;
      failCloseDiagnosticsGateUntilFirstSync();
      expect(setDeviceBool).not.toHaveBeenCalled();
    });
  }
});

describe("single-writer invariant", () => {
  test("only diagnostics-consent.ts writes the diagnostics_reporting gate key", async () => {
    // Structural guard for the module contract: every gate write routes
    // through this module's chokepoints. Reads (`getDeviceSetting`/
    // `getDeviceBool`/`watchDeviceSetting`) and the device-settings registry
    // entry are fine anywhere.
    const srcRoot = new URL("../..", import.meta.url).pathname;
    const writePatterns = [
      /\bset(?:DeviceBool|DeviceSetting)\(\s*["']diagnosticsReporting["']/,
      /\bset(?:LocalBool|LocalSetting)\(\s*["']device:diagnostics_reporting["']/,
      /localStorage\.setItem\(\s*["']device:diagnostics_reporting["']/,
    ];
    const writers: string[] = [];
    for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan(srcRoot)) {
      if (/\.test\.tsx?$/.test(file)) {
        continue;
      }
      const text = await Bun.file(`${srcRoot}${file}`).text();
      if (writePatterns.some((pattern) => pattern.test(text))) {
        writers.push(file);
      }
    }
    expect(writers).toEqual(["lib/consent/diagnostics-consent.ts"]);
  });
});
