/**
 * In-memory cache of the platform owner's `share_analytics` consent.
 *
 * Record-time telemetry gates need a synchronous, I/O-free read, so this module
 * owns the consent value and refreshes it periodically in the background.
 * Default-off until the first successful fetch: an absent session, a disabled
 * platform, or a transient fetch failure all leave the value untouched (initial
 * `false`), so we never report analytics without a confirmed opt-in.
 */

import { getConfigReadOnly } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import { VellumPlatformClient } from "./client.js";

const log = getLogger("consent-cache");

const REFRESH_INTERVAL_MS = 5 * 60_000; // refresh consent every 5 min

let cachedShareAnalytics = false; // default-off until first success
// Fail-closed marker for a workspace that locally opted out of usage data
// before telemetry moved to platform `share_analytics` consent (migration 106).
// While set, telemetry stays off regardless of platform consent. Cleared by a
// future cross-repo reconciliation once the platform exposes an explicit
// re-consent signal; not auto-cleared here.
let legacyOptOut = false;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Synchronous hot-path accessor for the effective `share_analytics` consent.
 * Never does I/O; returns `false` until a successful refresh proves otherwise,
 * and stays `false` while the legacy fail-closed opt-out marker is set.
 */
export function getCachedShareAnalytics(): boolean {
  return cachedShareAnalytics && !legacyOptOut;
}

/**
 * Refresh the cached consent from the platform.
 *
 * No platform session / features disabled (`create()` is null) → default-off.
 * No resolvable assistant identity (no owner whose consent we can attest to) →
 * fail closed. A successful fetch adopts the reported value. A `null` fetch
 * (transient failure / undeployed endpoint) leaves the previous value unchanged
 * so a known opt-in is not flipped off mid-session.
 */
export async function refreshConsentCache(): Promise<void> {
  legacyOptOut = getConfigReadOnly().legacyTelemetryOptOut === true;

  const client = await VellumPlatformClient.create();
  if (!client) {
    setCachedShareAnalytics(false);
    return;
  }

  // No resolvable owner identity → fail closed (don't ride a stale opt-in).
  if (!client.platformAssistantId) {
    setCachedShareAnalytics(false);
    return;
  }

  const consent = await client.getOwnerConsent();
  if (consent) {
    setCachedShareAnalytics(consent.shareAnalytics);
  }
}

function setCachedShareAnalytics(value: boolean): void {
  if (value !== cachedShareAnalytics) {
    log.debug(
      { from: cachedShareAnalytics, to: value },
      "share_analytics consent changed",
    );
    cachedShareAnalytics = value;
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

/** Test-only: override the cached value without going through a refresh. */
export function __setCachedShareAnalyticsForTest(value: boolean): void {
  cachedShareAnalytics = value;
}
