import {
  slackReactionEventSchema,
  type SlackReactionEvent,
  type NormalizedSlackEvent,
} from "./message-schemas.js";
import type { GatewayConfig } from "../config.js";
import { resolveAssistant, isRejection } from "../routing/resolve-assistant.js";

/**
 * Shared normalizer for Slack reaction events. Both `reaction_added` and
 * `reaction_removed` carry the same payload shape and differ only in the
 * downstream callback prefix and externalMessageId suffix.
 */
function normalizeSlackReaction(
  event: SlackReactionEvent,
  rawEvent: Record<string, unknown>,
  eventId: string,
  config: GatewayConfig,
  op: "added" | "removed",
): NormalizedSlackEvent | null {
  // `reaction` is load-bearing: it forms the `callbackData` and part of the
  // dedup `externalMessageId`. Without this guard a collapsed (missing /
  // non-string) reaction would emit `reaction:undefined`, which the
  // assistant-side parser treats as a real emoji named "undefined" rather
  // than dropping it.
  if (
    !event.user ||
    !event.reaction ||
    !event.item?.channel ||
    !event.item?.ts
  ) {
    return null;
  }

  const channel = event.item.channel;

  const routing = resolveAssistant(config, channel, event.user);
  if (isRejection(routing)) return null;

  // Slack's `event_id` is what makes this id name one event rather than one
  // kind of event. The addressing parts (channel, message ts, emoji, reactor,
  // op) are stable across every occurrence of the same person re-adding the
  // same emoji, so on their own they collapse a re-add into the first add:
  // `recordInbound` answers `duplicate`, the intercept returns before writing
  // a transcript row, and the removal stays the last recorded state forever.
  // The event id is the one component that differs per occurrence while still
  // repeating on a genuine redelivery. Slack calls it "a unique identifier
  // for this specific event, globally unique across all workspaces", and a
  // re-sent envelope carries the same one, which is why `socket-mode.ts`
  // already keys its own in-process dedup on it.
  const externalMessageId =
    op === "added"
      ? `${channel}:${event.item.ts}:${event.reaction}:${event.user}:${eventId}`
      : `${channel}:${event.item.ts}:${event.reaction}:${event.user}:removed:${eventId}`;

  return {
    event: {
      version: "v1",
      sourceChannel: "slack",
      receivedAt: new Date().toISOString(),
      message: {
        eventKind: "reaction",
        // A reaction has no user-authored text; its payload is structured.
        content: "",
        conversationExternalId: channel,
        externalMessageId,
        reaction: {
          op,
          emoji: event.reaction,
          targetMessageId: event.item.ts,
        },
        // A daemon that does not yet understand the structured payload
        // dispatches reactions on the kind and reads this string
        // unconditionally, so the sentinel form stays required beside the
        // payload for mixed-version readers.
        callbackData: `${op === "added" ? "reaction" : "reaction_removed"}:${event.reaction}`,
      },
      actor: {
        actorExternalId: event.user,
      },
      source: {
        updateId: eventId,
        messageId: event.item.ts,
        threadId: event.item.ts,
      },
      raw: rawEvent,
    },
    routing,
    threadTs: event.item.ts,
    channel,
  };
}

/**
 * Normalize a Slack `reaction_added` event into the gateway's canonical
 * inbound event shape. The reaction emoji name is placed in `callbackData`
 * (prefixed with `reaction:`) so downstream handlers can process it like a
 * callback action.
 *
 * Returns null if the event is missing required fields or cannot be routed.
 */
export function normalizeSlackReactionAdded(
  event: unknown,
  eventId: string,
  config: GatewayConfig,
): NormalizedSlackEvent | null {
  const parsed = slackReactionEventSchema.safeParse(event);
  if (!parsed.success) return null;
  return normalizeSlackReaction(
    parsed.data,
    event as Record<string, unknown>,
    eventId,
    config,
    "added",
  );
}

/**
 * Normalize a Slack `reaction_removed` event into the gateway's canonical
 * inbound event shape. The emoji name is placed in `callbackData` with a
 * `reaction_removed:` prefix so downstream handlers can distinguish removals
 * from additions.
 *
 * Returns null if the event is missing required fields or cannot be routed.
 */
export function normalizeSlackReactionRemoved(
  event: unknown,
  eventId: string,
  config: GatewayConfig,
): NormalizedSlackEvent | null {
  const parsed = slackReactionEventSchema.safeParse(event);
  if (!parsed.success) return null;
  return normalizeSlackReaction(
    parsed.data,
    event as Record<string, unknown>,
    eventId,
    config,
    "removed",
  );
}
