/**
 * Channel envelope v1.
 *
 * One inbound event, carrying everything a consumer needs to route it, attribute
 * it, and decide whether it is allowed in:
 *
 * - `address`: which conversation or thread it belongs to. Adapter and
 *   credential resolution derive from this.
 * - `actor`: who sent it. Trust and guardian decisions key on this and never on
 *   the address.
 * - `kind`: what happened, so a consumer can dispatch without re-sniffing the
 *   payload.
 * - `content`: references to the message body and its attachments, by id. The
 *   envelope carries pointers, not bytes.
 * - `gatewayAuthority`: what the gateway attests. The gateway is the single
 *   ingress, so it is the only party that can resolve a trust verdict or apply
 *   an admission floor. Consumers read this block; they never synthesize it.
 *
 * The schemas are the contract, not the TypeScript types: two deployments can
 * run different builds, so an envelope is validated on arrival rather than
 * trusted because the sender's types said so.
 */

import { z } from "zod";

import { ChannelActorSchema } from "./channel-actor.js";
import { ChannelAddressSchema } from "./channel-address.js";

export const CHANNEL_ENVELOPE_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Event kind
// ---------------------------------------------------------------------------

/**
 * The event families the gateway normalizes today, one per normalizer:
 * `message-normalizer`, `message-change-normalizer` (edit and delete),
 * `reaction-normalizer`, and `block-actions-normalizer`.
 */
export const CHANNEL_EVENT_KINDS = [
  "message",
  "message_edit",
  "message_delete",
  "reaction",
  "action",
] as const;

export type ChannelEventKind = (typeof CHANNEL_EVENT_KINDS)[number];

export const ChannelEventKindSchema = z.enum(CHANNEL_EVENT_KINDS);

// ---------------------------------------------------------------------------
// Content references
// ---------------------------------------------------------------------------

/**
 * Pointers to the event's content. Bodies and blobs are fetched by id rather
 * than inlined, so an envelope stays a routing and attribution record and does
 * not become a copy of the message.
 */
export const ChannelContentRefsSchema = z.strictObject({
  /** Provider message id this event is about. */
  externalMessageId: z.string().min(1).max(512),
  /** Attachment ids the ingress pipeline registered, in provider order. */
  attachmentIds: z.array(z.string().min(1).max(512)).max(64).optional(),
});

export type ChannelContentRefs = z.infer<typeof ChannelContentRefsSchema>;

// ---------------------------------------------------------------------------
// Gateway-owned authority
// ---------------------------------------------------------------------------

/**
 * Verification-purpose trust classification, ordered most to least trusted.
 *
 * The gateway's richer per-actor verdict record lives in
 * `@vellumai/gateway-client`, which depends on this package, so the envelope
 * cannot reference it without inverting the layering. The decision-bearing core
 * is hoisted here instead, which is where shared vocabulary belongs. The copies
 * in `gateway-client` and in the daemon's `actor-trust-resolver` should be
 * converged onto these values in a follow-up so there is one source of truth
 * rather than three.
 */
export const TRUST_CLASS_VALUES = [
  "guardian",
  "trusted_contact",
  "unverified_contact",
  "unknown",
] as const;

export type TrustClass = (typeof TRUST_CLASS_VALUES)[number];

export const TrustClassSchema = z.enum(TRUST_CLASS_VALUES);

/** Per-channel inbound admission policy, most restrictive to most permissive. */
export const ADMISSION_POLICY_VALUES = [
  "no_one",
  "guardian_only",
  "trusted_contacts",
  "any_contact",
  "strangers",
] as const;

export type AdmissionPolicy = (typeof ADMISSION_POLICY_VALUES)[number];

export const AdmissionPolicySchema = z.enum(ADMISSION_POLICY_VALUES);

/**
 * The gateway's verdict on who the actor is. `resolutionFailed` distinguishes
 * "the gateway tried and could not vouch" from a real `unknown` stranger, so a
 * consumer never reads a transport failure as a trust decision.
 */
export const TrustVerdictSchema = z.strictObject({
  trustClass: TrustClassSchema,
  /** The actor's canonicalized identity, or null when none resolved. */
  canonicalSenderId: z.string().max(512).nullable(),
  resolutionFailed: z.boolean().optional(),
});

export type TrustVerdict = z.infer<typeof TrustVerdictSchema>;

/**
 * The admission floor in force for this channel and the outcome of applying it.
 * Both are stamped: the policy alone does not say what happened, and `admitted`
 * alone does not say what it was measured against.
 */
export const AdmissionStampSchema = z.strictObject({
  policy: AdmissionPolicySchema,
  admitted: z.boolean(),
  /**
   * True for channels the floor never applies to (`platform`, `a2a`), where
   * `admitted` is a short circuit rather than a rank comparison.
   */
  exempt: z.boolean().optional(),
});

export type AdmissionStamp = z.infer<typeof AdmissionStampSchema>;

/**
 * Facts only the gateway can state. `stampedBy` is a constant rather than a
 * free string so an envelope assembled anywhere else fails validation instead
 * of passing as gateway-attested.
 */
export const GatewayAuthoritySchema = z.strictObject({
  stampedBy: z.literal("gateway"),
  /** Gateway-minted id for this ingress, unique per received message. */
  ingressId: z.string().min(1).max(256),
  /**
   * Gateway wall clock at receipt, ISO 8601 UTC. Never a provider-supplied
   * timestamp: receipt time is the fact the gateway can actually attest to.
   */
  receivedAt: z.iso.datetime(),
  trustVerdict: TrustVerdictSchema,
  admission: AdmissionStampSchema,
});

export type GatewayAuthority = z.infer<typeof GatewayAuthoritySchema>;

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export const ChannelEnvelopeV1Schema = z.strictObject({
  v: z.literal(CHANNEL_ENVELOPE_VERSION),
  address: ChannelAddressSchema,
  kind: ChannelEventKindSchema,
  actor: ChannelActorSchema,
  content: ChannelContentRefsSchema,
  gatewayAuthority: GatewayAuthoritySchema,
});

export type ChannelEnvelopeV1 = z.infer<typeof ChannelEnvelopeV1Schema>;

/**
 * Reject an envelope whose address and actor disagree about which channel they
 * belong to. Each is independently valid, so only a cross-field check catches a
 * Slack conversation carrying a Telegram sender.
 */
export const ChannelEnvelopeV1ConsistentSchema = ChannelEnvelopeV1Schema.refine(
  (envelope) => envelope.address.channel === envelope.actor.channel,
  { message: "address and actor must be on the same channel", path: ["actor"] },
);

/**
 * The envelope carrying a payload, for consumers that want address, actor, and
 * authority validated in the same pass as their own body schema.
 */
export function channelEnvelopeV1<Payload extends z.ZodType>(payload: Payload) {
  return ChannelEnvelopeV1Schema.extend({ payload });
}
