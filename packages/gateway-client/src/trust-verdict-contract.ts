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

import { AdmissionPolicySchema } from "./admission-policy-contract.js";

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

  // Present+true ⇒ gateway attempted resolution but could not produce a
  // usable verdict (DB error, or a sender who maps to the guardian contact
  // whose principal is unresolved); consumer treats it as "could not vouch",
  // distinct from a real `unknown` stranger.
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
  memberDisplayName: z.string().optional(),

  // Gateway-owned interaction telemetry (a trust signal, not an info field per
  // the 2×2) — carried straight off the member `contact_channels` row.
  // Present only when a member channel resolves; absent for unknown senders.
  interactionCount: z.number().optional(),

  // CHANNEL-scoped session-presence stamp: true ⇒ an interceptable
  // (pending | pending_bootstrap | awaiting_response), non-expired
  // verification session existed for this channel at resolution time.
  // Not sender-scoped, so consumers may treat only `false` as authoritative
  // (safe to skip session reads before minting a challenge); on true/absent
  // they fall back to session reads for sender-scoped dedup.
  hasInterceptableVerificationSession: z.boolean().optional(),
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
 * Downgraded verdict for an inbound sender whose channel identity could not be
 * authenticated — e.g. an email whose `From:` failed SPF/DKIM/DMARC and so
 * carries a spoofable address. A spoofable sender must never inherit
 * guardian/trusted_contact trust from a matching address, so it is reduced to
 * a plain `unknown` stranger: guardian and member/ACL fields are dropped so no
 * residual trust is reconstructed downstream. Unlike
 * {@link makeResolutionFailedVerdict} this is NOT `resolutionFailed` — the
 * sender is a real stranger and should flow through the normal admission floor
 * + verification lane, not the could-not-vouch soft-deny.
 */
export function makeUnauthenticatedSenderVerdict(
  canonicalSenderId: string | null,
): TrustVerdict {
  return { trustClass: "unknown", canonicalSenderId };
}

/**
 * IPC request for `resolve_inbound_trust`. Per-actor identity keys the
 * gateway resolver needs to classify the inbound sender.
 */
export const ResolveInboundTrustRequestSchema = z.object({
  channelType: z.string().min(1),
  actorExternalId: z.string().optional(),
});

export type ResolveInboundTrustRequest = z.infer<
  typeof ResolveInboundTrustRequestSchema
>;

/**
 * IPC response for `resolve_inbound_trust`. The channel admission policy is
 * an ENVELOPE field, not a {@link TrustVerdictSchema} field: the verdict is
 * also stamped on every text relay's `sourceMetadata`, which must not carry
 * this voice-setup-only companion. `admissionPolicy: null` is the gateway's
 * explicit "no enforcement configured" answer (an admit). The key is nullish
 * for version skew: a pre-envelope gateway answers `{ verdict }` only, and a
 * valid verdict must not be discarded over the missing companion — the
 * consumer falls back to the standalone admission-policy read.
 */
export const ResolveInboundTrustResponseSchema = z.object({
  verdict: TrustVerdictSchema,
  admissionPolicy: AdmissionPolicySchema.nullish(),
});

export type ResolveInboundTrustResponse = z.infer<
  typeof ResolveInboundTrustResponseSchema
>;
