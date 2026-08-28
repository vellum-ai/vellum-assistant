/**
 * Circuit breaker for managed fallback routes.
 *
 * Once a backup profile has served a request, the primary route is known to be
 * down. Paying the full retry budget on every later request only adds latency
 * to an answer the backup was always going to give, so the breaker remembers
 * the outage and sends the next requests straight to the backup. Recovery is
 * request-driven: after a cooldown, exactly one request probes the primary. A
 * successful probe closes the breaker; a failed one re-trips it with a longer
 * cooldown.
 *
 * Scope
 * -----
 * A remembered outage is keyed by the route it was actually observed on, and
 * the two failure shapes this feature exists for indict different things:
 *
 * - An upstream outage (5xx, 429, transport failure, a broken managed
 *   credential) indicts the whole provider, so it is remembered under the
 *   upstream name and every model on it skips the primary.
 * - A retired or renamed model (404, `model_not_found`, the managed proxy's
 *   preflight 400) indicts one model. Remembering it provider-wide would
 *   divert healthy profiles on the same upstream to their backups for the
 *   whole cooldown, and would let a probe of some other healthy model close a
 *   breaker the retired model still deserves. It is remembered under the
 *   upstream plus that model instead.
 *
 * Reads always name the full route, so a request is skipped when either its
 * upstream or its exact model is remembered as down.
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

/**
 * A route the breaker can remember. `model` narrows the entry to a single
 * model: writes that omit it record an upstream-wide outage, and reads that
 * include it consult both the upstream entry and the model's own.
 */
export interface BreakerRoute {
  upstream: string;
  model?: string;
}

/**
 * Identifies the breaker state that observed a primary failure. A fallback
 * completion may arrive after a recovery probe, so it must only update the
 * state that was current when the primary failed.
 */
export interface BreakerObservation {
  key: string;
  generation: number;
}

interface BreakerState {
  /** Timestamps of recent eligible failures, pruned to the failure window. */
  failures: number[];
  /** When the current cooldown expires, or null while the breaker is closed. */
  openUntil: number | null;
  /** Consecutive failed recovery probes; each one doubles the cooldown. */
  failedProbes: number;
  /** Whether a probe is currently deciding recovery for this entry. */
  probeInFlight: boolean;
  /** Monotonic identity for this state generation. */
  generation: number;
}

const breakers = new Map<string, BreakerState>();
let nextGeneration = 0;

/**
 * The single entry a write targets. A model-scoped key can never collide with
 * an upstream name: the separator is a space, which no provider id contains.
 */
function keyOf(route: BreakerRoute): string {
  return route.model === undefined
    ? route.upstream
    : `${route.upstream} ${route.model}`;
}

/** Every entry that governs this route, upstream-wide first. */
function coveringKeys(route: BreakerRoute): string[] {
  return route.model === undefined
    ? [route.upstream]
    : [route.upstream, keyOf(route)];
}

function stateFor(key: string): BreakerState {
  const existing = breakers.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created: BreakerState = {
    failures: [],
    openUntil: null,
    failedProbes: 0,
    probeInFlight: false,
    generation: ++nextGeneration,
  };
  breakers.set(key, created);
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
  key: string,
  state: BreakerState,
  now: number,
  reason: string,
): void {
  const cooldown = cooldownMs(state.failedProbes);
  state.openUntil = now + cooldown;
  state.failures = [];
  log.info(
    {
      route: key,
      cooldownMs: cooldown,
      failedProbes: state.failedProbes,
      reason,
    },
    "Fallback breaker tripped; routing to the backup profile until the cooldown expires",
  );
}

/** Whether the entry is open, whatever the cooldown says. */
function isOpen(
  state: BreakerState | undefined,
): state is BreakerState & { openUntil: number } {
  return state !== undefined && state.openUntil !== null;
}

/** Open entries governing this route, paired with their keys. */
function openCovering(
  route: BreakerRoute,
): { key: string; state: BreakerState & { openUntil: number } }[] {
  const open: { key: string; state: BreakerState & { openUntil: number } }[] =
    [];
  for (const key of coveringKeys(route)) {
    const state = breakers.get(key);
    if (isOpen(state)) {
      open.push({ key, state });
    }
  }
  return open;
}

/**
 * Record an outage-shaped failure of the primary route. Two of them inside
 * {@link FAILURE_WINDOW_MS} trip the breaker; a single blip does not. A failure
 * recorded while the entry is already open changes nothing, since only a
 * recovery probe decides when to close it.
 *
 * The caller decides the scope by what it names: pass the upstream alone for
 * an outage, upstream plus model for a failure that indicts one model.
 */
export function recordPrimaryFailure(
  route: BreakerRoute,
  now: number = Date.now(),
): BreakerObservation {
  const key = keyOf(route);
  const state = stateFor(key);
  if (isOpen(state)) {
    return { key, generation: state.generation };
  }
  state.failures = state.failures.filter((at) => now - at < FAILURE_WINDOW_MS);
  state.failures.push(now);
  if (state.failures.length >= FAILURES_TO_TRIP) {
    trip(key, state, now, "eligible_failures");
  }
  return { key, generation: state.generation };
}

/**
 * Record that a backup profile actually served a request the primary could
 * not. This trips the breaker immediately: unlike a bare failure, a completed
 * backup serve proves both that the primary is down and that the backup can
 * carry the traffic, so there is nothing left to learn from the next request
 * repeating the same discovery. Scoped by what the caller names, as above.
 */
export function recordFallbackServed(
  route: BreakerRoute,
  now: number = Date.now(),
  observation?: BreakerObservation,
): void {
  const key = keyOf(route);
  const state = observation === undefined ? stateFor(key) : breakers.get(key);
  if (
    observation !== undefined &&
    (state === undefined ||
      observation.key !== key ||
      observation.generation !== state.generation)
  ) {
    log.info(
      { route: key, observation, currentGeneration: state?.generation },
      "Ignoring a stale fallback serve for the fallback breaker",
    );
    return;
  }
  if (state === undefined || isOpen(state)) {
    return;
  }
  trip(key, state, now, "fallback_served");
}

/**
 * Record a successful primary send, clearing any failure history for the route
 * that served it. Both the upstream entry and this model's own entry are
 * cleared: the upstream answered, and it answered for this model. Another
 * model's remembered outage on the same upstream is left alone.
 */
export function recordPrimarySuccess(
  route: BreakerRoute,
  now: number = Date.now(),
): void {
  for (const key of coveringKeys(route)) {
    const state = breakers.get(key);
    if (state === undefined) {
      continue;
    }
    if (isOpen(state)) {
      log.info(
        { route: key, openForMs: Math.max(0, state.openUntil - now) },
        "Primary route served a request; closing the fallback breaker",
      );
    }
    breakers.delete(key);
  }
}

/**
 * Whether this request should skip the primary route and go straight to the
 * backup. True while any entry governing the route is inside its cooldown, and
 * also while a probe is in flight, so concurrent requests keep using the backup
 * instead of piling onto a route a single probe is still testing.
 */
export function shouldSkipPrimary(
  route: BreakerRoute,
  now: number = Date.now(),
): boolean {
  return openCovering(route).some(
    ({ state }) => state.probeInFlight || now < state.openUntil,
  );
}

/**
 * Claim the single recovery probe for a route whose remembered outages have all
 * cooled down. Returns false for every other caller, including concurrent ones,
 * which keep skipping the primary via {@link shouldSkipPrimary}.
 */
export function tryAcquireRecoveryProbe(
  route: BreakerRoute,
  now: number = Date.now(),
): boolean {
  const open = openCovering(route);
  if (open.length === 0) {
    return false;
  }
  if (open.some(({ state }) => state.probeInFlight || now < state.openUntil)) {
    return false;
  }
  for (const { state } of open) {
    state.probeInFlight = true;
  }
  return true;
}

/**
 * What a recovery probe learned about the route it tested.
 *
 * - `recovered`: the primary served the probe.
 * - `failing`: it did not, and `failedRoute` names what THIS failure indicts,
 *   scoped the same way an initial trip is (the whole upstream for an outage,
 *   one model for a retirement). Null when the failure names nothing the
 *   breaker can remember, in which case the probed entries simply close.
 * - `abandoned`: the probe never reached a verdict, because the caller
 *   cancelled the request. No evidence either way.
 */
export type ProbeOutcome =
  | { verdict: "recovered" }
  | { verdict: "failing"; failedRoute: BreakerRoute | null }
  | { verdict: "abandoned" };

/**
 * Report the outcome of the probe claimed by {@link tryAcquireRecoveryProbe}.
 *
 * A probe that reached a verdict closes every entry it was testing. It is the
 * freshest evidence about those entries and it supersedes whatever opened
 * them: an upstream that answers a probe with a retired-model 404 is an
 * upstream that answers, so continuing to divert its healthy models would be
 * acting on stale evidence. What a failing probe does establish is then
 * recorded anew under `failedRoute`, carrying the escalated cooldown forward,
 * so a route that keeps failing the same way still doubles its wait while a
 * route whose failure changed shape is remembered at its true scope.
 *
 * An `abandoned` probe only hands the claim back. A cancelled request never
 * asked the route anything, so treating it as recovery would delete a breaker
 * that nothing has retested and send the next request through the full retry
 * budget of a route still known to be down. The entry keeps its deadline and
 * its escalation count: the cancellation neither counts as a failed probe nor
 * restarts the wait, it just leaves the probe due again.
 */
export function releaseRecoveryProbe(
  route: BreakerRoute,
  outcome: ProbeOutcome,
  now: number = Date.now(),
): void {
  if (outcome.verdict === "abandoned") {
    for (const key of coveringKeys(route)) {
      const state = breakers.get(key);
      if (state === undefined || !state.probeInFlight) {
        continue;
      }
      state.probeInFlight = false;
      log.info(
        { route: key, failedProbes: state.failedProbes },
        "Recovery probe was cancelled before it reached the upstream; the fallback breaker keeps its cooldown",
      );
    }
    return;
  }
  // Consecutive failed probes decide the next cooldown, so the count survives
  // a change of scope: an outage that narrows to one model keeps escalating
  // rather than restarting at the base wait.
  let escalation = 0;
  for (const key of coveringKeys(route)) {
    const state = breakers.get(key);
    if (state === undefined || !state.probeInFlight) {
      continue;
    }
    state.probeInFlight = false;
    escalation = Math.max(escalation, state.failedProbes);
    if (outcome.verdict === "recovered") {
      log.info(
        { route: key, failedProbes: state.failedProbes },
        "Recovery probe succeeded; closing the fallback breaker",
      );
    }
    breakers.delete(key);
  }
  const failedRoute =
    outcome.verdict === "recovered" ? null : outcome.failedRoute;
  if (failedRoute === null) {
    return;
  }
  const key = keyOf(failedRoute);
  const state = stateFor(key);
  state.failedProbes = Math.max(state.failedProbes, escalation) + 1;
  trip(key, state, now, "recovery_probe_failed");
}

/** Test-only: drop every remembered route so state cannot leak between tests. */
export function resetFallbackBreaker(): void {
  breakers.clear();
}
