import { type AbortReason, isAbortReason } from "../../util/abort-reasons.js";

// The guard itself lives on the plugin API surface, the one module a plugin
// may import from, so host tools and plugin tools share a single
// implementation. Re-exported here because this is where host tools look for
// the cancellation vocabulary.
export { throwIfCancelled } from "../../plugin-api/tool-cancellation.js";

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
