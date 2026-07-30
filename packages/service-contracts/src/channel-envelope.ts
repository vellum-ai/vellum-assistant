/**
 * Channel envelope v1.
 *
 * The envelope is where the two halves of the channel contract sit side by side
 * so the difference between them is structural rather than a convention someone
 * has to remember:
 *
 * - `actor` is a {@link ChannelAddress}: durable identity, safe to store, safe
 *   to compare, safe to key a contact or a trust decision on.
 * - `route` is delivery routing: the conversation the message arrived in and the
 *   callback URL a reply goes back through. Both are reissued as transports move
 *   and neither identifies anyone, so nothing may key identity off them. In
 *   particular `replyCallbackUrl` lives here and only here; it is a capability to
 *   deliver, not a name.
 * - `authority` is gateway-owned. The gateway is the single ingress, so it is the
 *   only party that can attest when a message was received and under which
 *   ingress it arrived. Consumers read this block; they never synthesize it, and
 *   a producer other than the gateway cannot fill it in truthfully.
 *
 * The schemas are the contract, not the TypeScript types: two deployments can
 * run different builds, so an envelope is validated on arrival rather than
 * trusted because the sender's types said so.
 */

import { z } from "zod";

import { ChannelAddressSchema } from "./channel-address.js";

export const CHANNEL_ENVELOPE_VERSION = "v1" as const;

// ---------------------------------------------------------------------------
// Gateway-owned authority
// ---------------------------------------------------------------------------

/**
 * Facts only the gateway can state. `stampedBy` is a constant rather than a
 * free string so an envelope assembled anywhere else fails validation instead
 * of passing as gateway-attested.
 */
export const ChannelAuthoritySchema = z.strictObject({
  stampedBy: z.literal("gateway"),
  /** Gateway-minted id for this ingress, unique per received message. */
  ingressId: z.string().min(1).max(256),
  /**
   * Gateway wall clock at receipt, ISO 8601 UTC. Never a provider-supplied
   * timestamp: receipt time is the fact the gateway can actually attest to.
   */
  receivedAt: z.iso.datetime(),
});

export type ChannelAuthority = z.infer<typeof ChannelAuthoritySchema>;

// ---------------------------------------------------------------------------
// Delivery routing
// ---------------------------------------------------------------------------

/**
 * Where a reply goes. Every field here is ephemeral by construction, which is
 * why none of them appear on {@link ChannelAddressSchema}.
 */
export const ChannelDeliveryRouteSchema = z.strictObject({
  /** Provider conversation address: Telegram chat id, Slack channel id, and so on. */
  conversationExternalId: z.string().min(1).max(512).optional(),
  /** Gateway callback the assistant posts a reply to. */
  replyCallbackUrl: z.url().max(2048).optional(),
});

export type ChannelDeliveryRoute = z.infer<typeof ChannelDeliveryRouteSchema>;

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export const ChannelEnvelopeV1Schema = z.strictObject({
  version: z.literal(CHANNEL_ENVELOPE_VERSION),
  /** Durable identity of the peer this envelope came from. */
  actor: ChannelAddressSchema,
  /** Delivery routing, absent on envelopes that are not replied to. */
  route: ChannelDeliveryRouteSchema.optional(),
  authority: ChannelAuthoritySchema,
});

export type ChannelEnvelopeV1 = z.infer<typeof ChannelEnvelopeV1Schema>;

/**
 * The envelope carrying a payload, for consumers that want identity, routing,
 * and authority validated in the same pass as their own body schema.
 */
export function channelEnvelopeV1<Payload extends z.ZodType>(payload: Payload) {
  return ChannelEnvelopeV1Schema.extend({ payload });
}
