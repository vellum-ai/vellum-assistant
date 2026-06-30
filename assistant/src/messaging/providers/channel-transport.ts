import type {
  ChannelDeliveryResult,
  ChannelReplyPayload,
} from "@vellumai/gateway-client";

import type { ChannelId } from "../../channels/types.js";

/**
 * Per-channel state carried on the gateway callback URL (e.g. Slack `threadTs`,
 * A2A `taskId`). The dispatcher parses the URL once; each transport reads only
 * the params it needs.
 */
export interface CallbackContext {
  readonly callbackUrl: string;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * Direct outbound delivery for one channel, wrapping the channel's provider-API
 * send functions behind a uniform surface. Transports are registered statically
 * (delivery runs in non-daemon contexts) and dispatched by channel, resolved
 * from the gateway callback URL via `callback-routing.ts`.
 *
 * The dispatcher routes a payload to the optional sub-operation methods when the
 * matching payload field is set and the method exists; otherwise it calls
 * `deliver`. A transport only implements the sub-operations it supports.
 */
export interface ChannelTransport {
  /** Canonical source channel id, e.g. `"slack"`. */
  readonly channel: ChannelId;

  /** Deliver a rendered reply (text / approval / attachments). */
  deliver(
    ctx: CallbackContext,
    payload: ChannelReplyPayload,
  ): Promise<ChannelDeliveryResult>;

  /** Send a typing indicator. Routed when `payload.chatAction === "typing"`. */
  sendTyping?(
    ctx: CallbackContext,
    payload: ChannelReplyPayload,
  ): Promise<ChannelDeliveryResult>;

  /** Add an emoji reaction. Routed when `payload.reaction` is set. */
  sendReaction?(
    ctx: CallbackContext,
    payload: ChannelReplyPayload,
  ): Promise<ChannelDeliveryResult>;

  /** Update an assistant-thread status surface. Routed when `payload.assistantThreadStatus` is set. */
  setThreadStatus?(
    ctx: CallbackContext,
    payload: ChannelReplyPayload,
  ): Promise<ChannelDeliveryResult>;

  /** Perform one streaming operation. Routed when `payload.slackStream` is set. */
  streamReply?(
    ctx: CallbackContext,
    payload: ChannelReplyPayload,
  ): Promise<ChannelDeliveryResult>;
}
