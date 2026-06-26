import type { ChannelId } from "../../channels/types.js";

/**
 * Channels whose outbound replies the assistant delivers directly to the
 * provider API, bypassing the gateway HTTP proxy. Each is reached at the gateway
 * callback path `/deliver/<channel>`.
 *
 * This is the single source of truth for that set and that mapping — shared by
 * the delivery transports (`messaging/providers`) and any caller that needs to
 * resolve a callback URL back to its channel WITHOUT loading the transport
 * implementations (and their provider-API send code). Keep it dependency-light.
 */
const DIRECT_DELIVERY_CHANNELS = [
  "slack",
  "telegram",
  "whatsapp",
  "a2a",
] as const satisfies readonly ChannelId[];

export type DirectDeliveryChannel = (typeof DIRECT_DELIVERY_CHANNELS)[number];

const CALLBACK_PREFIX = "/deliver/";

/**
 * Resolve a gateway callback URL to the direct-delivery channel that owns it, or
 * `undefined` when no channel delivers it directly. Gateway callbacks are always
 * absolute URLs; an unparseable (e.g. base-less) callback is treated as not
 * directly delivered and falls through to the gateway HTTP proxy.
 */
export function channelForCallback(
  callbackUrl: string,
): DirectDeliveryChannel | undefined {
  let pathname: string;
  try {
    pathname = new URL(callbackUrl).pathname;
  } catch {
    return undefined;
  }
  if (!pathname.startsWith(CALLBACK_PREFIX)) return undefined;
  const channel = pathname.slice(CALLBACK_PREFIX.length);
  return (DIRECT_DELIVERY_CHANNELS as readonly string[]).includes(channel)
    ? (channel as DirectDeliveryChannel)
    : undefined;
}
