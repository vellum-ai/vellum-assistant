/**
 * The memory-v3 {@link Injector}s: frozen net-new cards + ephemeral spotlight.
 *
 * Two injectors share one orchestration result per turn (memoized via
 * {@link observeTurnOnce} so re-entry assemblies — overflow convergence,
 * post-compaction re-injection — reuse the turn's selections instead of
 * re-running the selector):
 *
 *  - {@link memoryV3Injector} (id `memory-v3`, `after-memory-prefix`): the
 *    PERSISTENT layer. Renders only this turn's NET-NEW selections — selections
 *    not already in the everInjected store — as compact cards inside one
 *    `<memory>` block, records them (`recordInjected`), and returns the block.
 *    Runtime assembly splices it onto the current user message and the
 *    user-prompt-submit hook persists the unwrapped inner text under
 *    `metadata.memoryV3InjectedBlock`; `conversation.ts` rehydrates it on
 *    load. The block is FROZEN thereafter: prior turns' card blocks stay
 *    byte-identical in history, so they ride the provider's cached prefix and
 *    survive restarts — mirroring v2's `memoryInjectedBlock` mechanism. An
 *    all-repeat turn returns an EMPTY-TEXT block: assembly attaches nothing,
 *    but the block's presence still keys v2 suppression (v3 ran and owns the
 *    `<memory>` layer this turn). A `null` return (failure / empty selection)
 *    leaves v2's block intact — fallback to v2 rather than a memory-less turn.
 *
 *  - {@link memoryV3SpotlightInjector} (id `memory-v3-spotlight`,
 *    `append-user-tail`): the EPHEMERAL layer. Renders the top `spotlight.n`
 *    selected finder hits' matched sections, plus the previous
 *    `spotlight.windowTurns` turns' entries from an in-memory per-conversation
 *    ring (a daemon restart simply re-warms it), as a `<memory_spotlight>`
 *    block at the current-message tail. Assembly strip-and-replaces this block
 *    every turn (scoped to this block id only); it is never persisted to
 *    metadata.
 *
 * Flag gating is unchanged: `memory-v3-live` attaches blocks; `memory-v3-shadow`
 * (live off) logs what WOULD inject (net-new slugs + bytes + spotlight refs)
 * and attaches nothing; both off → no orchestration.
 *
 * Known mirror-of-v2 limitation: cards attached by mid-turn re-entry
 * assemblies (post-compaction re-injection) live only in memory — metadata is
 * persisted at the first-call site only — so a restart drops them while the
 * store still claims them, exactly as v2's `lastInjectedBlock` reinject does.
 * The next compaction clears the store and resets both layers.
 */

import { isAssistantFeatureFlagEnabled } from "../../../config/assistant-feature-flags.js";
import { getConfig } from "../../../config/loader.js";
import {
  wrapMemoryBlock,
  wrapMemorySpotlightBlock,
} from "../../../memory/memory-marker.js";
import { getLogger } from "../../../util/logger.js";
import {
  type InjectionBlock,
  type Injector,
  type TurnContext,
} from "../../types.js";
import { cardBytes } from "./card.js";
import { getActiveSlugs, recordInjected } from "./ever-injected-store.js";
import type { OrchestrateResult } from "./orchestrate.js";
import { renderV3CardContent } from "./page-content.js";
import { schedulePruneValve } from "./prune.js";
import {
  renderCardsBlockInner,
  renderSpotlightInner,
  type SpotlightEntry,
} from "./render-injection.js";
import {
  MEMORY_V3_LIVE,
  MEMORY_V3_SHADOW,
  observeTurn,
} from "./shadow-plugin.js";
import {
  MEMORY_V3_BLOCK_ID,
  MEMORY_V3_SPOTLIGHT_BLOCK_ID,
  type Slug,
} from "./types.js";

const log = getLogger("memory-v3-shadow");

/**
 * Cap on the per-conversation maps below. Oldest-inserted entries are evicted
 * first; an evicted conversation simply re-warms (spotlight) or re-runs
 * orchestration (memo) on its next turn.
 */
const MAX_TRACKED_CONVERSATIONS = 256;

function evictOldest(map: Map<string, unknown>): void {
  if (map.size < MAX_TRACKED_CONVERSATIONS) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

// ─── shared per-turn orchestration memo ─────────────────────────────────────

interface ObservedTurn {
  turnIndex: number;
  result: Promise<OrchestrateResult | null>;
}

/** Latest observed turn per conversation (both injectors + re-entry sites
 *  share one orchestration per turn). */
const observedTurns = new Map<string, ObservedTurn>();

/**
 * Run {@link observeTurn} once per (conversation, turn) and memoize the
 * promise. The cards and spotlight injectors both consume the result, and
 * re-entry assemblies within the same turn (overflow convergence,
 * post-compaction re-injection) reuse the turn's selections rather than
 * paying a second selector call. A new `turnIndex` replaces the entry, so the
 * memo never holds more than one turn per conversation.
 */
function observeTurnOnce(
  conversationId: string,
  turnIndex: number,
): Promise<OrchestrateResult | null> {
  const cached = observedTurns.get(conversationId);
  if (cached && cached.turnIndex === turnIndex) return cached.result;
  evictOldest(observedTurns);
  const result = observeTurn(conversationId, turnIndex);
  observedTurns.set(conversationId, { turnIndex, result });
  return result;
}

// ─── ephemeral spotlight ring ────────────────────────────────────────────────

interface SpotlightTurn {
  turnIndex: number;
  entries: SpotlightEntry[];
}

/** Recent turns' spotlight entries per conversation, oldest → newest. */
const spotlightRings = new Map<string, SpotlightTurn[]>();

/**
 * Compute this turn's spotlight entries: the top `n` SELECTED finder hits'
 * matched sections, in finder surfacing order (needle → dense → edge
 * precedence). A finder hit on a stable-prefix page keeps its matched-section
 * ref in the orchestrate result, so core/hot pages with current relevance
 * spotlight too.
 */
function computeSpotlightEntries(
  result: OrchestrateResult,
  n: number,
): SpotlightEntry[] {
  const selected = new Set<Slug>(result.selections.map((s) => s.slug));
  const entries: SpotlightEntry[] = [];
  for (const candidate of result.lanes.finder) {
    if (entries.length >= n) break;
    if (!selected.has(candidate.slug)) continue;
    const section = result.matchedSections.get(candidate.slug);
    if (!section) continue;
    entries.push({
      slug: candidate.slug,
      title: section.title,
      text: section.text,
    });
  }
  return entries;
}

/**
 * Fold this turn's entries into the conversation's ring and return the
 * rendered window: current turn first, then previous turns newest-first,
 * deduped by slug § heading, bounded by `n × (windowTurns + 1)` entries by
 * construction. Re-observing the SAME turn (re-entry assembly) replaces that
 * turn's entry rather than accumulating.
 */
function updateSpotlightWindow(
  conversationId: string,
  turnIndex: number,
  entries: SpotlightEntry[],
  windowTurns: number,
): SpotlightEntry[] {
  const prior = (spotlightRings.get(conversationId) ?? []).filter(
    (t) => t.turnIndex < turnIndex && t.turnIndex >= turnIndex - windowTurns,
  );
  if (!spotlightRings.has(conversationId)) evictOldest(spotlightRings);
  spotlightRings.set(conversationId, [...prior, { turnIndex, entries }]);

  const window: SpotlightEntry[] = [];
  const seen = new Set<string>();
  // Newest first: this turn's entries, then prior turns newest → oldest.
  for (const turn of [{ turnIndex, entries }, ...prior.reverse()]) {
    for (const entry of turn.entries) {
      const key = `${entry.slug}§${entry.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      window.push(entry);
    }
  }
  return window;
}

/** Test-only reset for the per-turn memo and the spotlight rings. */
export function resetMemoryV3InjectorStateForTests(): void {
  observedTurns.clear();
  spotlightRings.clear();
}

// ─── injectors ───────────────────────────────────────────────────────────────

export const memoryV3Injector: Injector = {
  name: "memory-v3-shadow",
  // High order so it sorts last; the live `<memory>` block uses the
  // after-memory-prefix placement so it lands at the memory boundary regardless
  // of this sort key, which only orders content-producing injectors.
  order: 1000,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const config = getConfig();
    const live = isAssistantFeatureFlagEnabled(MEMORY_V3_LIVE, config);
    const shadow = isAssistantFeatureFlagEnabled(MEMORY_V3_SHADOW, config);
    if (!live && !shadow) return null;

    const result = await observeTurnOnce(ctx.conversationId, ctx.turnIndex);
    // Empty selection falls back to v2 (return null): v2 suppression keys off
    // BOTH the flag AND a produced block, so a selector failure or a turn with
    // nothing selected ships v2 memory rather than no memory.
    if (!result || result.selections.length === 0) return null;

    try {
      const active = getActiveSlugs(ctx.conversationId);
      const netNew = result.selections
        .map((s) => s.slug)
        .filter((slug) => !active.has(slug));

      // Render net-new cards, skipping slugs that resolve to no content
      // (deleted pages, unresolvable capabilities) — nothing is attached for
      // them, so nothing is recorded either.
      const cards: Array<{ slug: Slug; card: string }> = [];
      for (const slug of netNew) {
        const card = await renderV3CardContent(slug);
        if (card.trim().length > 0) cards.push({ slug, card });
      }
      const entries = cards.map(({ slug, card }) => ({
        slug,
        bytes: cardBytes(card),
      }));

      if (!live) {
        // Shadow mode: log what WOULD inject, attach and record nothing.
        const spotlightRefs = computeSpotlightEntries(
          result,
          config.memory.v3.spotlight.n,
        ).map((e) => `${e.slug}§${e.title}`);
        log.info(
          {
            conversationId: ctx.conversationId,
            turnIndex: ctx.turnIndex,
            netNew: entries,
            netNewBytes: entries.reduce((sum, e) => sum + e.bytes, 0),
            spotlightRefs,
          },
          "memory-v3 shadow: would inject net-new cards + spotlight",
        );
        return null;
      }

      recordInjected(ctx.conversationId, entries);

      // Prune valve: deferred (never delays this turn's assembly) and fired
      // after `recordInjected` so the resident accounting includes this
      // turn's cards. Core/hot lane members are exempt — the selector's
      // stable prefix must never be pruned out from under it.
      schedulePruneValve(ctx.conversationId, {
        exemptSlugs: new Set<Slug>([...result.lanes.core, ...result.lanes.hot]),
      });

      // Empty net-new → empty-text block: assembly attaches no content
      // (`applyInjectionBlock` no-ops empty text) but the block's presence
      // still marks v3 as this turn's `<memory>` source for v2 suppression.
      const inner = renderCardsBlockInner(cards.map((c) => c.card));
      return {
        id: MEMORY_V3_BLOCK_ID,
        text: inner.length === 0 ? "" : wrapMemoryBlock(inner),
        // Mirror v2's dynamic `<memory>` block placement.
        placement: "after-memory-prefix",
      };
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          conversationId: ctx.conversationId,
        },
        "memory-v3 live render failed (non-fatal) — falling back to v2",
      );
      return null;
    }
  },
};

export const memoryV3SpotlightInjector: Injector = {
  name: "memory-v3-spotlight",
  // After the cards injector so the shared memo is (usually) already primed.
  order: 1001,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const config = getConfig();
    // Live-only: shadow mode logs spotlight refs from the cards injector and
    // must keep the turn untouched (no ring state either, so a later
    // live-flag flip starts from a clean window).
    if (!isAssistantFeatureFlagEnabled(MEMORY_V3_LIVE, config)) return null;

    try {
      const result = await observeTurnOnce(ctx.conversationId, ctx.turnIndex);
      if (!result || result.selections.length === 0) return null;

      const { n, windowTurns } = config.memory.v3.spotlight;
      const current = computeSpotlightEntries(result, n);
      const window = updateSpotlightWindow(
        ctx.conversationId,
        ctx.turnIndex,
        current,
        windowTurns,
      );
      if (window.length === 0) return null;

      return {
        id: MEMORY_V3_SPOTLIGHT_BLOCK_ID,
        text: wrapMemorySpotlightBlock(renderSpotlightInner(window)),
        placement: "append-user-tail",
      };
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          conversationId: ctx.conversationId,
        },
        "memory-v3 spotlight render failed (non-fatal) — skipping spotlight",
      );
      return null;
    }
  },
};
