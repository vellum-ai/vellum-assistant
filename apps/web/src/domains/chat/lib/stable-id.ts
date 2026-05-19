/**
 * Monotonic, per-process counter appended to a time prefix. Guaranteed
 * unique within a browser tab and stable once assigned to a message.
 *
 * Used as the row identity for messages in the transcript so that optimistic
 * user messages, streaming assistant bubbles, and reconciled server messages
 * keep the same identity even when the server `id` changes (e.g. an
 * optimistic user message gets its id assigned on reconciliation).
 */
let counter = 0;

export function newStableId(prefix: string = "msg"): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}
