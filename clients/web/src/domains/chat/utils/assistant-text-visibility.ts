/**
 * What an assistant row's plain text was to the user who saw the turn.
 *
 * - `"private"`: the turn routed its reply through `send_user_message`, so the
 *   prose is a working scratchpad the user never read. The daemon projects such
 *   a row before it ships it: raw text arrives as `thinking` blocks and each
 *   `send_user_message` call as the `text` block carrying its message.
 * - `"visible"`: the turn ran under the tool gate but ended without ever
 *   calling the tool, so its raw text was surfaced as the fallback reply.
 *
 * Absent on every other row, which is every row today: a call, a subagent leg,
 * a turn written before the gate, or a turn from a daemon that predates the
 * marker. Absent means "shipped behavior", so nothing has to know why.
 */
export type AssistantTextVisibility = "private" | "visible";

/**
 * Read the marker off a wire payload that may carry it: a history
 * `ConversationMessage` or a `message_complete` event. Anything but the two
 * known values answers `undefined`, so an unmarked row, an older daemon, and a
 * value this client does not recognize all degrade to the shipped rendering
 * rather than hiding or restyling a reply.
 *
 * The read goes through the payload's runtime shape because the field is the
 * daemon's to declare, and this client must render correctly against daemons
 * on either side of it.
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
