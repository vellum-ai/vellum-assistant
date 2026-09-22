/**
 * The turn-cancellation guard every side-effecting tool calls, host tools and
 * plugin tools alike. It lives on the plugin API surface because that is the
 * only module a plugin may import from, and the guard must be one
 * implementation rather than a copy per side of the boundary.
 */

/** The slice of a tool's context this guard reads. */
export interface CancellableToolContext {
  /** Cooperative cancellation signal for the turn, when the caller supplies one. */
  signal?: AbortSignal;
}

/**
 * Stop a side-effecting tool whose turn was cancelled before it acted.
 *
 * Call this immediately before the step that changes something the user would
 * notice: a write, a create/update/delete, a message send, a process spawn, a
 * paid provider call. The agent loop tells the model an aborted batch was
 * cancelled, so anything that lands after the abort is work the model believes
 * never happened.
 *
 * Throws the signal's own reason, which is the daemon's tagged abort reason
 * for a conversation abort and a `DOMException` named `AbortError` for a plain
 * one. The tool executor recognizes both and reports the call as an expected
 * cancellation rather than a tool failure.
 */
export function throwIfCancelled(context: CancellableToolContext): void {
  context.signal?.throwIfAborted();
}
