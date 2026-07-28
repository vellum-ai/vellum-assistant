/**
 * What the Memory tab says when the concept graph can't be drawn, and the seed
 * for the chat that fixes it.
 *
 * The graph builds off the memory-v3 concept-page substrate, so `GET
 * /memory-graph` answers `supported: false` for every assistant that isn't on
 * the v3 tier. That is not one situation but two, with two different fixes: the
 * owner switched Memory off (Settings), or the assistant is still on a legacy
 * engine (migrate to v3). `GET /memory/stats` reports which via `tier`.
 *
 * Pure, so the copy-per-tier decision is testable without a router or a query
 * client — the component in `memory-upgrade-prompt.tsx` only renders it.
 */

import type { MemoryTier } from "@/domains/intelligence/memory-graph/get-memory-stats";

/**
 * Seeds the upgrade chat. Deliberately states the goal and not a procedure: the
 * right migration depends on whether the concept corpus is empty (backfill) or
 * populated (a staged reform), which the assistant can determine and this
 * surface cannot. Asking for confirmation before the rewrite is part of the
 * ask, since the corpus is not regenerable.
 */
export const MEMORY_V3_UPGRADE_PROMPT =
  "Upgrade my memory to v3 so the memory graph works. Check whether your " +
  "concept corpus is empty or already populated first, then run the migration " +
  "that fits — and tell me what you're about to change before you rewrite " +
  "anything you remember.";

/** Which way out this surface offers, if any. */
export type MemoryUnavailableAction = "upgrade" | "settings" | "none";

export interface MemoryUnavailableCopy {
  title: string;
  detail: string;
  action: MemoryUnavailableAction;
}

/**
 * Tier → what to say about the missing graph.
 *
 * `undefined` covers daemons predating the `tier` field, and `"v3"` covers the
 * contradiction where stats claims the v3 tier but the graph route reports no
 * support (a daemon mid-upgrade). Both get neutral copy and no CTA: naming a
 * fix we aren't sure applies is worse than naming none.
 */
export function describeMemoryUnavailable(
  tier: MemoryTier | undefined,
): MemoryUnavailableCopy {
  if (tier === "off") {
    return {
      title: "Memory is turned off",
      detail:
        "Your assistant isn't keeping anything from your conversations, so there's no map to draw. Turn Memory back on and it starts building one.",
      action: "settings",
    };
  }
  if (tier === "v1" || tier === "v2") {
    return {
      title: "Upgrade to memory v3",
      detail:
        "Your assistant is on an older memory engine. Memory v3 reorganizes what it knows into a linked wiki of concepts — and that wiki is what this map draws.",
      action: "upgrade",
    };
  }
  return {
    title: "Memory graph isn't available",
    detail:
      "This assistant's memory backend doesn't build a concept graph. Updating your assistant to the latest version moves it to memory v3.",
    action: "none",
  };
}
