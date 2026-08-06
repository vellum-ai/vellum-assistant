import type { SlackInboundEvent } from "./envelope.js";
import type {
  SlackChannelMessageEvent,
  SlackMessageChangedEvent,
  SlackMessageDeletedEvent,
  SlackReactionEvent,
} from "./message-schemas.js";

/**
 * A Slack inbound event narrowed to exactly one dispatch kind, with the event
 * typed as the matching leaf shape.
 *
 * The leaf schemas carry non-literal `type` / `subtype` discriminators (both
 * `string | undefined`), so TypeScript cannot narrow `SlackInboundEvent` on its
 * own — every reader would otherwise cast. `classifySlackEvent` performs that
 * narrowing once, at a single validated point, and every consumer switches on
 * `kind` to get a typed `event` without a cast.
 *
 * The `app_mention` and plain `message` kinds share the one message shape; the
 * plain-message kind is the direct-message / channel-message / active-thread
 * family whose DM-vs-channel split the dispatch resolves from the channel.
 */
export type ClassifiedSlackEvent =
  | { kind: "app_mention"; event: SlackChannelMessageEvent }
  | { kind: "message"; event: SlackChannelMessageEvent }
  | { kind: "message_changed"; event: SlackMessageChangedEvent }
  | { kind: "message_deleted"; event: SlackMessageDeletedEvent }
  | { kind: "reaction_added"; event: SlackReactionEvent }
  | { kind: "reaction_removed"; event: SlackReactionEvent };

/**
 * Classify a Slack inbound event by its `type` / `subtype` discriminators.
 *
 * Returns `null` for an event whose `type` is not one the dispatch handles
 * (e.g. an unmodeled system subtype); the caller drops it. This is the single
 * seam that turns the tolerantly-parsed event union into a discriminated kind,
 * so the `type` / `subtype` narrowing casts live here and nowhere else.
 */
export function classifySlackEvent(
  event: SlackInboundEvent,
): ClassifiedSlackEvent | null {
  const type = event.type;
  if (type === "app_mention") {
    return { kind: "app_mention", event: event as SlackChannelMessageEvent };
  }
  if (type === "reaction_added") {
    return { kind: "reaction_added", event: event as SlackReactionEvent };
  }
  if (type === "reaction_removed") {
    return { kind: "reaction_removed", event: event as SlackReactionEvent };
  }
  if (type === "message") {
    const subtype = (event as SlackMessageChangedEvent).subtype;
    if (subtype === "message_changed") {
      return {
        kind: "message_changed",
        event: event as SlackMessageChangedEvent,
      };
    }
    if (subtype === "message_deleted") {
      return {
        kind: "message_deleted",
        event: event as SlackMessageDeletedEvent,
      };
    }
    return { kind: "message", event: event as SlackChannelMessageEvent };
  }
  return null;
}
