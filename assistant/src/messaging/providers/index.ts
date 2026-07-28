/**
 * Direct channel delivery — bypasses the gateway HTTP proxy.
 *
 * Each channel exposes a `ChannelTransport`; the callback-URL → channel mapping
 * lives in `callback-routing.ts`. The gateway-client consults
 * `isDirectDelivery()` before falling back to the HTTP proxy path.
 *
 * Supported: Slack, Telegram, WhatsApp, A2A.
 */

import type {
  ChannelDeliveryResult,
  ChannelReplyPayload,
} from "@vellumai/gateway-client";

import { a2aTransport } from "./a2a/transport.js";
import type { DirectDeliveryChannel } from "./callback-routing.js";
import { channelForCallback } from "./callback-routing.js";
import type { CallbackContext, ChannelTransport } from "./channel-transport.js";
import { slackTransport } from "./slack/transport.js";
import { telegramTransport } from "./telegram-bot/transport.js";
import { whatsappTransport } from "./whatsapp/transport.js";

// Keyed by `DirectDeliveryChannel` so the type checker enforces that the
// registered transports cover exactly the channels `callback-routing` resolves:
// add a channel to that set and this object fails to compile until its transport
// is registered here (and vice versa). No second list to drift against.
const TRANSPORTS: Record<DirectDeliveryChannel, ChannelTransport> = {
  slack: slackTransport,
  telegram: telegramTransport,
  whatsapp: whatsappTransport,
  a2a: a2aTransport,
};

/**
 * Resolve the transport that owns a gateway callback URL, or `undefined` when
 * no channel delivers it directly.
 */
export function getTransportForCallback(
  callbackUrl: string,
): ChannelTransport | undefined {
  const channel = channelForCallback(callbackUrl);
  return channel ? TRANSPORTS[channel] : undefined;
}

function callbackContext(callbackUrl: string): CallbackContext {
  const params: Record<string, string> = {};
  try {
    // Resolve against a dummy base so base-less callbacks (e.g.
    // `/deliver/slack?threadTs=…`) still expose their params. `channelForCallback`
    // already routes those as direct delivery, so dispatch must not drop
    // threadTs/taskId for them.
    const url = new URL(callbackUrl, "http://callback.invalid");
    for (const [key, value] of url.searchParams) {
      params[key] = value;
    }
  } catch {
    // Unparseable callback URL — deliver with no params.
  }
  return { callbackUrl, params };
}

/**
 * True when the callback URL targets a channel whose outbound delivery the
 * assistant handles directly (no gateway hop).
 */
export function isDirectDelivery(callbackUrl: string): boolean {
  return getTransportForCallback(callbackUrl) !== undefined;
}

/**
 * Deliver a channel reply directly to the provider API, bypassing the gateway
 * HTTP proxy. Callers MUST check `isDirectDelivery()` first.
 *
 * Sub-operations (reaction, thread status, typing) route to the transport's
 * optional method when both the payload field and the method are present;
 * otherwise the reply is delivered as text / approval / attachments.
 */
export async function deliverDirect(
  callbackUrl: string,
  payload: ChannelReplyPayload,
): Promise<ChannelDeliveryResult> {
  const transport = getTransportForCallback(callbackUrl);
  if (!transport) {
    throw new Error(
      `deliverDirect called for unsupported callback: ${callbackUrl}`,
    );
  }

  const ctx = callbackContext(callbackUrl);
  if (payload.slackStream && transport.streamReply) {
    return transport.streamReply(ctx, payload);
  }
  if (payload.reaction && transport.sendReaction) {
    return transport.sendReaction(ctx, payload);
  }
  if (payload.assistantThreadStatus && transport.setThreadStatus) {
    return transport.setThreadStatus(ctx, payload);
  }
  if (payload.chatAction === "typing" && transport.sendTyping) {
    return transport.sendTyping(ctx, payload);
  }
  return transport.deliver(ctx, payload);
}
