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
  "that fits. Tell me what you're about to change before you rewrite anything " +
  "you remember.";

/**
 * Seeds the turn-memory-back-on chat. The Memory toggle lives on the Developer
 * page, which is gated behind the `settingsDeveloperNav` flag and redirects to
 * General Settings without it — so for most users the assistant is the only
 * reachable way to flip `memory.enabled`, not a fallback for one.
 */
export const MEMORY_ENABLE_PROMPT =
  "Turn my memory back on. I'd like you to start remembering things from our " +
  "conversations again.";

/** Which way out this surface offers, if any. */
export type MemoryUnavailableAction = "upgrade" | "settings" | "retry" | "none";

export interface MemoryUnavailableCopy {
  title: string;
  detail: string;
  action: MemoryUnavailableAction;
}

/**
 * Shown when `GET /memory/stats` fails outright (transport error or 5xx, after
 * React Query exhausts its retries).
 *
 * Deliberately NOT the unknown-tier copy. A failed status read is not evidence
 * about the tier: the assistant may be perfectly current and momentarily
 * unreachable, so telling its owner to go update it diagnoses a problem they
 * do not have. This surface exists to stop naming fixes that may not apply,
 * and a request that never landed is the case where we know least of all. Say
 * the read failed, and offer the only action that can help.
 */
export const MEMORY_STATUS_ERROR_COPY: MemoryUnavailableCopy = {
  title: "Couldn't check your memory settings",
  detail:
    "Something went wrong reading this assistant's memory status, so there's nothing reliable to tell you yet.",
  action: "retry",
};

/**
 * Tier → what to say about the missing graph.
 *
 * Each branch promises only what its own fix delivers. `"off"` masks the
 * underlying tier — an assistant with `memory.enabled === false` reports
 * `"off"` whether or not `memory.v3.live` is set — so turning Memory back on
 * restores remembering, not necessarily the graph. The copy says exactly that
 * and no more; once memory is on, this page re-renders as either the graph or
 * the v3 upgrade prompt, which is where the next step gets named.
 *
 * `undefined` covers daemons predating the `tier` field, and `"v3"` covers the
 * contradiction where stats claims the v3 tier but the graph route reports no
 * support (a daemon mid-upgrade). Both get neutral copy and no CTA: naming a
 * fix we aren't sure applies is worse than naming none. Note what the fallback
 * does NOT promise — updating the assistant ships the code but does not flip
 * `memory.v3.live`, which existing workspaces only get through the corpus
 * migration. What an update does buy is the `tier` field, and with it a
 * specific answer here.
 */
export function describeMemoryUnavailable(
  tier: MemoryTier | undefined,
): MemoryUnavailableCopy {
  if (tier === "off") {
    return {
      title: "Memory is turned off",
      detail:
        "Your assistant isn't keeping anything from your conversations, so there's no map to draw. Turn Memory back on to start remembering again.",
      action: "settings",
    };
  }
  if (tier === "v1" || tier === "v2") {
    return {
      title: "Upgrade to memory v3",
      detail:
        "Your assistant is on an older memory engine. Memory v3 reorganizes what it knows into a linked wiki of concepts, and that wiki is what this map draws.",
      action: "upgrade",
    };
  }
  return {
    title: "Memory graph isn't available",
    detail:
      "This assistant's memory backend doesn't report enough to say why. Update your assistant, and this page will tell you what it needs.",
    action: "none",
  };
}
