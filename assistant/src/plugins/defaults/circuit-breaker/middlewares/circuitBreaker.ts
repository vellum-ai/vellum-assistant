import type {
  CircuitBreakerArgs,
  CircuitBreakerResult,
  Middleware,
} from "../../../types.js";

/**
 * Consecutive failures required to trip the breaker. Matches the legacy
 * `COMPACTION_CIRCUIT_FAILURE_THRESHOLD` in `conversation-agent-loop.ts`.
 */
export const COMPACTION_CIRCUIT_FAILURE_THRESHOLD = 3;

/**
 * Cooldown window after the breaker trips, during which auto-compaction is
 * suspended. Matches the legacy `COMPACTION_CIRCUIT_COOLDOWN_MS`.
 */
export const COMPACTION_CIRCUIT_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Default middleware for the `circuitBreaker` pipeline. A thin wrapper over the
 * state container passed in `CircuitBreakerArgs.state`:
 *
 * - `{ key }` — query. Defers to `next` for the current
 *   `{ open, cooldownRemainingMs? }`.
 * - `{ key, outcome }` — update state based on outcome, then defer to `next`
 *   for the post-update decision. A run of three failures trips the breaker;
 *   any non-failure outcome resets both the counter and the cooldown timestamp.
 *
 * Event emission preserves the existing `trackCompactionOutcome` behavior:
 * `compaction_circuit_open` fires once when the counter first reaches the
 * threshold while the circuit is dormant; `compaction_circuit_closed` fires
 * only on the open→closed transition.
 */
const circuitBreaker: Middleware<CircuitBreakerArgs, CircuitBreakerResult> =
  async function circuitBreaker(args, next) {
    const { outcome, state, onEvent } = args;

    // Update branch — mutate state first, then defer to the downstream
    // chain (or terminal) for the decision so outer observers still see
    // the fully-processed outcome. Separating state mutation from
    // decision computation also keeps this middleware composable: an
    // outer plugin may wrap the invocation to observe both the pre-update
    // args and the post-update result.
    if (outcome !== undefined) {
      if (outcome === "failure") {
        state.consecutiveCompactionFailures += 1;
        // Treat a stale/expired open-until timestamp the same as null so
        // a new 3-strike window can re-open the circuit after the prior
        // cooldown elapses. Without this, subsequent trips would no-op
        // because `compactionCircuitOpenUntil` remains set to a past
        // timestamp even though the breaker is effectively closed.
        const circuitDormant =
          state.compactionCircuitOpenUntil === null ||
          Date.now() >= state.compactionCircuitOpenUntil;
        if (
          state.consecutiveCompactionFailures >=
            COMPACTION_CIRCUIT_FAILURE_THRESHOLD &&
          circuitDormant
        ) {
          const openUntil = Date.now() + COMPACTION_CIRCUIT_COOLDOWN_MS;
          state.compactionCircuitOpenUntil = openUntil;
          if (onEvent) {
            onEvent({
              type: "compaction_circuit_open",
              conversationId: state.conversationId,
              reason: "3_consecutive_failures",
              openUntil,
            });
          }
        }
      } else {
        // Emit only on the open→closed transition; firing on the common
        // closed→closed case would be noise.
        const wasOpen = state.compactionCircuitOpenUntil !== null;
        state.consecutiveCompactionFailures = 0;
        state.compactionCircuitOpenUntil = null;
        if (wasOpen && onEvent) {
          onEvent({
            type: "compaction_circuit_closed",
            conversationId: state.conversationId,
          });
        }
      }
    }

    // Defer to downstream (the terminal, in the default registration, but
    // potentially another plugin in a customized chain) for the final
    // decision. The terminal's implementation is the canonical read of
    // the (now-updated) state container.
    return next(args);
  };

export default circuitBreaker;
