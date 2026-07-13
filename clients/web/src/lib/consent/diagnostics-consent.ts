/**
 * The single, direction-asymmetric decision point for the two
 * diagnostics-consent values:
 *
 * - **Saved preference** (`device:share_diagnostics`) — the user's opt-in/out,
 *   shown and re-submitted by the re-consent screen. It always tracks the
 *   server's `share_diagnostics` value (direction-asymmetric writes), so a
 *   stale-version record can't silently lose a prior explicit choice.
 * - **Effective reporting gate** (`device:diagnostics_reporting`) — what
 *   actually turns Sentry on. Diagnostics is opt-out, and the gate always
 *   equals the effective saved preference: an authoritative server signal
 *   (the same rules the preference uses — a grant needs a real record, a
 *   revoke is always honored) applies directly, while an unknown input
 *   (null, or a non-false value on a no-row API default) leaves the device
 *   preference in charge, absent reading open. Following the preference —
 *   rather than forcing open — keeps an explicit local opt-out closed while
 *   its `patchConsent` write is still in flight (or failed), yet heals gates
 *   stuck closed by earlier strict-opt-in builds for users who never opted
 *   out. A stale-version grant keeps reporting on — the review-terms
 *   re-confirmation is driven by the consent-currency flags, not this gate.
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
 * - **Gate** — always the effective preference: the authoritative value just
 *   applied, or the saved device preference when unknown (absent reads open).
 */

import { getDeviceBool, setDeviceBool } from "@/utils/device-settings";

export interface ResolvedDiagnosticsConsent {
  /** The server's `share_diagnostics` value; `null` when unknown/absent. */
  shareDiagnostics: boolean | null;
  /** Whether the server returned a real consent record (not API defaults). */
  hasServerRecord: boolean;
}

/**
 * Write the effective Sentry reporting gate (`diagnosticsReporting` device
 * bool). The Electron main mirror is NOT synced here: the `sentry-control`
 * watcher reacts to this device-setting change and pushes the
 * platform-session-composed value (`diagnosticsConsentGranted()`) to main, so a
 * device gate that is `true` without a confirmed live session never enables the
 * main client. Syncing the raw gate here would race that composed write.
 */
export function setDiagnosticsReportingGate(enabled: boolean): void {
  setDeviceBool("diagnosticsReporting", enabled);
}

/**
 * Apply a resolved server-consent input to both diagnostics values:
 *
 * 1. The saved preference, via `setShareDiagnostics` — written only for a
 *    confident grant or explicit revoke; an unknown input leaves it untouched.
 * 2. The effective reporting gate, via {@link setDiagnosticsReportingGate} —
 *    always the effective preference: the just-applied authoritative value,
 *    or the existing device preference when the input is unknown (absent
 *    reads open — opt-out default).
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

  setDiagnosticsReportingGate(
    preference ?? getDeviceBool("shareDiagnostics", true),
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
