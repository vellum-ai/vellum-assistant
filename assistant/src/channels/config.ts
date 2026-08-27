/**
 * Canonical per-channel policy registry.
 *
 * Every ChannelId must have an entry here. The `satisfies` constraint
 * ensures that adding a new ChannelId to channels/types.ts will fail
 * to compile until a policy is added below.
 */

import { CHANNEL_IDS, type ChannelId } from "./types.js";

export type ConversationStrategy =
  | "start_new_conversation"
  | "continue_existing_conversation"
  | "not_deliverable"
  | "push_only";

export interface ChannelNotificationPolicy {
  notification: {
    deliveryEnabled: boolean;
    conversationStrategy: ConversationStrategy;
  };
}

const CHANNEL_POLICIES = {
  vellum: {
    notification: {
      deliveryEnabled: true,
      conversationStrategy: "start_new_conversation",
    },
  },
  telegram: {
    notification: {
      deliveryEnabled: true,
      conversationStrategy: "continue_existing_conversation",
    },
  },
  whatsapp: {
    notification: {
      deliveryEnabled: false,
      conversationStrategy: "continue_existing_conversation",
    },
  },
  slack: {
    notification: {
      deliveryEnabled: true,
      conversationStrategy: "continue_existing_conversation",
    },
  },
  email: {
    notification: {
      deliveryEnabled: false,
      conversationStrategy: "continue_existing_conversation",
    },
  },
  platform: {
    notification: {
      deliveryEnabled: true,
      // Platform is a push-only relay — conversations are owned by the vellum
      // channel. push_only skips pairDeliveryWithConversation without implying
      // the channel is non-deliverable (which not_deliverable would).
      conversationStrategy: "push_only",
    },
  },
  phone: {
    notification: {
      deliveryEnabled: false,
      conversationStrategy: "not_deliverable",
    },
  },
  a2a: {
    notification: {
      deliveryEnabled: false,
      conversationStrategy: "continue_existing_conversation",
    },
  },
  discord: {
    notification: {
      // Replies to an inbound Discord message do not read this flag: they
      // route by `replyCallbackUrl` through the channel transport. This gates
      // proactive notification, which addresses the verified guardian
      // directly: the adapter resolves a DM channel from the guardian
      // binding's user snowflake, so a notification can never land in a
      // guild room whose id merely looks like a DM's (both are bare
      // snowflakes).
      deliveryEnabled: true,
      conversationStrategy: "continue_existing_conversation",
    },
  },
  plugin: {
    notification: {
      // Every plugin-brought channel shares this row, so the answer has to
      // hold for all of them. A reply to an inbound plugin message routes by
      // `replyCallbackUrl` and does not read this flag; proactive notification
      // does, and it needs a guardian binding plus a destination resolver to
      // reach. Neither exists per-plugin, and `NotificationChannel` is derived
      // from this flag, so enabling it would let the decision engine pick a
      // channel that resolves to nothing for whichever plugin it landed on.
      deliveryEnabled: false,
      conversationStrategy: "continue_existing_conversation",
    },
  },
} as const satisfies Record<ChannelId, ChannelNotificationPolicy>;

export type ChannelPolicies = typeof CHANNEL_POLICIES;

/** Returns the full policy for a channel. */
export function getChannelPolicy(
  channelId: ChannelId,
): ChannelNotificationPolicy {
  return CHANNEL_POLICIES[channelId];
}

/**
 * The channels whose policy enables proactive delivery, derived from the
 * registry's literal flags: flipping a channel's deliveryEnabled changes
 * this union, and every exhaustive switch over it, at compile time.
 */
export type DeliverableChannelId = {
  [K in keyof ChannelPolicies]: ChannelPolicies[K]["notification"]["deliveryEnabled"] extends true
    ? K
    : never;
}[keyof ChannelPolicies];

/**
 * Returns the list of channels where notification delivery is enabled.
 *
 * The return type is derived from the registry so downstream consumers
 * get a narrow union rather than the full ChannelId set.
 */
export function getDeliverableChannels(): DeliverableChannelId[] {
  return CHANNEL_IDS.filter(isNotificationDeliverable);
}

/** Whether notification delivery is enabled for the given channel. */
export function isNotificationDeliverable(
  channelId: ChannelId,
): channelId is DeliverableChannelId {
  return CHANNEL_POLICIES[channelId].notification.deliveryEnabled;
}

/** Returns the conversation strategy for the given channel. */
export function getConversationStrategy(
  channelId: ChannelId,
): ConversationStrategy {
  return CHANNEL_POLICIES[channelId].notification.conversationStrategy;
}
