import type {
  SlackAppMentionEvent,
  SlackChannelMessageEvent,
  SlackDirectMessageEvent,
  SlackMessageChangedEvent,
  SlackMessageDeletedEvent,
  SlackReactionEvent,
} from "./normalize.js";

/** The Slack event shapes that flow through ordered normalization. */
export type SlackOrderableEvent =
  | SlackAppMentionEvent
  | SlackDirectMessageEvent
  | SlackChannelMessageEvent
  | SlackMessageChangedEvent
  | SlackMessageDeletedEvent
  | SlackReactionEvent;

/**
 * Ordering key that groups related Slack events onto a single sequential lane,
 * so an edit or reaction is processed after the message it concerns.
 *
 * This runs on **untrusted** event data and **before** normalization, so every
 * nested field access is guarded: `reaction.item` and `message_changed.message`
 * can be absent on a malformed event (a `message_changed` in a subscribed
 * channel is admitted without requiring `message`), and dereferencing them here
 * would throw and take down the emit path. A missing field falls back to the
 * unique `eventId` so ordering never crashes.
 */
export function slackEventOrderingKey(
  event: SlackOrderableEvent,
  eventId: string,
): string {
  if (event.type === "reaction_added" || event.type === "reaction_removed") {
    const reaction = event as SlackReactionEvent;
    return `${reaction.item?.channel ?? eventId}:${reaction.item?.ts ?? eventId}`;
  }

  if (
    event.type === "message" &&
    (event as SlackMessageChangedEvent).subtype === "message_changed"
  ) {
    const changed = event as SlackMessageChangedEvent;
    return `${changed.channel}:${changed.message?.thread_ts ?? changed.message?.ts ?? eventId}`;
  }

  if (
    event.type === "message" &&
    (event as SlackMessageDeletedEvent).subtype === "message_deleted"
  ) {
    const deleted = event as SlackMessageDeletedEvent;
    return `${deleted.channel}:${deleted.previous_message?.thread_ts ?? deleted.deleted_ts ?? eventId}`;
  }

  const message = event as
    | SlackAppMentionEvent
    | SlackDirectMessageEvent
    | SlackChannelMessageEvent;
  return `${message.channel}:${message.thread_ts ?? message.ts ?? eventId}`;
}
