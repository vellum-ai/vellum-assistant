import type { TrustContext } from "../daemon/trust-context.js";
import { FALLBACK_TURN_TRUST } from "../daemon/trust-context.js";
import { DEFAULT_TIMEOUTS, runPipeline } from "../plugins/pipeline.js";
import { getMiddlewaresFor } from "../plugins/registry.js";
import type {
  CircuitBreakerArgs,
  CircuitBreakerResult,
  CompactionCircuitEvent,
  TurnContext,
} from "../plugins/types.js";

/**
 * Turn-scoped identifiers the circuit pipeline runner needs to populate its
 * log records and plugin attribution. They are supplied per call because they
 * belong to the active turn, not to the circuit's durable state — non-turn
 * callers (e.g. `Conversation.forceCompact`) leave the optional fields unset
 * and fall back to stable placeholders.
 */
export interface CircuitTurnInfo {
  currentRequestId?: string;
  currentTurnTrustContext?: TrustContext;
  trustContext?: TrustContext;
  turnCount: number;
}

/**
 * Per-conversation compaction circuit breaker: three consecutive summary-LLM
 * failures trip a one-hour cooldown during which auto-compaction is skipped;
 * any successful compaction resets the counter. State is in-memory only —
 * resets on process restart, the intended "one free retry after restart"
 * behavior.
 *
 * The breaker's threshold/cooldown semantics live in the `circuitBreaker`
 * plugin (`plugins/defaults/circuit-breaker/register.ts`), which mutates this
 * object in place via the `CircuitBreakerArgs.state` container. This class is
 * that container plus the methods the rest of the daemon uses to query and
 * update it, so the dev-only playground routes can read and write the same
 * fields directly.
 */
export class CompactionCircuit {
  readonly conversationId: string;
  consecutiveCompactionFailures = 0;
  compactionCircuitOpenUntil: number | null = null;

  constructor(conversationId: string) {
    this.conversationId = conversationId;
  }

  /**
   * Update the breaker with the outcome of a `maybeCompact` call and emit any
   * transition event. Callers must only invoke this when the summary LLM
   * actually ran (`summaryFailed !== undefined`) so early-return paths don't
   * silently reset the 3-strike counter.
   */
  async recordOutcome(
    turn: CircuitTurnInfo,
    summaryFailed: boolean,
    onEvent: (msg: CompactionCircuitEvent) => void,
  ): Promise<void> {
    await this.run(turn, {
      outcome: summaryFailed ? "failure" : "success",
      onEvent,
    });
  }

  /**
   * Query-only: is the breaker currently open? Auto-compaction paths gate on
   * `!isOpen(...)`; forced paths admit regardless of the decision.
   */
  async isOpen(turn: CircuitTurnInfo): Promise<boolean> {
    const decision = await this.run(turn, {});
    return decision.open;
  }

  /**
   * Clear the breaker: zero the failure counter and close the circuit,
   * emitting `compaction_circuit_closed` on the open→closed transition.
   * Equivalent to recording a successful outcome.
   */
  async reset(
    turn: CircuitTurnInfo,
    onEvent?: (msg: CompactionCircuitEvent) => void,
  ): Promise<void> {
    await this.run(turn, {
      outcome: "success",
      ...(onEvent ? { onEvent } : {}),
    });
  }

  private async run(
    turn: CircuitTurnInfo,
    args: {
      outcome?: "success" | "failure";
      onEvent?: (msg: CompactionCircuitEvent) => void;
    },
  ): Promise<CircuitBreakerResult> {
    const turnContext = this.buildTurnContext(turn);
    return runPipeline<CircuitBreakerArgs, CircuitBreakerResult>(
      "circuitBreaker",
      getMiddlewaresFor("circuitBreaker"),
      async (terminalArgs) => {
        // No plugin in the chain produced a decision. This should be
        // unreachable in production because the default plugin registers a
        // `circuitBreaker` middleware that always returns a decision, but we
        // defensively derive the state here so test setups that intentionally
        // omit the default plugin still get a sensible response.
        const openUntil = terminalArgs.state.compactionCircuitOpenUntil;
        const now = Date.now();
        if (openUntil !== null && now < openUntil) {
          return { open: true, cooldownRemainingMs: openUntil - now };
        }
        return { open: false };
      },
      {
        key: `compaction:${this.conversationId}`,
        // Pass this circuit as the mutable state container. The
        // `CircuitBreakerArgs.state` shape matches its `conversationId` /
        // `consecutiveCompactionFailures` / `compactionCircuitOpenUntil`
        // fields so plugins mutate the same object the playground routes read.
        state: this,
        ...(args.outcome !== undefined ? { outcome: args.outcome } : {}),
        ...(args.onEvent ? { onEvent: args.onEvent } : {}),
      },
      turnContext,
      DEFAULT_TIMEOUTS.circuitBreaker,
    );
  }

  private buildTurnContext(turn: CircuitTurnInfo): TurnContext {
    return {
      requestId: turn.currentRequestId ?? "circuit-breaker",
      conversationId: this.conversationId,
      turnIndex: turn.turnCount,
      trust:
        turn.currentTurnTrustContext ??
        turn.trustContext ??
        FALLBACK_TURN_TRUST,
    };
  }
}
