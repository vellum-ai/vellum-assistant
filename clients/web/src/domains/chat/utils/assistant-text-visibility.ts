/**
 * Whether an assistant row's plain text is something the user reads.
 *
 * - `"private"`: the row's reply travels through `send_user_message`, so its
 *   prose is a working scratchpad. The daemon projects such a row before it
 *   ships it: the prose arrives as `thinking` blocks and each
 *   `send_user_message` call as the `text` block carrying its message.
 * - `"visible"`: the row's own plain text is its reply.
 *
 * No marker means the standard transcript rendering, which is what a row
 * without one gets.
 */
export type AssistantTextVisibility = "private" | "visible";

/**
 * Read the marker off a wire payload that carries one: a history
 * `ConversationMessage` or a `message_complete` event. Anything but the two
 * known values answers `undefined`, so an unmarked row and a value this client
 * does not recognize both render the standard way rather than hiding or
 * restyling a reply.
 *
 * The read goes through the payload's runtime shape because the field is the
 * daemon's to declare, and this client renders correctly whether or not a
 * given daemon sends it.
 */
export function readAssistantTextVisibility(
  payload: unknown,
): AssistantTextVisibility | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const value = (payload as { assistantTextVisibility?: unknown })
    .assistantTextVisibility;
  return value === "private" || value === "visible" ? value : undefined;
}
