/**
 * Canonical per-channel policy registry.
 *
 * Every ChannelId must have an entry here. The `satisfies` constraint
 * ensures that adding a new ChannelId to channels/types.ts will fail
 * to compile until a policy is added below.
 */

import type { ChannelId } from "./types.js";

export type ConversationStrategy =
  | "start_new_conversation"
  | "continue_existing_conversation"
  | "not_deliverable";

export interface ChannelInvitePolicy {
  /** Whether inbound invite code redemption is supported on this channel. */
  codeRedemptionEnabled: boolean;
}

export interface ChannelNotificationPolicy {
  notification: {
    deliveryEnabled: boolean;
    conversationStrategy: ConversationStrategy;
  };
  invite: ChannelInvitePolicy;
}

const CHANNEL_POLICIES = {
  vellum: {
    notification: {
      deliveryEnabled: true,
      conversationStrategy: "start_new_conversation",
    },
    invite: {
      codeRedemptionEnabled: false,
    },
  },
  telegram: {
    notification: {
      deliveryEnabled: true,
      conversationStrategy: "continue_existing_conversation",
    },
    invite: {
      codeRedemptionEnabled: true,
    },
  },
  whatsapp: {
    notification: {
      deliveryEnabled: false,
      conversationStrategy: "continue_existing_conversation",
    },
    invite: {
      codeRedemptionEnabled: true,
    },
  },
  slack: {
    notification: {
      deliveryEnabled: true,
      conversationStrategy: "continue_existing_conversation",
    },
    invite: {
      codeRedemptionEnabled: true,
    },
  },
  email: {
    notification: {
      deliveryEnabled: false,
      conversationStrategy: "continue_existing_conversation",
    },
    invite: {
      codeRedemptionEnabled: true,
    },
  },
  phone: {
    notification: {
      deliveryEnabled: false,
      conversationStrategy: "not_deliverable",
    },
    invite: {
      codeRedemptionEnabled: false,
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
 * Returns the list of channels where notification delivery is enabled.
 *
 * The return type is derived from the registry so downstream consumers
 * get a narrow union rather than the full ChannelId set.
 */
export function getDeliverableChannels(): ChannelId[] {
  return (Object.keys(CHANNEL_POLICIES) as ChannelId[]).filter(
    (id) => CHANNEL_POLICIES[id].notification.deliveryEnabled,
  );
}

/** Whether notification delivery is enabled for the given channel. */
export function isNotificationDeliverable(channelId: ChannelId): boolean {
  return CHANNEL_POLICIES[channelId].notification.deliveryEnabled;
}

/** Returns the conversation strategy for the given channel. */
export function getConversationStrategy(
  channelId: ChannelId,
): ConversationStrategy {
  return CHANNEL_POLICIES[channelId].notification.conversationStrategy;
}

/** Returns the invite policy for the given channel. */
export function getChannelInvitePolicy(
  channelId: ChannelId,
): ChannelInvitePolicy {
  return CHANNEL_POLICIES[channelId].invite;
}

/** Whether invite code redemption is enabled for the given channel. */
export function isInviteCodeRedemptionEnabled(channelId: ChannelId): boolean {
  return CHANNEL_POLICIES[channelId].invite.codeRedemptionEnabled;
}
