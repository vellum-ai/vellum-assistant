import { getConfigReadOnly } from "../config/loader.js";
import { memoryTier } from "../config/memory-tier.js";
import { getRawShareAnalytics } from "../platform/consent-cache.js";
import { getLogger } from "../util/logger.js";
import { recordWatchdogEvent } from "./watchdog-events-store.js";

const log = getLogger("memory-tier-reporter");

/**
 * How often each assistant re-asserts its coarse memory tier as a
 * `memory_tier` watchdog event. Unlike the config-setting snapshot this emits
 * UNCONDITIONALLY every cycle (no memo): the platform-side query wants a
 * periodic per-assistant heartbeat of the current tier, so a gap in the series
 * is meaningful (assistant offline) rather than "value unchanged". Six-hourly
 * keeps the volume trivial while giving a same-day read on the fleet's tier
 * mix, and every boot re-asserts the tier regardless.
 */
const MEMORY_TIER_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Watchdog `check_name` carrying the coarse memory tier in `detail.tier`. */
const MEMORY_TIER_CHECK_NAME = "memory_tier";

// The boot-time emit races the first consent refresh (fire-and-forget in the
// monitor's startup), so consent is usually still "unknown" on the first call
// and the emit is skipped. Retry on a short timer until consent resolves
// rather than waiting a full six-hour interval for the per-boot assertion.
const BOOT_RETRY_INTERVAL_MS = 60_000;

/**
 * Emit one `memory_tier` watchdog event for this assistant's current tier.
 *
 * Consent-gated like the config-setting snapshot but with NO memo: every
 * invocation emits, so the platform sees a periodic heartbeat of the current
 * tier rather than only edges. An UNKNOWN consent state skips entirely
 * (consent resolves asynchronously after boot; the boot-retry loop re-invokes
 * once it lands) — deferring loses nothing since the tier is re-derivable
 * state. A confirmed opt-out is honored inside `recordWatchdogEvent`, which
 * no-ops on a `false` share_analytics, so the call still goes through and the
 * record layer drops it. Never throws: a storage failure is logged and
 * retried on the next cycle.
 */
export function recordMemoryTierOnce(): void {
  if (getRawShareAnalytics() === "unknown") {
    return;
  }
  try {
    // `getConfigReadOnly()` re-reads config.json on change (capturing live
    // edits) and never writes to disk — safe for the monitor process.
    const tier = memoryTier(getConfigReadOnly());
    recordWatchdogEvent({
      checkName: MEMORY_TIER_CHECK_NAME,
      detail: { tier },
    });
  } catch (err) {
    log.warn({ err }, "memory_tier watchdog emit failed (non-fatal)");
  }
}

let tierTimer: ReturnType<typeof setInterval> | null = null;
let bootRetryTimer: ReturnType<typeof setTimeout> | null = null;

function recordBootTierOnceConsentKnown(): void {
  if (getRawShareAnalytics() === "unknown") {
    bootRetryTimer = setTimeout(
      recordBootTierOnceConsentKnown,
      BOOT_RETRY_INTERVAL_MS,
    );
    bootRetryTimer.unref?.();
    return;
  }
  bootRetryTimer = null;
  recordMemoryTierOnce();
}

/**
 * Start the memory-tier reporter in the resource monitor process: emit the
 * current tier once at boot (once consent resolves), then every six hours,
 * UNCONDITIONALLY. No-op in dev mode (VELLUM_DEV=1) and idempotent if already
 * started. Runs alongside {@link import("./config-setting-snapshot.js").startConfigSnapshotReporter}
 * in the monitor worker.
 */
export function startMemoryTierReporter(): void {
  if (process.env.VELLUM_DEV === "1") {
    return;
  }
  if (tierTimer) {
    return;
  }
  recordBootTierOnceConsentKnown();
  tierTimer = setInterval(recordMemoryTierOnce, MEMORY_TIER_INTERVAL_MS);
}

/** Stop the memory-tier reporter loop. Idempotent. */
export function stopMemoryTierReporter(): void {
  if (tierTimer) {
    clearInterval(tierTimer);
    tierTimer = null;
  }
  if (bootRetryTimer) {
    clearTimeout(bootRetryTimer);
    bootRetryTimer = null;
  }
}
