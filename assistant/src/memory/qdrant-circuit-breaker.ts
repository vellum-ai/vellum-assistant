import { getLogger } from "../util/logger.js";

const log = getLogger("qdrant-circuit-breaker");

/**
 * Circuit breaker for Qdrant operations.
 *
 * After FAILURE_THRESHOLD consecutive failures, the circuit opens and
 * all calls fail-fast without hitting Qdrant. After COOLDOWN_MS, one
 * probe request is allowed through (half-open). If the probe succeeds,
 * the circuit closes; if it fails, the circuit re-opens.
 */

const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 30_000;

type BreakerState = "closed" | "open" | "half-open";

let breakerState: BreakerState = "closed";
let consecutiveFailures = 0;
let openedAt = 0;
let halfOpenProbeInFlight = false;

export class QdrantCircuitOpenError extends Error {
  constructor() {
    super("Qdrant circuit breaker open");
    this.name = "QdrantCircuitOpenError";
  }
}

function allows(): boolean {
  if (breakerState === "closed") return true;
  if (breakerState === "open") {
    if (Date.now() - openedAt >= COOLDOWN_MS) {
      breakerState = "half-open";
      halfOpenProbeInFlight = true;
      log.info(
        "Qdrant circuit breaker entering half-open state — allowing probe request",
      );
      return true;
    }
    return false;
  }
  // half-open: only allow through if no probe is already in flight
  if (halfOpenProbeInFlight) return false;
  halfOpenProbeInFlight = true;
  return true;
}

function recordSuccess(): void {
  if (breakerState !== "closed") {
    log.info(
      { previousFailures: consecutiveFailures },
      "Qdrant circuit breaker closed — operation succeeded",
    );
  }
  consecutiveFailures = 0;
  breakerState = "closed";
  openedAt = 0;
  halfOpenProbeInFlight = false;
}

function recordFailure(): void {
  consecutiveFailures++;
  halfOpenProbeInFlight = false;
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    breakerState = "open";
    openedAt = Date.now();
    log.warn(
      { consecutiveFailures, cooldownMs: COOLDOWN_MS },
      "Qdrant circuit breaker opened — Qdrant operations disabled until probe succeeds",
    );
  } else if (breakerState === "half-open") {
    breakerState = "open";
    openedAt = Date.now();
    log.warn("Qdrant circuit breaker re-opened — half-open probe failed");
  }
}

/**
 * Execute a Qdrant operation through the circuit breaker.
 * Throws QdrantCircuitOpenError if the circuit is open.
 * Re-throws the original error on failure after recording it.
 */
export async function withQdrantBreaker<T>(fn: () => Promise<T>): Promise<T> {
  if (!allows()) {
    throw new QdrantCircuitOpenError();
  }
  try {
    const result = await fn();
    recordSuccess();
    return result;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

/** Check whether the circuit breaker is currently failing fast (open or half-open with probe in flight). */
export function isQdrantBreakerOpen(): boolean {
  return breakerState !== "closed";
}

/** @internal Test-only: reset circuit breaker state */
export function _resetQdrantBreaker(): void {
  breakerState = "closed";
  consecutiveFailures = 0;
  openedAt = 0;
  halfOpenProbeInFlight = false;
}
