/**
 * Circuit breaker for managed fallback routes, keyed by upstream provider name
 * (`"openai"`, `"anthropic"`, ...).
 *
 * Once a backup profile has served a request, the primary upstream is known to
 * be down. Paying the full retry budget on every later request only adds
 * latency to an answer the backup was always going to give, so the breaker
 * remembers the outage and sends the next requests straight to the backup.
 * Recovery is request-driven: after a cooldown, exactly one request probes the
 * primary. A successful probe closes the breaker; a failed one re-trips it with
 * a longer cooldown.
 *
 * The cooldown carries plus or minus 20 percent of jitter so a fleet of daemons
 * coming out of the same provider outage does not probe a recovering upstream
 * in the same second.
 *
 * State is intentionally process-local and never persisted: the daemon is a
 * single process, and a restart resets every route to its primary. The worst
 * case for that choice is one request rediscovering an ongoing outage the
 * expensive way, which is exactly what the very first request of an outage
 * already pays.
 */

import { getLogger } from "../util/logger.js";

const log = getLogger("fallback-breaker");

/** Eligible failures inside this window count toward the trip threshold. */
const FAILURE_WINDOW_MS = 5 * 60_000;

/** Eligible failures needed to trip when no backup has served yet. */
const FAILURES_TO_TRIP = 2;

/** Cooldown before the first recovery probe is admitted. */
const BASE_COOLDOWN_MS = 120_000;

/** Ceiling for the doubling cooldown, so a long outage still gets probed. */
const MAX_COOLDOWN_MS = 10 * 60_000;

/** Fraction of the cooldown spent on desynchronizing jitter. */
const COOLDOWN_JITTER = 0.2;

interface BreakerState {
  /** Timestamps of recent eligible failures, pruned to the failure window. */
  failures: number[];
  /** When the current cooldown expires, or null while the breaker is closed. */
  openUntil: number | null;
  /** Consecutive failed recovery probes; each one doubles the cooldown. */
  failedProbes: number;
  /** Whether a probe is currently deciding recovery for this upstream. */
  probeInFlight: boolean;
}

const breakers = new Map<string, BreakerState>();

function stateFor(upstream: string): BreakerState {
  const existing = breakers.get(upstream);
  if (existing !== undefined) {
    return existing;
  }
  const created: BreakerState = {
    failures: [],
    openUntil: null,
    failedProbes: 0,
    probeInFlight: false,
  };
  breakers.set(upstream, created);
  return created;
}

/**
 * Cooldown for the next open period. Doubles per consecutive failed probe and
 * is capped at {@link MAX_COOLDOWN_MS} both before and after jitter, so the
 * ceiling holds for the value actually used.
 */
function cooldownMs(failedProbes: number): number {
  const base = Math.min(BASE_COOLDOWN_MS * 2 ** failedProbes, MAX_COOLDOWN_MS);
  const jittered = base * (1 + (Math.random() * 2 - 1) * COOLDOWN_JITTER);
  return Math.min(Math.round(jittered), MAX_COOLDOWN_MS);
}

function trip(
  upstream: string,
  state: BreakerState,
  now: number,
  reason: string,
): void {
  const cooldown = cooldownMs(state.failedProbes);
  state.openUntil = now + cooldown;
  state.failures = [];
  log.info(
    {
      upstream,
      cooldownMs: cooldown,
      failedProbes: state.failedProbes,
      reason,
    },
    "Fallback breaker tripped; routing to the backup profile until the cooldown expires",
  );
}

/** Whether the breaker is open, whatever the cooldown says. */
function isOpen(
  state: BreakerState | undefined,
): state is BreakerState & { openUntil: number } {
  return state !== undefined && state.openUntil !== null;
}

/**
 * Record an outage-shaped failure of the primary route. Two of them inside
 * {@link FAILURE_WINDOW_MS} trip the breaker; a single blip does not. A failure
 * recorded while the breaker is already open changes nothing, since only a
 * recovery probe decides when to close it.
 */
export function recordPrimaryFailure(
  upstream: string,
  now: number = Date.now(),
): void {
  const state = stateFor(upstream);
  if (isOpen(state)) {
    return;
  }
  state.failures = state.failures.filter((at) => now - at < FAILURE_WINDOW_MS);
  state.failures.push(now);
  if (state.failures.length >= FAILURES_TO_TRIP) {
    trip(upstream, state, now, "eligible_failures");
  }
}

/**
 * Record that a backup profile actually served a request the primary could
 * not. This trips the breaker immediately: unlike a bare failure, a completed
 * backup serve proves both that the primary is down and that the backup can
 * carry the traffic, so there is nothing left to learn from the next request
 * repeating the same discovery.
 */
export function recordFallbackServed(
  upstream: string,
  now: number = Date.now(),
): void {
  const state = stateFor(upstream);
  if (isOpen(state)) {
    return;
  }
  trip(upstream, state, now, "fallback_served");
}

/** Record a successful primary send, clearing any failure history. */
export function recordPrimarySuccess(
  upstream: string,
  now: number = Date.now(),
): void {
  const state = breakers.get(upstream);
  if (state === undefined) {
    return;
  }
  if (isOpen(state)) {
    log.info(
      { upstream, openForMs: Math.max(0, state.openUntil - now) },
      "Primary route served a request; closing the fallback breaker",
    );
  }
  breakers.delete(upstream);
}

/**
 * Whether this request should skip the primary route and go straight to the
 * backup. True while the cooldown runs, and also while a probe is in flight, so
 * concurrent requests keep using the backup instead of piling onto a route a
 * single probe is still testing.
 */
export function shouldSkipPrimary(
  upstream: string,
  now: number = Date.now(),
): boolean {
  const state = breakers.get(upstream);
  if (!isOpen(state)) {
    return false;
  }
  return state.probeInFlight || now < state.openUntil;
}

/**
 * Claim the single recovery probe for an open breaker whose cooldown has
 * expired. Returns false for every other caller, including concurrent ones,
 * which keep skipping the primary via {@link shouldSkipPrimary}.
 */
export function tryAcquireRecoveryProbe(
  upstream: string,
  now: number = Date.now(),
): boolean {
  const state = breakers.get(upstream);
  if (!isOpen(state)) {
    return false;
  }
  if (state.probeInFlight || now < state.openUntil) {
    return false;
  }
  state.probeInFlight = true;
  return true;
}

/**
 * Report the outcome of the probe claimed by {@link tryAcquireRecoveryProbe}.
 * Success closes the breaker; failure re-trips it with a doubled cooldown.
 */
export function releaseRecoveryProbe(
  upstream: string,
  succeeded: boolean,
  now: number = Date.now(),
): void {
  const state = breakers.get(upstream);
  if (state === undefined) {
    return;
  }
  state.probeInFlight = false;
  if (succeeded) {
    log.info(
      { upstream, failedProbes: state.failedProbes },
      "Recovery probe succeeded; closing the fallback breaker",
    );
    breakers.delete(upstream);
    return;
  }
  state.failedProbes += 1;
  trip(upstream, state, now, "recovery_probe_failed");
}

/** Test-only: drop every remembered route so state cannot leak between tests. */
export function resetFallbackBreaker(): void {
  breakers.clear();
}
