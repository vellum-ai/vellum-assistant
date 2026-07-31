import type { CompactionCircuitEvent } from "../plugins/types.js";

/**
 * Consecutive summary-LLM failures required to trip the breaker.
 */
export const COMPACTION_CIRCUIT_FAILURE_THRESHOLD = 3;

/**
 * Cooldown window after the breaker trips, during which auto-compaction is
 * suspended.
 */
export const COMPACTION_CIRCUIT_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Per-conversation compaction circuit breaker: three consecutive summary-LLM
 * failures trip a one-hour cooldown during which auto-compaction is skipped;
 * any successful compaction resets the counter. State is in-memory only —
 * resets on process restart, the intended "one free retry after restart"
 * behavior.
 *
 * The dev-only playground routes (`POST /playground/reset-compaction-circuit`,
 * `POST /playground/inject-compaction-failures`) read and mutate
 * `consecutiveCompactionFailures` and `compactionCircuitOpenUntil` directly on
 * this object.
 */
export class CompactionCircuit {
  readonly conversationId: string;
  consecutiveCompactionFailures = 0;
  compactionCircuitOpenUntil: number | null = null;
  /**
   * Estimated input tokens immediately after the most recent compaction pass,
   * or `null` before any pass this process. The budget gate's regrowth
   * hysteresis reads it: if the history has not grown by at least
   * `MIN_REGROWTH` tokens since this watermark, the previous pass already
   * proved it cannot free more, so re-compacting would only thrash. Lives here
   * because its lifetime must match the per-conversation circuit (the loop owns
   * one circuit per conversation). Reset on process restart, the intended "one
   * free retry after restart" behavior the failure counter already has.
   */
  lastPostCompactionEstimate: number | null = null;

  constructor(conversationId: string) {
    this.conversationId = conversationId;
  }

  /**
   * Update the breaker with the outcome of a `maybeCompact` call and emit any
   * transition event. Callers must only invoke this when the summary LLM
   * actually ran (`summaryFailed !== undefined`) so early-return paths don't
   * silently reset the 3-strike counter.
   *
   * A run of three failures trips the breaker; any success resets both the
   * counter and the cooldown timestamp. `compaction_circuit_open` fires once
   * when the counter first reaches the threshold while the circuit is dormant;
   * `compaction_circuit_closed` fires only on the open→closed transition.
   */
  async recordOutcome(
    summaryFailed: boolean,
    onEvent: (msg: CompactionCircuitEvent) => void,
  ): Promise<void> {
    if (summaryFailed) {
      this.consecutiveCompactionFailures += 1;
      // Treat a stale/expired open-until timestamp the same as null so a new
      // 3-strike window can re-open the circuit after the prior cooldown
      // elapses. Without this, subsequent trips would no-op because
      // `compactionCircuitOpenUntil` remains set to a past timestamp even
      // though the breaker is effectively closed.
      const circuitDormant =
        this.compactionCircuitOpenUntil === null ||
        Date.now() >= this.compactionCircuitOpenUntil;
      if (
        this.consecutiveCompactionFailures >=
          COMPACTION_CIRCUIT_FAILURE_THRESHOLD &&
        circuitDormant
      ) {
        const openUntil = Date.now() + COMPACTION_CIRCUIT_COOLDOWN_MS;
        this.compactionCircuitOpenUntil = openUntil;
        onEvent({
          type: "compaction_circuit_open",
          conversationId: this.conversationId,
          reason: "3_consecutive_failures",
          openUntil,
        });
      }
    } else {
      // Emit only on the open→closed transition; firing on the common
      // closed→closed case would be noise.
      const wasOpen = this.compactionCircuitOpenUntil !== null;
      this.consecutiveCompactionFailures = 0;
      this.compactionCircuitOpenUntil = null;
      if (wasOpen) {
        onEvent({
          type: "compaction_circuit_closed",
          conversationId: this.conversationId,
        });
      }
    }
  }

  /**
   * Query-only: is the breaker currently open? Auto-compaction paths gate on
   * `!isOpen()`; forced paths admit regardless. An expired open-until
   * timestamp reads as closed — it is the only source of truth for the gate.
   */
  async isOpen(): Promise<boolean> {
    const openUntil = this.compactionCircuitOpenUntil;
    return openUntil !== null && Date.now() < openUntil;
  }
}
