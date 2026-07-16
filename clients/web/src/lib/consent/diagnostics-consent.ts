/**
 * The single decision point for the two diagnostics-consent values:
 *
 * - **Saved preference** (`device:share_diagnostics`) — the user's tri-state
 *   opt-in/out (`null` = never asked), shown and re-submitted by the
 *   re-consent screen. It always tracks the server's `share_diagnostics`
 *   value (direction-asymmetric writes), so a stale-version record can't
 *   silently lose a prior explicit choice.
 * - **Effective reporting gate** (`device:diagnostics_reporting`) — what
 *   actually turns Sentry on. A local explicit opt-out closes it — the
 *   just-adopted revoke or a pending device opt-out whose `patchConsent`
 *   write is still in flight (or failed). Otherwise, with a server record,
 *   the platform-computed effective verdict (`diagnosticsEffective`) decides;
 *   without one the gate derives from the device preference (absent reads
 *   open — opt-out default). Kept as its own watchable key because the
 *   `sentry-control` cross-tab watcher and the Electron main mirror react to
 *   it, and because an absent key marks a device that has never resolved
 *   consent (see {@link failCloseDiagnosticsGateUntilFirstSync}). A
 *   stale-version grant keeps reporting on — the review-terms
 *   re-confirmation is driven by the consent-currency flags, not this gate.
 *
 * This module is the ONLY writer of the gate key. Every path that learns a
 * diagnostics-consent value routes through one of the exported chokepoints:
 * {@link applyResolvedDiagnosticsConsent} for server-resolved inputs,
 * {@link applyExplicitDiagnosticsChoice} for a user's explicit toggle/screen
 * choice, and {@link failCloseDiagnosticsGateUntilFirstSync} for the
 * failed-sync posture. A structural test in `diagnostics-consent.test.ts`
 * enforces the single-writer invariant.
 */

import {
  getDeviceBool,
  getDeviceSetting,
  setDeviceBool,
} from "@/utils/device-settings";

export interface ResolvedDiagnosticsConsent {
  /** The server's `share_diagnostics` value; `null` when unknown/absent. */
  shareDiagnostics: boolean | null;
  /**
   * The platform-computed effective verdict (`share_diagnostics_effective`).
   * Authoritative for the gate when `hasServerRecord` is set.
   */
  diagnosticsEffective: boolean;
  /** Whether the server returned a real consent record (not API defaults). */
  hasServerRecord: boolean;
}

/**
 * SOLE writer of the effective reporting gate (`diagnosticsReporting` device
 * bool), module-private so every write flows through the exported chokepoints.
 * The Electron main mirror is NOT synced here: the `sentry-control` watcher
 * reacts to this device-setting change and pushes the
 * platform-session-composed value (`diagnosticsConsentGranted()`) to main, so a
 * device gate that is `true` without a confirmed live session never enables the
 * main client. Syncing the raw gate here would race that composed write.
 */
function setDiagnosticsReportingGate(enabled: boolean): void {
  setDeviceBool("diagnosticsReporting", enabled);
}

/**
 * Apply a resolved server-consent input to both diagnostics values:
 *
 * 1. The saved preference, via `setShareDiagnostics` — keyed on the RAW
 *    tri-state: written only for a confident grant or explicit revoke; an
 *    unknown input leaves it untouched.
 * 2. The effective reporting gate — a local explicit opt-out closes it;
 *    otherwise the server verdict (`diagnosticsEffective`) decides when a
 *    record exists, and the device preference does when none does (absent
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
  if (preference !== null) {
    setShareDiagnostics(preference);
  }

  setDiagnosticsReportingGate(deriveGate(preference, resolved));

  return preference;
}

/**
 * Pure policy: resolve the EFFECTIVE REPORTING GATE value. A local explicit
 * opt-out always wins — the just-adopted revoke, or a pending device opt-out
 * whose server write may still be in flight (or failed). Otherwise the
 * platform-computed effective verdict decides when a server record exists;
 * without one the opt-out default applies (the preference already read open).
 */
function deriveGate(
  preference: boolean | null,
  resolved: ResolvedDiagnosticsConsent,
): boolean {
  const effectivePreference =
    preference ?? getDeviceBool("shareDiagnostics", true);
  if (!effectivePreference) {
    return false;
  }
  return resolved.hasServerRecord ? resolved.diagnosticsEffective : true;
}

/**
 * Apply an explicit user choice (settings toggle / consent screen): the same
 * policy as a confident server record — the preference is written and the
 * gate re-derived, so an explicit "off" closes it and "on" opens it.
 */
export function applyExplicitDiagnosticsChoice(
  value: boolean,
  setShareDiagnostics: (value: boolean) => void,
): void {
  applyResolvedDiagnosticsConsent(
    // The choice is its own effective verdict until the next sync adopts
    // the server's.
    {
      shareDiagnostics: value,
      diagnosticsEffective: value,
      hasServerRecord: true,
    },
    setShareDiagnostics,
  );
}

/**
 * Failed-sync posture: on a device that has never resolved a gate, close it
 * until the first successful consent sync can reveal a server-side explicit
 * opt-out — hydration alone must not let the opt-out default open the gate. A
 * previously resolved gate keeps its value. Every successful sync path writes
 * the gate, so the conservative value never outlives the outage.
 */
export function failCloseDiagnosticsGateUntilFirstSync(): void {
  if (getDeviceSetting("diagnosticsReporting", "") === "") {
    setDiagnosticsReportingGate(false);
  }
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
  if (shareDiagnostics === false) {
    return false;
  }

  // Confident grant — adopt the server's opt-in, regardless of version.
  if (hasServerRecord && shareDiagnostics === true) {
    return true;
  }

  // Unknown grant (`null`, or no server record) — leave the preference untouched.
  return null;
}
