/**
 * Shared binding-strength vocabulary for the contact channel `verified_via`
 * provenance column.
 *
 * Two distinct notions live here, both keyed on the free-text `verified_via`
 * audit value:
 *
 *  1. The 3-tier *display* ladder (`BindingStrength` +
 *     `bindingStrengthForVerifiedVia`) the introduction card renders from. It
 *     covers only the three introduction-card provenances and returns `null`
 *     for everything else — the card UI depends on that exact shape.
 *
 *  2. The *enforcement* order (`knownStrengthRank` + `isBindingDemotion`) the
 *     gateway ACL write path uses to refuse demotions (LUM-2505): a total,
 *     conservative ranking over every real `verified_via` value, so a
 *     lower-strength source can never silently overwrite a higher-strength
 *     active binding.
 *
 * This lives in the shared package — not `assistant/` — because the gateway
 * owns the contact ACL and is where the demotion guard runs. The assistant
 * re-exports the display helpers from `runtime/introduction-policy.ts`, so its
 * card/provenance call sites are unchanged.
 *
 * No import from `assistant/` or `gateway/`: pure vocabulary.
 */

// ---------------------------------------------------------------------------
// verified_via constants
// ---------------------------------------------------------------------------

/** `verified_via` written by the gateway when a verification code is redeemed. */
export const VERIFIED_VIA_CHALLENGE = "challenge";

/** `verified_via` written when the guardian direct-trusts a workspace-vouched identity. */
export const VERIFIED_VIA_MANUAL = "manual";

/** `verified_via` written when the guardian trusts an identity the platform is not vouching for. */
export const VERIFIED_VIA_CHANNEL_CLAIM = "manual_channel_claim";

// ---------------------------------------------------------------------------
// Display ladder (introduction card)
// ---------------------------------------------------------------------------

/**
 * Binding-strength ladder the introduction card renders:
 *
 *   verified_handshake > internal_workspace_match > inbound_channel_claim
 *
 * - `verified_handshake` — the contact proved control of the channel by
 *   returning a verification code (`verified_via: "challenge"`).
 * - `internal_workspace_match` — the platform authenticated the identity inside
 *   the guardian's own workspace; the guardian vouches directly
 *   (`verified_via: "manual"`).
 * - `inbound_channel_claim` — the guardian trusts an identity the platform is
 *   NOT vouching for (`verified_via: "manual_channel_claim"`).
 */
export type BindingStrength =
  | "verified_handshake"
  | "internal_workspace_match"
  | "inbound_channel_claim";

/**
 * Derive the display binding strength for a `verified_via`. Returns `null` for
 * provenance outside the introduction ladder (e.g. `invite`, `bootstrap`),
 * which predate it and keep their own audit meaning — the introduction card UI
 * relies on this exact shape.
 *
 * This is the DISPLAY ladder, not the enforcement order: use
 * {@link knownStrengthRank} / {@link isBindingDemotion} for the demotion guard.
 */
export function bindingStrengthForVerifiedVia(
  verifiedVia: string | null | undefined,
): BindingStrength | null {
  switch (verifiedVia) {
    case VERIFIED_VIA_CHALLENGE:
      return "verified_handshake";
    case VERIFIED_VIA_MANUAL:
      return "internal_workspace_match";
    case VERIFIED_VIA_CHANNEL_CLAIM:
      return "inbound_channel_claim";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Enforcement order (demotion guard — LUM-2505)
// ---------------------------------------------------------------------------

/**
 * `verified_via` values where the actor demonstrably controls the channel (a
 * code/token/possession proof) or the binding is a guardian binding (bootstrap
 * or platform/webhook auto-registration). They share the top enforcement rank:
 * none may be silently demoted, and a lateral swap between them is not a
 * demotion. Every real production writer of `verified_via` that outranks
 * `manual` must appear here, or the demotion guard would treat it as unknown
 * (incomparable) and let a `manual` re-attest quietly demote it.
 */
const PROVEN_VERIFIED_VIA: ReadonlySet<string> = new Set([
  VERIFIED_VIA_CHALLENGE, // returned a verification code
  "invite", // redeemed an invite code / token
  "voice", // returned a voice (DTMF) code
  "bootstrap", // guardian binding (also protected by the guardian-downgrade guard)
  "platform_auto_register", // guardian binding auto-registered by the platform
  "webhook_registration", // guardian binding registered via a provider webhook
]);

/**
 * Total, conservative strength rank for a `verified_via`, used by the gateway
 * ACL write path to refuse demotions. Higher = stronger. Grouped into coarse
 * tiers that hold under ANY intra-tier ordering the pending Slack-permissions
 * PRD (D4) may land on:
 *
 *   3  proven / possession — {@link PROVEN_VERIFIED_VIA}.
 *   2  workspace-vouched — the platform authenticated the identity but the
 *      actor did not actively prove control here (`manual`).
 *   1  inbound channel claim — nobody vouches; the guardian trusted an
 *      unproven claim (`manual_channel_claim`).
 *   0  unverified — no verification at all (`null` / empty).
 *
 * Returns `null` for an unrecognized non-empty provenance ("unknown"). The
 * demotion guard treats unknown as incomparable and never refuses on it, so a
 * forward-compatible new `verified_via` value is never mistaken for a demotion.
 */
export function knownStrengthRank(
  verifiedVia: string | null | undefined,
): number | null {
  if (verifiedVia == null || verifiedVia === "") return 0;
  if (PROVEN_VERIFIED_VIA.has(verifiedVia)) return 3;
  if (verifiedVia === VERIFIED_VIA_MANUAL) return 2;
  if (verifiedVia === VERIFIED_VIA_CHANNEL_CLAIM) return 1;
  return null;
}

/**
 * Whether writing `incomingVia` over an existing `existingVia` binding would
 * LOWER its strength — the demotion the gateway ACL write path refuses
 * (LUM-2505).
 *
 * True only when BOTH provenances are known and the incoming rank is strictly
 * lower than the existing. Unknown provenance on either side is incomparable
 * and never counts as a demotion (fail-open), so the guard blocks only provable
 * downgrades and never breaks a new/unrecognized `verified_via`. Equal ranks
 * (including lateral swaps within the proven tier) and upgrades are not
 * demotions.
 */
export function isBindingDemotion(
  existingVia: string | null | undefined,
  incomingVia: string | null | undefined,
): boolean {
  const existing = knownStrengthRank(existingVia);
  const incoming = knownStrengthRank(incomingVia);
  if (existing == null || incoming == null) return false;
  return incoming < existing;
}
