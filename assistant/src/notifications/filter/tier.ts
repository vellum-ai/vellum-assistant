/**
 * Attention tier: how much of the user's attention a notification is allowed
 * to claim.
 *
 * - `suppress`  do not surface at all
 * - `hint`      delivered, but claims no attention (inbox entry, no banner)
 * - `offer`     surfaces with a claim on attention, not urgent
 * - `response`  urgent, breaks through
 *
 * `Urgency` stays the transport every channel adapter already understands.
 * `tierToUrgency` is the one place the two scales are related, and
 * `resolveSilent` is the one place a delivery's banner decision is made from
 * whichever scale the signal carries.
 */

import { z } from "zod";

import type { Urgency } from "../urgency.js";

/** Declared least to most interrupting; `TIER_ORDER` depends on that order. */
export const TierSchema = z.enum(["suppress", "hint", "offer", "response"]);
export type Tier = z.infer<typeof TierSchema>;

/** Tiers ordered least to most interrupting. */
export const TIER_ORDER: readonly Tier[] = TierSchema.options;

/** Negative, zero, or positive as `a` is less, equally, or more interrupting than `b`. */
export function compareTier(a: Tier, b: Tier): number {
  return TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b);
}

const TIER_URGENCY: Record<Tier, Urgency> = {
  suppress: "low",
  hint: "low",
  offer: "high",
  response: "critical",
};

/** The urgency a tier travels as once it reaches a channel adapter. */
export function tierToUrgency(tier: Tier): Urgency {
  return TIER_URGENCY[tier];
}

/** False only for `suppress`; every other tier is delivered. */
export function tierShouldNotify(tier: Tier): boolean {
  return tier !== "suppress";
}

/** Tiers allowed to claim attention with a banner once they are delivered. */
const TIER_CLAIMS_ATTENTION: Record<Tier, boolean> = {
  suppress: false,
  hint: false,
  offer: true,
  response: true,
};

/**
 * Whether a delivery must stay silent: the inbox entry still appears, the OS
 * banner does not. Tier decides when the filter path set one; otherwise the
 * urgency scale does, so producers that never reach the filter deliver
 * exactly as they did before Tier existed.
 *
 * This is the single definition of that decision. The vellum adapter's
 * `notification_intent` and the broadcaster's
 * `notification_conversation_created` both read it, so a paired delivery can
 * never emit two contradictory banner instructions.
 */
export function resolveSilent(
  tier: Tier | undefined,
  urgency: Urgency,
): boolean {
  if (tier) {
    return !TIER_CLAIMS_ATTENTION[tier];
  }
  return urgency !== "high" && urgency !== "critical";
}

/**
 * Tier to use when the judgment layer produced nothing usable. The fail-safe
 * policy is to file quietly: a broken judgment layer must never silently drop
 * a notification, and must never interrupt.
 */
export const FALLBACK_TIER: Tier = "hint";
