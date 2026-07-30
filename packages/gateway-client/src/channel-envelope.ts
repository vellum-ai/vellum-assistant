/**
 * Channel envelope v1: one normalized inbound event on the gateway to daemon
 * wire.
 *
 * The envelope lives here rather than in `@vellumai/service-contracts` because
 * it is a gateway-to-daemon wire contract, which is what this package is for,
 * and because the authority block has to carry the *canonical* trust verdict
 * and admission policy. Those already live here. `service-contracts` sits below
 * this package, so an envelope defined down there could only reference a copy
 * of them, and a copy that is narrower than the real thing rejects real
 * traffic. Composing upward is the direction that has one definition of each.
 *
 * The split:
 *
 * - `service-contracts` owns the provider vocabulary: `ChannelAddress` (which
 *   conversation or thread), `ChannelActor` (who sent it), the capability
 *   annotations derived from them, and the event-kind and content-ref
 *   primitives, none of which know anything about trust.
 * - This module owns the assembly plus the gateway's own attestations.
 *
 * Field by field:
 *
 * - `address`: which conversation or thread. Adapter and credential resolution
 *   derive from this.
 * - `actor`: who sent it. Trust and guardian decisions key on this and never on
 *   the address.
 * - `kind`: what happened, so a consumer dispatches without re-sniffing.
 * - `content`: references to the body and attachments, by id.
 * - `gatewayAuthority`: what the gateway resolved. The gateway is the single
 *   ingress, so it is the only party positioned to resolve a trust verdict or
 *   apply an admission floor.
 */

import { ChannelActorSchema } from "@vellumai/service-contracts/channel-actor";
import { ChannelAddressSchema } from "@vellumai/service-contracts/channel-address";
import {
  ChannelContentRefsSchema,
  ChannelEventKindSchema,
} from "@vellumai/service-contracts/channel-event";
import { z } from "zod";

import { AdmissionPolicySchema } from "./admission-policy-contract.js";
import { TrustVerdictSchema } from "./trust-verdict-contract.js";

export const CHANNEL_ENVELOPE_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Gateway-owned authority
// ---------------------------------------------------------------------------

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
 * What the gateway resolved about this event.
 *
 * `trustVerdict` is the canonical {@link TrustVerdictSchema}, not a subset of
 * it: the gateway fills in the guardian and member blocks whenever those
 * records resolve, so anything narrower would reject a real guardian.
 *
 * On `stampedBy`: it is a literal, which catches an assembler that forgot to
 * fill the block in, and it documents at the type level who is supposed to
 * populate it. It is **not** an authenticity check. Any code that constructs an
 * envelope can write the literal, so this block is trustworthy only to the
 * extent that the transport carrying it is: the daemon accepts envelopes over
 * the internal gateway-to-runtime path, and the security boundary is that the
 * daemon is not reachable from the public internet, not this field. If a
 * deployment ever needs to accept envelopes from a party it does not already
 * trust, that requires a real signature over the block, not a constant.
 */
export const GatewayAuthoritySchema = z.strictObject({
  stampedBy: z.literal("gateway"),
  /** Gateway-minted id for this ingress, unique per received message. */
  ingressId: z.string().min(1).max(256),
  /**
   * Gateway wall clock at receipt, ISO 8601 UTC. Never a provider-supplied
   * timestamp: receipt time is the fact the gateway is positioned to record.
   */
  receivedAt: z.iso.datetime(),
  trustVerdict: TrustVerdictSchema,
  admission: AdmissionStampSchema,
});

export type GatewayAuthority = z.infer<typeof GatewayAuthoritySchema>;

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * The field set, before the cross-field check. Kept private: `.extend()` only
 * exists on a plain object schema, so the payload helper below needs this, but
 * nothing outside should be able to reach a version of the envelope that skips
 * the refinement.
 */
const ChannelEnvelopeV1Fields = z.strictObject({
  v: z.literal(CHANNEL_ENVELOPE_VERSION),
  address: ChannelAddressSchema,
  kind: ChannelEventKindSchema,
  actor: ChannelActorSchema,
  content: ChannelContentRefsSchema,
  gatewayAuthority: GatewayAuthoritySchema,
});

/**
 * Address and actor are validated by separate unions, so each half of a
 * mismatched pair is independently well-formed. Only a cross-field check
 * catches a Slack conversation carrying a Telegram sender.
 */
function addressAndActorAgree(envelope: {
  address: { channel: string };
  actor: { channel: string };
}): boolean {
  return envelope.address.channel === envelope.actor.channel;
}

const AGREEMENT_ISSUE = {
  message: "address and actor must be on the same channel",
  path: ["actor"],
};

export const ChannelEnvelopeV1Schema = ChannelEnvelopeV1Fields.refine(
  addressAndActorAgree,
  AGREEMENT_ISSUE,
);

export type ChannelEnvelopeV1 = z.infer<typeof ChannelEnvelopeV1Schema>;

/**
 * The envelope carrying a payload, for consumers that want address, actor, and
 * authority validated in the same pass as their own body schema.
 *
 * This applies the same cross-field check as {@link ChannelEnvelopeV1Schema}.
 * It is the path most consumers will reach for, so it must not be the loose
 * one.
 */
export function channelEnvelopeV1<Payload extends z.ZodType>(payload: Payload) {
  return ChannelEnvelopeV1Fields.extend({ payload }).refine(
    addressAndActorAgree,
    AGREEMENT_ISSUE,
  );
}
