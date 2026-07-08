import {
  getMessageById,
  updateMessageMetadata,
} from "../persistence/conversation-crud.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("turn-outcome");

/**
 * Abnormal turn outcomes stamped onto the turn's user-message row.
 *
 * - `"batched"` — the message was coalesced into a later turn's shared
 *   response (`drainBatch`); the reply lives on the turn identified by
 *   `turnBatchedInto`.
 * - `"failed"` — the agent loop terminated in a non-cancellation error.
 *   Includes turns whose only assistant output is the synthetic
 *   provider-error message.
 * - `"cancelled"` — the user cancelled the turn (stop / barge-in).
 *
 * A normally-replied turn carries no stamp: absence of `turnOutcome` on a
 * settled turn means the turn replied (or, rarely, the process died
 * mid-turn before any stamp could land).
 */
export type TurnOutcome = "batched" | "failed" | "cancelled";

export interface TurnOutcomeExtras {
  /**
   * For `"batched"`: `messages.id` of the final batch member whose window
   * carries the shared response (that turn's `daemon_event_id` on the wire).
   */
  batchedInto?: string;
  /** For `"failed"`: stable classified error code (never free-form text). */
  failureCode?: string;
}

/**
 * Durably stamp a turn's outcome onto its user-message row
 * (`messages.metadata.turnOutcome` / `.turnBatchedInto` / `.turnFailureCode`).
 * The turn-event scan (`queryUnreportedTurnEvents`) projects these keys onto
 * the `turn` telemetry event, so the stamp must land before the turn settles —
 * callers run while the conversation is still processing.
 *
 * Best-effort: telemetry stamping must never break the turn path, so every
 * error is logged and swallowed.
 */
export function stampTurnOutcome(
  userMessageId: string,
  outcome: TurnOutcome,
  extras: TurnOutcomeExtras = {},
): void {
  try {
    updateMessageMetadata(userMessageId, {
      turnOutcome: outcome,
      ...(extras.batchedInto ? { turnBatchedInto: extras.batchedInto } : {}),
      ...(extras.failureCode ? { turnFailureCode: extras.failureCode } : {}),
    });
  } catch (err) {
    log.warn(
      { err, userMessageId, outcome },
      "Failed to stamp turn outcome (non-fatal)",
    );
  }
}

/**
 * The failure outcome of a completed turn, read back from the stamp
 * {@link stampTurnOutcome} wrote onto its user-message row.
 *
 * A turn can fail *without throwing*: when an LLM call fails (e.g. an invalid
 * provider), the agent loop catches it, emits an error event, and persists a
 * synthetic error message before returning normally. Callers that only watch
 * for a thrown exception (the scheduler's execute mode) would otherwise record
 * such a turn as a success — {@link readTurnFailure} lets them detect it.
 */
export interface TurnFailure {
  /** Stable classified error code (never free-form text). */
  failureCode?: string;
}

/**
 * Read back a turn's failure from the outcome stamped onto its user-message
 * row. Returns null unless the turn was stamped `"failed"` — a normal reply,
 * a cancellation, or a batched turn all read as "no failure". Sourcing this
 * from the same metadata {@link stampTurnOutcome} writes keeps a single record
 * of the outcome rather than a parallel copy that could drift.
 */
export function readTurnFailure(userMessageId: string): TurnFailure | null {
  const message = getMessageById(userMessageId);
  if (!message?.metadata) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.metadata);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const meta = parsed as { turnOutcome?: unknown; turnFailureCode?: unknown };
  if (meta.turnOutcome !== "failed") {
    return null;
  }
  return typeof meta.turnFailureCode === "string"
    ? { failureCode: meta.turnFailureCode }
    : {};
}
