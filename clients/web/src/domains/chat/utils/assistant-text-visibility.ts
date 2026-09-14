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

/**
 * The tool a row's reply travels through when its prose is a scratchpad. Its
 * argument is the reply itself, which the daemon also streams as ordinary
 * assistant text and projects into a `text` block on the persisted row, so the
 * call is never a step the transcript has anything to draw.
 *
 * A call to it is also the earliest proof a row is private: the daemon
 * announces the call while its input is still streaming, before the reply text
 * and before `message_complete` carries the authoritative marker.
 */
export const SEND_USER_MESSAGE_TOOL_NAME = "send_user_message";

/**
 * Whether a tool call is the user-facing reply channel rather than a step of
 * the assistant's work. Structural in its argument so both the render path and
 * the stream fold can ask, without either owning the answer.
 */
export function isSendUserMessageCall(toolCall: { name: string }): boolean {
  return toolCall.name === SEND_USER_MESSAGE_TOOL_NAME;
}
