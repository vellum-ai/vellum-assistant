import type { SourceMetadata } from "@vellumai/gateway-client";

import { eventRefersToAnotherMessage } from "../channels/inbound-event.js";
import type { NormalizedSlackEvent } from "./message-schemas.js";

/** The `sourceMetadata` fields the Slack ingress path sets. */
export type SlackSourceMetadata = Pick<
  SourceMetadata,
  "slackBotMentioned" | "threadId"
>;

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

  return {
    ...(raw.type === "app_mention" ? { slackBotMentioned: true } : {}),
    ...(normalized.threadTs &&
    !source.threadId &&
    !eventRefersToAnotherMessage(message)
      ? { threadId: normalized.threadTs }
      : {}),
  };
}
