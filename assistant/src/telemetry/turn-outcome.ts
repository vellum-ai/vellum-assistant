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
  /**
   * For `"failed"`: the classification's authored user-facing message
   * (`classifyConversationError(...).userMessage`), so downstream failure
   * reporting (background-job alerts) can render the actionable prose the
   * chat banner shows instead of reconstructing degraded text from the code.
   */
  failureMessage?: string;
  /** For `"failed"`: the classification's machine-readable category. */
  failureCategory?: string;
  /**
   * For `"failed"`: name of the `provider_connections` row in play when the
   * failure occurred, when the classifier had it in scope.
   */
  failureConnection?: string;
  /**
   * For `"failed"`: the resolved profile key the failing call ran under,
   * when the classifier had it in scope. This is dispatch's own attribution,
   * so consumers scope failure identity by it instead of re-resolving.
   */
  failureProfile?: string;
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
    // The failure* keys are read back by `readTurnFailure` only; the turn
    // telemetry projection (`queryUnreportedTurnEvents`) extracts none of
    // them, so nothing here changes the platform wire contract.
    updateMessageMetadata(userMessageId, {
      turnOutcome: outcome,
      ...(extras.batchedInto ? { turnBatchedInto: extras.batchedInto } : {}),
      ...(extras.failureCode ? { turnFailureCode: extras.failureCode } : {}),
      ...(extras.failureMessage
        ? { turnFailureMessage: extras.failureMessage }
        : {}),
      ...(extras.failureCategory
        ? { turnFailureCategory: extras.failureCategory }
        : {}),
      ...(extras.failureConnection
        ? { turnFailureConnection: extras.failureConnection }
        : {}),
      ...(extras.failureProfile
        ? { turnFailureProfile: extras.failureProfile }
        : {}),
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
  /** The classification's authored user-facing message, when stamped. */
  userMessage?: string;
  /** The classification's machine-readable category, when stamped. */
  errorCategory?: string;
  /** Connection row in play when the failure occurred, when stamped. */
  connectionName?: string;
  /** Resolved profile key the failing call ran under, when stamped. */
  profileName?: string;
}

/**
 * Read back a turn's failure from the outcome stamped onto its user-message
 * row. Returns null unless the turn was stamped `"failed"` — a normal reply,
 * a cancellation, or a batched turn all read as "no failure". Sourcing this
 * from the same metadata {@link stampTurnOutcome} writes keeps a single record
 * of the outcome rather than a parallel copy that could drift.
 */
export function readTurnFailure(userMessageId: string): TurnFailure | null {
  let metadataJson: string | null;
  try {
    metadataJson = getMessageById(userMessageId)?.metadata ?? null;
  } catch (err) {
    // Best-effort, mirroring stampTurnOutcome: a telemetry read on the turn
    // path must never throw, so a DB hiccup degrades to "no failure recorded".
    log.warn({ err, userMessageId }, "Failed to read turn outcome (non-fatal)");
    return null;
  }
  if (!metadataJson) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const meta = parsed as {
    turnOutcome?: unknown;
    turnFailureCode?: unknown;
    turnFailureMessage?: unknown;
    turnFailureCategory?: unknown;
    turnFailureConnection?: unknown;
    turnFailureProfile?: unknown;
  };
  if (meta.turnOutcome !== "failed") {
    return null;
  }
  const str = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;
  const failure: TurnFailure = {};
  const failureCode = str(meta.turnFailureCode);
  if (failureCode !== undefined) {
    failure.failureCode = failureCode;
  }
  const userMessage = str(meta.turnFailureMessage);
  if (userMessage !== undefined) {
    failure.userMessage = userMessage;
  }
  const errorCategory = str(meta.turnFailureCategory);
  if (errorCategory !== undefined) {
    failure.errorCategory = errorCategory;
  }
  const connectionName = str(meta.turnFailureConnection);
  if (connectionName !== undefined) {
    failure.connectionName = connectionName;
  }
  const profileName = str(meta.turnFailureProfile);
  if (profileName !== undefined) {
    failure.profileName = profileName;
  }
  return failure;
}
