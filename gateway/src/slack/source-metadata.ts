import type { NormalizedSlackEvent } from "./message-schemas.js";

/**
 * Slack-specific fields added to a forwarded event's `sourceMetadata`. Indexed
 * so it composes with the wider `SourceMetadata` the gateway forwards.
 */
export interface SlackSourceMetadata {
  [key: string]: unknown;
  slackBotMentioned?: true;
  threadId?: string;
}

/**
 * Build the Slack fields the runtime reads off `sourceMetadata`.
 *
 * `threadTs` answers "where does a reply go". For a message with no thread of
 * its own that is a thread rooted at the message itself, and the runtime is
 * right to key the conversation there, because the assistant's reply is what
 * creates that thread.
 *
 * An edit or a button press replies into the same place but creates no thread.
 * Passing them the same value as `threadId` keys a conversation on a thread
 * that will never exist, so the runtime mints one per edited message and one
 * per card tapped. They get none, and resolve against the conversation the
 * message they refer to already lives in.
 *
 * Reply targeting is unaffected either way: it travels in the delivery
 * callback URL, not here.
 */
export function buildSlackSourceMetadata(
  normalized: NormalizedSlackEvent,
): SlackSourceMetadata {
  const { message, source, raw } = normalized.event;
  const refersToAnotherMessage =
    message.isEdit === true || typeof message.callbackData === "string";

  return {
    ...(raw.type === "app_mention" ? { slackBotMentioned: true as const } : {}),
    ...(normalized.threadTs && !source.threadId && !refersToAnotherMessage
      ? { threadId: normalized.threadTs }
      : {}),
  };
}
