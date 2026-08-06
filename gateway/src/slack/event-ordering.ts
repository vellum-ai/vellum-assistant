import type { SlackInboundEvent } from "./envelope.js";
import { classifySlackEvent } from "./classify-event.js";

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
  event: SlackInboundEvent,
  eventId: string,
): string {
  const classified = classifySlackEvent(event);
  switch (classified?.kind) {
    case "reaction_added":
    case "reaction_removed": {
      const { item } = classified.event;
      return `${item?.channel ?? eventId}:${item?.ts ?? eventId}`;
    }
    case "message_changed": {
      const changed = classified.event;
      return `${changed.channel}:${changed.message?.thread_ts ?? changed.message?.ts ?? eventId}`;
    }
    case "message_deleted": {
      const deleted = classified.event;
      return `${deleted.channel}:${deleted.previous_message?.thread_ts ?? deleted.deleted_ts ?? eventId}`;
    }
    default: {
      // app_mention / plain message (or an unclassifiable event): key on the
      // message's own thread, falling back to its ts then the eventId.
      const message = classified?.event;
      return `${message?.channel}:${message?.thread_ts ?? message?.ts ?? eventId}`;
    }
  }
}
