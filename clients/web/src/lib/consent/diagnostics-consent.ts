/**
 * The single, version-aware, direction-asymmetric decision point for the two
 * diagnostics-consent values:
 *
 * - **Saved preference** (`device:share_diagnostics`) — the user's opt-in/out,
 *   shown and re-submitted by the re-consent screen. It always tracks the
 *   server's `share_diagnostics` value (direction-asymmetric writes), never the
 *   privacy-consent version, so a stale-version record can't silently lose a
 *   prior opt-in.
 * - **Effective reporting gate** (`device:diagnostics_reporting`) — what
 *   actually turns Sentry on. It is `preference && versionCurrent`, so a
 *   stale-version acceptance stops reporting until the user re-accepts.
 *
 * Every non-onboarding path that learns a diagnostics-consent value from the
 * server routes through {@link applyResolvedDiagnosticsConsent} so this policy
 * lives in exactly one place.
 *
 * - **Preference (direction-asymmetric)** — a confident grant
 *   (`hasServerRecord && shareDiagnostics === true`) writes `true` even on a
 *   stale version; an explicit revoke (`shareDiagnostics === false`) writes
 *   `false`; an unknown input (`null` / no record) leaves the preference
 *   untouched.
 * - **Gate** — opens only for a confident, current grant
 *   (`hasServerRecord && shareDiagnostics === true && diagnosticsVersionCurrent`).
 */

import { setDeviceBool } from "@/utils/device-settings";
import { syncDiagnosticsToMain } from "@/runtime/diagnostics";

export interface ResolvedDiagnosticsConsent {
  /** The server's `share_diagnostics` value; `null` when unknown/absent. */
  shareDiagnostics: boolean | null;
  /** Whether the server's accepted version equals `PRIVACY_CONSENT_VERSION`. */
  diagnosticsVersionCurrent: boolean;
  /** Whether the server returned a real consent record (not API defaults). */
  hasServerRecord: boolean;
}

/**
 * Write the effective Sentry reporting gate: the `diagnosticsReporting` device
 * bool AND the main-process diagnostics sync, both with the same effective
 * value. This is the single writer of the gate.
 */
export function setDiagnosticsReportingGate(enabled: boolean): void {
  setDeviceBool("diagnosticsReporting", enabled);
  syncDiagnosticsToMain(enabled);
}

/**
 * Apply a resolved server-consent input to both diagnostics values:
 *
 * 1. The saved preference, via `setShareDiagnostics` — written only for a
 *    confident grant or explicit revoke; an unknown input leaves it untouched.
 * 2. The effective reporting gate, via {@link setDiagnosticsReportingGate} —
 *    always set to `preference && versionCurrent`.
 *
 * @returns the saved-preference decision: `true`/`false` when the preference was
 * written to that value, or `null` when the input is an unknown grant and the
 * preference was left unchanged.
 */
export function applyResolvedDiagnosticsConsent(
  resolved: ResolvedDiagnosticsConsent,
  setShareDiagnostics: (value: boolean) => void,
): boolean | null {
  const preference = resolvePreference(resolved);
  if (preference !== null) setShareDiagnostics(preference);

  const { shareDiagnostics, diagnosticsVersionCurrent, hasServerRecord } =
    resolved;
  setDiagnosticsReportingGate(
    hasServerRecord && shareDiagnostics === true && diagnosticsVersionCurrent,
  );

  return preference;
}

/**
 * Pure policy: resolve the SAVED PREFERENCE value, or `null` for "leave the
 * existing preference untouched". Direction-asymmetric and version-independent
 * — the preference always tracks the server's share value so the re-consent UI
 * never loses it.
 */
function resolvePreference(
  resolved: ResolvedDiagnosticsConsent,
): boolean | null {
  const { shareDiagnostics, hasServerRecord } = resolved;

  // Explicit revoke — eagerly write the opt-out (even on an unknown record).
  if (shareDiagnostics === false) return false;

  // Confident grant — adopt the server's opt-in, regardless of version.
  if (hasServerRecord && shareDiagnostics === true) return true;

  // Unknown grant (`null`, or no server record) — leave the preference untouched.
  return null;
}
