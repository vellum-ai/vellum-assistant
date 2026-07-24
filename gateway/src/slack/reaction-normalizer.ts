import { isSlackDmChannel } from "./channel.js";
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

  // DM reactions should still route via default assistant (same as DM messages).
  // Only apply fallback to DM channels (D...) — reactions from unrouted public
  // channels should not bypass explicit routing policy.
  let routing = resolveAssistant(config, channel, event.user);
  if (
    isRejection(routing) &&
    config.defaultAssistantId &&
    isSlackDmChannel(channel)
  ) {
    routing = {
      assistantId: config.defaultAssistantId,
      routeSource: "default" as const,
    };
  }
  if (isRejection(routing)) return null;

  const prefix = op === "added" ? "reaction" : "reaction_removed";
  const callbackData = `${prefix}:${event.reaction}`;
  // Include reactor user ID to prevent dedup collisions when multiple
  // users react with the same emoji on the same message. Append the op
  // suffix so an add and a subsequent remove of the same emoji by the
  // same user produce distinct externalMessageIds.
  const externalMessageId =
    op === "added"
      ? `${channel}:${event.item.ts}:${event.reaction}:${event.user}`
      : `${channel}:${event.item.ts}:${event.reaction}:${event.user}:removed`;

  return {
    event: {
      version: "v1",
      sourceChannel: "slack",
      receivedAt: new Date().toISOString(),
      message: {
        content: callbackData,
        conversationExternalId: channel,
        externalMessageId,
        callbackData,
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
