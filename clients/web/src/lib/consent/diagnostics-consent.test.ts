/**
 * Matrix tests for the diagnostics-consent chokepoint.
 *
 * The function is pure over its inputs and a single `setShareDiagnostics`
 * applier, so we exercise the version-invalidation + direction-asymmetry policy
 * with a mock applier — no localStorage or store needed.
 */

import { describe, expect, mock, test } from "bun:test";

import { applyResolvedDiagnosticsConsent } from "./diagnostics-consent";

describe("applyResolvedDiagnosticsConsent", () => {
  test("real record + true + current → true (writes mirror)", () => {
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
    expect(setShareDiagnostics).toHaveBeenCalledTimes(1);
    expect(setShareDiagnostics).toHaveBeenCalledWith(true);
  });

  test("real record + true + stale version → false (invalidated)", () => {
    const setShareDiagnostics = mock((_: boolean) => {});
    const result = applyResolvedDiagnosticsConsent(
      {
        shareDiagnostics: true,
        diagnosticsVersionCurrent: false,
        hasServerRecord: true,
      },
      setShareDiagnostics,
    );
    expect(result).toBe(false);
    expect(setShareDiagnostics).toHaveBeenCalledWith(false);
  });

  test("real record + false → false (explicit revoke)", () => {
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
  });

  test("null + no record → unchanged (mirror not written)", () => {
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
  });

  test("null grant with a server record → unchanged (never flips on)", () => {
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
  });

  test("true grant but no server record → unchanged (unknown, never flips on)", () => {
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
  });

  test("explicit false with no prior mirror → false (eager revoke even without record)", () => {
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
  });
});
