/**
 * Static ROUTES array for channel endpoints.
 */
import { ACTOR_PRINCIPALS, GATEWAY_PRINCIPALS } from "../auth/route-policy.js";
import {
  handleChannelDeliveryAck,
  handleListDeadLetters,
  handleReplayDeadLetters,
} from "./channel-delivery-routes.js";
import {
  handleChannelInbound,
  handleDeleteConversation,
} from "./channel-inbound-routes.js";
import type { RouteDefinition } from "./types.js";

export const CHANNEL_ROUTES: RouteDefinition[] = [
  {
    operationId: "channel_delete_conversation",
    endpoint: "channels/conversation",
    method: "DELETE",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Delete channel conversation",
    description: "Delete a conversation by channel source.",
    tags: ["channels"],
    handler: handleDeleteConversation,
  },
  {
    operationId: "channel_inbound",
    endpoint: "channels/inbound",
    method: "POST",
    policy: {
      requiredScopes: ["ingress.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "Process inbound channel message",
    description: "Receive an inbound message from a channel integration.",
    tags: ["channels"],
    handler: handleChannelInbound,
  },
  {
    operationId: "channel_delivery_ack",
    endpoint: "channels/delivery-ack",
    method: "POST",
    policy: {
      requiredScopes: ["internal.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Acknowledge channel delivery",
    description: "Acknowledge delivery of a channel message.",
    tags: ["channels"],
    responseStatus: "204",
    handler: handleChannelDeliveryAck,
  },
  {
    operationId: "channel_dead_letters",
    endpoint: "channels/dead-letters",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List dead letters",
    description: "Return undeliverable channel messages.",
    tags: ["channels"],
    handler: handleListDeadLetters,
  },
  {
    operationId: "channel_replay_dead_letters",
    endpoint: "channels/replay",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Replay dead letters",
    description: "Retry delivery of dead-letter messages.",
    tags: ["channels"],
    handler: handleReplayDeadLetters,
  },
];
