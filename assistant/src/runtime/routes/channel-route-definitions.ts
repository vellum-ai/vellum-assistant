/**
 * Static ROUTES array for channel endpoints.
 */
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
    summary: "Delete channel conversation",
    description: "Delete a conversation by channel source.",
    tags: ["channels"],
    handler: handleDeleteConversation,
  },
  {
    operationId: "channel_inbound",
    endpoint: "channels/inbound",
    method: "POST",
    summary: "Process inbound channel message",
    description: "Receive an inbound message from a channel integration.",
    tags: ["channels"],
    handler: handleChannelInbound,
  },
  {
    operationId: "channel_delivery_ack",
    endpoint: "channels/delivery-ack",
    method: "POST",
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
    summary: "List dead letters",
    description: "Return undeliverable channel messages.",
    tags: ["channels"],
    handler: handleListDeadLetters,
  },
  {
    operationId: "channel_replay_dead_letters",
    endpoint: "channels/replay",
    method: "POST",
    summary: "Replay dead letters",
    description: "Retry delivery of dead-letter messages.",
    tags: ["channels"],
    handler: handleReplayDeadLetters,
  },
];
