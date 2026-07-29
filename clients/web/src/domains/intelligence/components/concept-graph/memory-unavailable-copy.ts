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
 * Seeds the upgrade chat on a **v2** assistant whose concept corpus has pages
 * in it: the job is the staged reform into v3 article shape.
 *
 * Deliberately short. Every hard rule worth stating already lives in the skill
 * (its preflight, the size-and-confirm gate, the judge leaf-profile check, the
 * loss audit, the Step 10 close-out), and restating them here would duplicate
 * a spec that versions separately from this file. "Follow it exactly" points
 * at the source of truth rather than racing it.
 */
export const MEMORY_V3_REFORM_PROMPT = `Migrate my memory from v2 to v3 by running your "Memory v3 Migration" skill. Follow it exactly.

Run it in the background and tell me when it's done, or if something blocks.`;

/**
 * Seeds the upgrade chat on a **v2** assistant whose concept corpus is empty.
 *
 * `memoryTier()` reads `"v2"` off configuration alone (`memory.v2.enabled`,
 * which defaults on), so the tier says nothing about whether pages exist, and
 * an empty corpus is the common case rather than the edge one. The reform
 * skill's own `avoid-when` excludes an empty or near-empty corpus, so naming
 * it here would seed an instruction that skill rejects. With nothing to
 * reform, going live is a config flip, which is why this asks the assistant to
 * confirm the corpus really is empty before taking that path.
 */
export const MEMORY_V3_FLIP_PROMPT = `Migrate my memory from v2 to v3. My concept corpus looks empty, so check before doing anything heavy: if there's nothing to reform, set memory.v3.live true and you're done. If there is something, run the migration skill that fits and follow it exactly.

Run it in the background and tell me when it's done, or if something blocks.`;

/**
 * Seeds the upgrade chat on a **v1** assistant, whose memory lives in the
 * legacy PKB graph with no concept pages at all.
 *
 * Two hops, in this order, because neither skill spans the gap alone: the v2
 * migration backfills `memory/concepts/` from `pkb/` and the buffer, and the
 * v3 migration reforms a populated corpus into article shape. Reaching for the
 * v3 skill first would hit its empty-corpus guard and stop.
 */
export const MEMORY_V1_UPGRADE_PROMPT = `Migrate my memory from v1 to v3. That's two hops: run your "Memory v2 Migration" skill, then your "Memory v3 Migration" skill. Follow both exactly.

Run it in the background and tell me when it's done, or if something blocks.`;

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
  /**
   * Seed for the chat this state's CTA opens, where it opens one. Carried on
   * the copy rather than chosen by the component: which seed is correct is a
   * property of the tier (a v2 corpus gets reformed, a v1 one gets backfilled),
   * and that decision belongs next to the tier's other copy.
   */
  prompt?: string;
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
/**
 * Which seed a legacy tier gets. The tier alone can't decide it: `"v2"` is a
 * configuration bit (`memory.v2.enabled`, defaulted on) and says nothing about
 * whether the corpus holds anything, so a fresh workspace and a 250-page one
 * report the same tier while needing opposite work. `conceptPages` is the
 * measurement that separates them, and it rides the same `GET /memory/stats`
 * response as the tier.
 *
 * An unknown count keeps the reform seed: the skill guards its own empty-corpus
 * case, so guessing "empty" without the number is the worse of the two errors.
 */
function upgradeSeedFor(
  tier: "v1" | "v2",
  conceptPages: number | undefined,
): string {
  if (tier === "v1") {
    return MEMORY_V1_UPGRADE_PROMPT;
  }
  return conceptPages === 0 ? MEMORY_V3_FLIP_PROMPT : MEMORY_V3_REFORM_PROMPT;
}

export function describeMemoryUnavailable(
  tier: MemoryTier | undefined,
  conceptPages?: number,
): MemoryUnavailableCopy {
  if (tier === "off") {
    return {
      title: "Memory is turned off",
      detail:
        "Your assistant isn't keeping anything from your conversations, so there's no map to draw. Turn Memory back on to start remembering again.",
      action: "settings",
      prompt: MEMORY_ENABLE_PROMPT,
    };
  }
  if (tier === "v1" || tier === "v2") {
    return {
      title: "Upgrade to memory v3",
      detail:
        "Your assistant is on an older memory engine. Memory v3 reorganizes what it knows into a linked wiki of concepts, and that wiki is what this map draws.",
      action: "upgrade",
      prompt: upgradeSeedFor(tier, conceptPages),
    };
  }
  return {
    title: "Memory graph isn't available",
    detail:
      "This assistant's memory backend doesn't report enough to say why. Update your assistant, and this page will tell you what it needs.",
    action: "none",
  };
}
