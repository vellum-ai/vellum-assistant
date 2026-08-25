/**
 * Direct channel delivery — bypasses the gateway HTTP proxy.
 *
 * Each channel exposes a `ChannelTransport`; the callback-URL → channel mapping
 * lives in `callback-routing.ts`. The gateway-client consults
 * `isDirectDelivery()` before falling back to the HTTP proxy path.
 *
 * Supported: Slack, Telegram, WhatsApp, A2A, Discord.
 */

import type {
  ChannelDeliveryResult,
  ChannelReplyPayload,
  StreamOp,
} from "@vellumai/gateway-client";

import { a2aTransport } from "./a2a/transport.js";
import type { DirectDeliveryChannel } from "./callback-routing.js";
import { channelForCallback } from "./callback-routing.js";
import type {
  ActivityTarget,
  CallbackContext,
  ChannelTransport,
  EditTarget,
} from "./channel-transport.js";
import { discordTransport } from "./discord/transport.js";
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
  discord: discordTransport,
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

/**
 * Whether the channel this callback addresses can show how busy the assistant
 * is.
 *
 * Asks the transport rather than the channel id, so a channel that gains the
 * method starts being asked without a caller being told about it.
 */
export function supportsChannelActivity(callbackUrl: string): boolean {
  return getTransportForCallback(callbackUrl)?.setActivity !== undefined;
}

/**
 * How often this channel's busy indicator has to be re-asserted, or
 * `undefined` when it holds until changed and one call is enough.
 */
export function channelActivityRefreshMs(
  callbackUrl: string,
): number | undefined {
  return getTransportForCallback(callbackUrl)?.activityRefreshMs;
}

/**
 * Show how busy the assistant is on the channel this callback addresses.
 *
 * Resolves to nothing when the channel has no such affordance, which is the
 * ordinary case rather than a failure: the indicator is decoration, and a
 * channel that cannot show one is not degraded by its absence.
 */
export async function setChannelActivity(
  callbackUrl: string,
  target: ActivityTarget,
): Promise<ChannelDeliveryResult> {
  const transport = getTransportForCallback(callbackUrl);
  if (!transport?.setActivity) {
    return { ok: true };
  }
  return transport.setActivity(callbackContext(callbackUrl), target);
}

/**
 * Replace a message the assistant already sent.
 *
 * Returns `ok` without acting when the channel cannot revise a sent message,
 * matching the other capability entry points: an absent method is an absent
 * capability, not an error.
 */
export async function editChannelMessage(
  callbackUrl: string,
  target: EditTarget,
): Promise<ChannelDeliveryResult> {
  const transport = getTransportForCallback(callbackUrl);
  if (!transport?.edit) {
    return { ok: true };
  }
  return transport.edit(callbackContext(callbackUrl), target);
}

/**
 * Advance a streamed reply on the channel this callback addresses.
 *
 * Resolves to nothing when the channel cannot stream, so a caller that wants a
 * streamed reply learns it has to send the whole thing instead.
 */
export async function sendChannelStreamOp(
  callbackUrl: string,
  chatId: string,
  op: StreamOp,
): Promise<ChannelDeliveryResult> {
  const transport = getTransportForCallback(callbackUrl);
  if (!transport?.streamReply) {
    return { ok: true };
  }
  return transport.streamReply(callbackContext(callbackUrl), chatId, op);
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
 * Delivers the reply itself: text, approval card, attachments. Every other
 * operation a transport supports is reached through its own entry point.
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
  return transport.deliver(ctx, payload);
}
