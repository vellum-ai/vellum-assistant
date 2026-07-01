/**
 * Shared per-actor trust verdict carried on the gateway→runtime wire.
 *
 * The gateway resolves this verdict from its ACL DB and stamps it onto the
 * inbound payload's `sourceMetadata`; the runtime consumes it. Keeping the
 * type here avoids the runtime importing from `gateway/src` and lets the
 * daemon's `trustClass` union (`actor-trust-resolver.ts`) converge on this
 * one source of truth.
 *
 * This contract carries ACL + identity keys + minimal labels only — never
 * info fields (notes, userFile, contactType). `status` / `policy` / `type`
 * stay loose `z.string()` to match the gateway schema columns and avoid
 * coupling to a still-evolving status vocabulary; the consumer interprets
 * them.
 */

import { z } from "zod";

/**
 * Verification-purpose trust classification. Mirrors the daemon's
 * `TrustClass` union (`actor-trust-resolver.ts`), ordered most- to
 * least-trusted.
 */
export const TRUST_CLASS_VALUES = [
  "guardian",
  "trusted_contact",
  "unverified_contact",
  "unknown",
] as const;

export const TrustClassSchema = z.enum(TRUST_CLASS_VALUES);

export type TrustClass = (typeof TRUST_CLASS_VALUES)[number];

const TRUST_CLASS_SET: ReadonlySet<string> = new Set(TRUST_CLASS_VALUES);

/**
 * Type guard for wire-sourced trust classes. Consumers receive verdicts over
 * IPC/HTTP, so a field statically typed {@link TrustClass} can still carry an
 * out-of-contract value (version skew, malformed payload); this narrows it
 * safely without casting.
 */
export function isTrustClass(value: string): value is TrustClass {
  return TRUST_CLASS_SET.has(value);
}

/**
 * Per-actor trust verdict resolved by the gateway from its ACL DB. ACL +
 * identity keys + minimal labels only. Guardian binding and member
 * identity/ACL fields are optional — present only when the corresponding
 * record resolves.
 */
export const TrustVerdictSchema = z.object({
  trustClass: TrustClassSchema,
  canonicalSenderId: z.string().nullable(),

  // Present+true ⇒ gateway attempted resolution but failed (DB error);
  // consumer treats it as "could not vouch", distinct from a real `unknown`
  // stranger.
  resolutionFailed: z.boolean().optional(),

  // Guardian binding — present only when a guardian binding matches.
  guardianExternalUserId: z.string().optional(),
  guardianDeliveryChatId: z.string().nullable().optional(),
  guardianPrincipalId: z.string().optional(),
  guardianDisplayName: z.string().optional(),

  // Member identity + ACL — present only when a member channel resolves.
  contactId: z.string().optional(),
  channelId: z.string().optional(),
  type: z.string().optional(),
  address: z.string().optional(),
  externalChatId: z.string().nullable().optional(),
  status: z.string().optional(),
  policy: z.string().optional(),
  verifiedAt: z.number().nullable().optional(),
  verifiedVia: z.string().nullable().optional(),
  memberDisplayName: z.string().optional(),
});

export type TrustVerdict = z.infer<typeof TrustVerdictSchema>;

/**
 * Sentinel for a gateway resolver failure; consumers treat it as
 * could-not-vouch (distinct from a real `unknown` stranger). Takes the
 * already-canonicalized sender id so this module stays free of the gateway's
 * canonicalization util.
 */
export function makeResolutionFailedVerdict(
  canonicalSenderId: string | null,
): TrustVerdict {
  return { trustClass: "unknown", canonicalSenderId, resolutionFailed: true };
}

/**
 * IPC request for `resolve_inbound_trust`. Per-actor identity keys the
 * gateway resolver needs to classify the inbound sender. The response reuses
 * {@link TrustVerdictSchema}.
 */
export const ResolveInboundTrustRequestSchema = z.object({
  channelType: z.string().min(1),
  actorExternalId: z.string().optional(),
});

export type ResolveInboundTrustRequest = z.infer<
  typeof ResolveInboundTrustRequestSchema
>;
