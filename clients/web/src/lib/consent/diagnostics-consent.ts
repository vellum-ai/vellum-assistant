/**
 * The single, version-aware, direction-asymmetric decision point for the
 * `device:share_diagnostics` mirror.
 *
 * The mirror is the boolean that gates diagnostics reporting (Sentry). Every
 * non-onboarding path that learns a diagnostics-consent value from the server
 * must route the decision through {@link applyResolvedDiagnosticsConsent} so the
 * policy lives in exactly one place:
 *
 * - **Version invalidation** — a `share_diagnostics` acceptance recorded under a
 *   stale `PRIVACY_CONSENT_VERSION` (`diagnosticsVersionCurrent === false`) never
 *   keeps diagnostics on. It resolves to `false` regardless of the stored share
 *   boolean.
 * - **Direction asymmetry** — diagnostics only turn ON for a confident, current
 *   grant (`hasServerRecord && shareDiagnostics === true && diagnosticsVersionCurrent`).
 *   An "unknown" input (`shareDiagnostics === null`, or no server record) never
 *   flips the mirror on and leaves the existing value untouched; an explicit
 *   revoke (`shareDiagnostics === false`) eagerly writes `false`.
 *
 * The resolved decision is applied via `setShareDiagnostics` (the single writer
 * of the `device:share_diagnostics` key and the main-process diagnostics sync);
 * an unchanged decision is skipped. The function returns the resolved boolean —
 * or `null` when the mirror was left unchanged — so callers can log/telemeter
 * the transition.
 */

export interface ResolvedDiagnosticsConsent {
  /** The server's `share_diagnostics` value; `null` when unknown/absent. */
  shareDiagnostics: boolean | null;
  /** Whether the server's accepted version equals `PRIVACY_CONSENT_VERSION`. */
  diagnosticsVersionCurrent: boolean;
  /** Whether the server returned a real consent record (not API defaults). */
  hasServerRecord: boolean;
}

/**
 * Decide the diagnostics mirror value from a resolved server-consent input, and
 * apply it via `setShareDiagnostics` unless the input is an unknown grant.
 *
 * @returns `true`/`false` when the mirror was written to that value, or `null`
 * when the input is an unknown grant and the mirror was left unchanged.
 */
export function applyResolvedDiagnosticsConsent(
  resolved: ResolvedDiagnosticsConsent,
  setShareDiagnostics: (value: boolean) => void,
): boolean | null {
  const decision = resolveDiagnosticsConsent(resolved);
  if (decision !== null) setShareDiagnostics(decision);
  return decision;
}

/**
 * Pure policy: resolve the diagnostics mirror value, or `null` for "leave the
 * existing mirror untouched". The single home of the version-invalidation +
 * direction-asymmetry rules.
 */
function resolveDiagnosticsConsent(
  resolved: ResolvedDiagnosticsConsent,
): boolean | null {
  const { shareDiagnostics, diagnosticsVersionCurrent, hasServerRecord } =
    resolved;

  // Explicit revoke — eagerly turn diagnostics OFF (even on an unknown record).
  if (shareDiagnostics === false) return false;

  // Confident grant only turns diagnostics ON when its version is current;
  // a stale-version acceptance never keeps it on.
  if (hasServerRecord && shareDiagnostics === true) {
    return diagnosticsVersionCurrent;
  }

  // Unknown grant (`null`, or no server record) — never flip ON; leave the
  // existing mirror value untouched.
  return null;
}
