/**
 * In-memory cache of the platform owner's telemetry consent.
 *
 * Three values are cached, all refreshed from the same owner-consent fetch:
 *  - `share_analytics`: gates usage telemetry collection.
 *  - `share_diagnostics`: gates crash diagnostics (read by Sentry `beforeSend`),
 *    and composes the per-turn trace-collection gate alongside the accepted
 *    consent version.
 *  - `share_diagnostics_accepted_version`: the consent version the owner
 *    accepted; the disclosing-version half of the trace-collection gate (see
 *    telemetry/trace-collection-policy.ts).
 *
 * Hot-path gates (record-time telemetry writes, Sentry `beforeSend`) need a
 * synchronous, I/O-free read, so this module owns the values and refreshes them
 * periodically in the background. Consent is opt-out — an owner who never made
 * an explicit choice reports as consented (the client maps a never-chose wire
 * value to `true`).
 *
 * The consent values are tri-state (`ConsentState`): `true`/`false` are
 * confirmed states from a successful platform fetch; `"unknown"` means no
 * confirmed state exists — boot before the first refresh, no platform session,
 * or no resolvable owner identity. A transient fetch failure keeps the
 * previous value so a known opt-in is not flipped mid-session. The boolean
 * accessors collapse `"unknown"` to `false` (fail-closed); the raw accessors
 * expose the tri-state for callers that must distinguish a confirmed opt-out
 * from a not-yet-known state.
 */

import { getConfigReadOnly } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import { VellumPlatformClient } from "./client.js";
import { arePlatformFeaturesEnabled } from "./feature-gate.js";

const log = getLogger("consent-cache");

const REFRESH_INTERVAL_MS = 5 * 60_000; // refresh consent every 5 min

/** Cached consent value: a confirmed boolean, or `"unknown"` when no confirmed state exists. */
export type ConsentState = boolean | "unknown";

let cachedShareAnalytics: ConsentState = "unknown"; // no confirmed state until first success
let cachedShareDiagnostics: ConsentState = "unknown"; // no confirmed state until first success
let cachedShareDiagnosticsVersion = ""; // "" fails the trace disclosure gate
// Fail-closed marker for a workspace that locally opted out of usage data
// before telemetry moved to platform `share_analytics` consent (migration 106).
// While set, telemetry stays off regardless of platform consent. Cleared by a
// future cross-repo reconciliation once the platform exposes an explicit
// re-consent signal; not auto-cleared here. Read live from config (an
// in-memory cached read, safe on the hot path): a boot-time default would
// leave the record-time gates open between daemon start and the first
// consent refresh, exactly the window unknown-consent recording now keeps
// events flowing in.
function isLegacyOptedOut(): boolean {
  try {
    return getConfigReadOnly().legacyTelemetryOptOut === true;
  } catch {
    // Config not yet loaded — no marker to honor yet.
    return false;
  }
}
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Synchronous hot-path accessor for the effective `share_analytics` consent.
 * Never does I/O; returns `false` unless a successful refresh confirmed an
 * opt-in (`"unknown"` reads as `false`), and stays `false` while the legacy
 * fail-closed opt-out marker is set.
 */
export function getCachedShareAnalytics(): boolean {
  return cachedShareAnalytics === true && !isLegacyOptedOut();
}

/**
 * Raw tri-state `share_analytics` consent. The legacy fail-closed opt-out
 * marker folds into `false` — a workspace-level opt-out is a confirmed
 * opt-out, not an unknown. For callers that must distinguish a confirmed
 * opt-out from a not-yet-known state.
 */
export function getRawShareAnalytics(): ConsentState {
  return isLegacyOptedOut() ? false : cachedShareAnalytics;
}

/**
 * Synchronous hot-path accessor for the `share_diagnostics` consent (read by
 * Sentry `beforeSend`). Never does I/O; returns `false` unless a successful
 * refresh confirmed an opt-in (`"unknown"` reads as `false`). Because every
 * Sentry event re-reads this, a mid-session opt-out is honored within one
 * refresh cycle.
 */
export function getCachedShareDiagnostics(): boolean {
  return cachedShareDiagnostics === true;
}

/**
 * Raw tri-state `share_diagnostics` consent, for callers that must
 * distinguish a confirmed opt-out from a not-yet-known state.
 */
export function getRawShareDiagnostics(): ConsentState {
  return cachedShareDiagnostics;
}

/**
 * Synchronous hot-path accessor for the owner's accepted diagnostics-consent
 * version ("YYYY-MM-DD", or "" until a successful refresh / if never accepted).
 * The disclosing-version half of the per-turn trace-collection gate.
 */
export function getCachedShareDiagnosticsVersion(): string {
  return cachedShareDiagnosticsVersion;
}

/**
 * Refresh the cached consent from the platform.
 *
 * No platform session / features disabled (`create()` is null) → `"unknown"`.
 * No resolvable assistant identity (no owner whose consent we can attest to) →
 * `"unknown"` — losing the owner mapping is not an opt-out, but it also isn't
 * a confirmed opt-in, so we stop riding a stale one. A successful fetch adopts
 * the reported values. A `null` fetch (transient failure / undeployed
 * endpoint) leaves the previous values unchanged so a known opt-in is not
 * flipped off mid-session.
 */
export async function refreshConsentCache(): Promise<void> {
  // Platform features disabled is a PERMANENT condition (config-level), not a
  // cold-cache transient: telemetry can never ship, so confirmed-off keeps the
  // record-time gates closed and the outbox from accumulating rows that no
  // flush will ever drain.
  if (!arePlatformFeaturesEnabled()) {
    setCachedShareAnalytics(false);
    setCachedShareDiagnostics(false);
    setCachedShareDiagnosticsVersion("");
    return;
  }

  const client = await VellumPlatformClient.create();
  if (!client) {
    resetConsentToUnknown();
    return;
  }

  // No resolvable owner identity → unknown (don't ride a stale opt-in).
  if (!client.platformAssistantId) {
    resetConsentToUnknown();
    return;
  }

  const consent = await client.getOwnerConsent();
  if (consent) {
    setCachedShareAnalytics(consent.shareAnalytics);
    setCachedShareDiagnostics(consent.shareDiagnostics);
    setCachedShareDiagnosticsVersion(consent.shareDiagnosticsAcceptedVersion);
  }
}

function resetConsentToUnknown(): void {
  setCachedShareAnalytics("unknown");
  setCachedShareDiagnostics("unknown");
  setCachedShareDiagnosticsVersion("");
}

function setCachedShareAnalytics(value: ConsentState): void {
  if (value !== cachedShareAnalytics) {
    log.debug(
      { from: cachedShareAnalytics, to: value },
      "share_analytics consent changed",
    );
    cachedShareAnalytics = value;
  }
}

function setCachedShareDiagnostics(value: ConsentState): void {
  if (value !== cachedShareDiagnostics) {
    log.debug(
      { from: cachedShareDiagnostics, to: value },
      "share_diagnostics consent changed",
    );
    cachedShareDiagnostics = value;
  }
}

function setCachedShareDiagnosticsVersion(value: string): void {
  if (value !== cachedShareDiagnosticsVersion) {
    log.debug(
      { from: cachedShareDiagnosticsVersion, to: value },
      "share_diagnostics_accepted_version changed",
    );
    cachedShareDiagnosticsVersion = value;
  }
}

/**
 * Begin periodic consent refresh. Idempotent — a second call is a no-op while a
 * timer is already running. Runs one immediate refresh, then every 5 minutes.
 */
export function startConsentRefresh(): void {
  if (refreshTimer) {
    return;
  }

  refreshConsentCache().catch((err) => {
    log.debug({ err }, "initial consent refresh failed");
  });
  refreshTimer = setInterval(() => {
    refreshConsentCache().catch((err) => {
      log.debug({ err }, "consent refresh failed");
    });
  }, REFRESH_INTERVAL_MS);
}

/** Stop periodic consent refresh and clear the timer. */
export async function stopConsentRefresh(): Promise<void> {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/** Test-only: override the cached analytics value without going through a refresh. */
export function __setCachedShareAnalyticsForTest(value: ConsentState): void {
  cachedShareAnalytics = value;
}

/** Test-only: override the cached diagnostics value without going through a refresh. */
export function __setCachedShareDiagnosticsForTest(value: ConsentState): void {
  cachedShareDiagnostics = value;
}

/** Test-only: override the cached diagnostics-consent version directly. */
export function __setCachedShareDiagnosticsVersionForTest(value: string): void {
  cachedShareDiagnosticsVersion = value;
}
