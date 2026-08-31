/**
 * Attention tier: how much of the user's attention a notification is allowed
 * to claim.
 *
 * - `suppress`  do not surface at all
 * - `hint`      delivered, but claims no attention (inbox entry, no banner)
 * - `offer`     surfaces with a claim on attention, not urgent
 * - `response`  urgent, breaks through
 *
 * `Urgency` stays the transport every channel adapter already understands;
 * `tierToUrgency` is the one place the two scales are related.
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

/**
 * Tier to use when the judgment layer produced nothing usable. The fail-safe
 * policy is to file quietly: a broken judgment layer must never silently drop
 * a notification, and must never interrupt.
 */
export const FALLBACK_TIER: Tier = "hint";
