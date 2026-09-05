import { type AbortReason, isAbortReason } from "../../util/abort-reasons.js";
import type { ToolContext } from "../types.js";

/**
 * Stop a side-effecting tool whose turn was cancelled before it acted.
 *
 * Call this immediately before the step that changes something the user would
 * notice: a write, a create/update/delete, a message send, a process spawn, a
 * paid provider call. The agent loop tells the model an aborted batch was
 * cancelled, so anything that lands after the abort is work the model believes
 * never happened.
 *
 * Throws the signal's own reason, which is the daemon's tagged `AbortReason`
 * for a conversation abort and a `DOMException` named `AbortError` for a plain
 * one. The tool executor recognizes both and reports the call as an expected
 * cancellation rather than a tool failure.
 */
export function throwIfCancelled(context: Pick<ToolContext, "signal">): void {
  context.signal?.throwIfAborted();
}

/**
 * Extract the tagged {@link AbortReason} from a thrown value: the value
 * itself, its `reason` (an `AbortError` carrying the signal's reason), or a
 * provider wrapper's `abortReason`. Returns `undefined` for anything that is
 * not a daemon-owned abort.
 */
export function extractAbortReason(err: unknown): AbortReason | undefined {
  if (isAbortReason(err)) {
    return err;
  }
  const reason = (err as { reason?: unknown } | null)?.reason;
  if (isAbortReason(reason)) {
    return reason;
  }
  const abortReason = (err as { abortReason?: unknown } | null)?.abortReason;
  if (isAbortReason(abortReason)) {
    return abortReason;
  }
  return undefined;
}

/**
 * True when a thrown value is a cancellation rather than a tool failure: a
 * daemon-owned abort reason, or the `AbortError` a plain `AbortSignal` throws.
 * Wrappers that convert throws into error results must re-throw these so the
 * cancellation reaches the executor's abort handling intact.
 */
export function isAbortLikeError(err: unknown): boolean {
  return (
    extractAbortReason(err) !== undefined ||
    (err instanceof Error && err.name === "AbortError")
  );
}
