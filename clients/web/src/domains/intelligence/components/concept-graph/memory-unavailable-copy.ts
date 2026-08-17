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
 * Pure aside from catalog reads, so the copy-per-tier decision is testable
 * without a router or a query client — the component in
 * `memory-upgrade-prompt.tsx` only renders it.
 */

import type { MemoryTier } from "@/domains/intelligence/memory-graph/get-memory-stats";
import { t } from "@/i18n";

/**
 * Seeds the upgrade chat on a **v2** assistant.
 *
 * Names the skill it will most likely want, then gets out of the way. The
 * pointer is worth handing over, but it stays a pointer: both migration skills
 * carry `avoid-when` rules, so an empty or near-empty corpus can end up
 * somewhere else entirely, and the assistant is the one that can count its
 * pages and read those rules. "Work out what my corpus actually needs" is what
 * lets it deviate; "follow it exactly" is what keeps it honest once it picks.
 */
export function memoryV2UpgradePrompt(): string {
  return t("memoryUnavailable.prompts.v2", { ns: "intelligence" });
}

/**
 * Seeds the upgrade chat on a **v1** assistant, whose memory lives in the
 * legacy PKB graph with no concept pages at all.
 *
 * Names both skills and their order, because that order is real and not
 * obvious: the v2 migration backfills `memory/concepts/` from `pkb/` and the
 * buffer, and the v3 migration reforms the result, so reaching for v3 first
 * meets its empty-corpus guard. Hedged for the same reason as the v2 seed, and
 * one case in particular: a v1 assistant that never wrote a PKB entry has
 * nothing for either skill to migrate, and the whole job collapses to a config
 * change. Stated as a mandate, this seed would describe a sequence that cannot
 * run.
 */
export function memoryV1UpgradePrompt(): string {
  return t("memoryUnavailable.prompts.v1", { ns: "intelligence" });
}

/**
 * Seeds the turn-memory-back-on chat. The Memory toggle lives on the Developer
 * page, which is gated behind the `settingsDeveloperNav` flag and redirects to
 * General Settings without it — so for most users the assistant is the only
 * reachable way to flip `memory.enabled`, not a fallback for one.
 */
export function memoryEnablePrompt(): string {
  return t("memoryUnavailable.prompts.enable", { ns: "intelligence" });
}

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
export function memoryStatusErrorCopy(): MemoryUnavailableCopy {
  return {
    title: t("memoryUnavailable.statusError.title", { ns: "intelligence" }),
    detail: t("memoryUnavailable.statusError.detail", { ns: "intelligence" }),
    action: "retry",
  };
}

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
      title: t("memoryUnavailable.off.title", { ns: "intelligence" }),
      detail: t("memoryUnavailable.off.detail", { ns: "intelligence" }),
      action: "settings",
      prompt: memoryEnablePrompt(),
    };
  }
  if (tier === "v1" || tier === "v2") {
    return {
      title: t("memoryUnavailable.legacy.title", { ns: "intelligence" }),
      detail: t("memoryUnavailable.legacy.detail", { ns: "intelligence" }),
      action: "upgrade",
      prompt:
        tier === "v1" ? memoryV1UpgradePrompt() : memoryV2UpgradePrompt(),
    };
  }
  return {
    title: t("memoryUnavailable.unknown.title", { ns: "intelligence" }),
    detail: t("memoryUnavailable.unknown.detail", { ns: "intelligence" }),
    action: "none",
  };
}
