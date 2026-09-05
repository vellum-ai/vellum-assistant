/**
 * The memory-v3 {@link Injector}s: frozen net-new sections + per-turn pointer.
 *
 * Two injectors share one orchestration result per turn (memoized via
 * {@link observeTurnOnce} so re-entry assemblies — overflow convergence,
 * post-compaction re-injection — reuse the turn's selections instead of
 * re-running the selector):
 *
 *  - {@link memoryV3Injector} (id `memory-v3`, `after-memory-prefix`): the
 *    PERSISTENT layer. The injection unit is the SECTION: each selected page
 *    contributes its finder-matched section, or its lead when it was selected
 *    without a match (a capability slug contributes its whole capability
 *    content). Renders only this turn's NET-NEW sections, pairs
 *    `(slug, section key)` not already active in the section store, inside
 *    one `<memory>` block and returns the block. The store write
 *    (`recordInjected`) and the prune-valve schedule are DEFERRED to a commit
 *    callback the block carries (`meta[MEMORY_V3_COMMIT_META_KEY]`): runtime
 *    assembly invokes it only when the turn's tail is a user message — the
 *    same gate as metadata capture — so a turn whose block silently fails to
 *    attach never claims its sections in the store (which would suppress
 *    them until compaction). Runtime assembly splices the block onto the
 *    current user message and the user-prompt-submit hook persists the
 *    unwrapped inner text under `metadata.memoryV3InjectedBlock`;
 *    `conversation.ts` rehydrates it on load. The block is FROZEN thereafter:
 *    prior turns' section blocks stay byte-identical in history, so they ride
 *    the provider's cached prefix and survive restarts, mirroring v2's
 *    `memoryInjectedBlock` mechanism. An all-repeat turn returns an
 *    EMPTY-TEXT block: assembly attaches nothing, but the block's presence
 *    still keys v2 suppression (v3 ran and owns the `<memory>` layer this
 *    turn). A `null` return (failure / empty selection / every net-new
 *    section rendered empty) attaches no v3 block: under `memory-v3-live` the
 *    user-prompt-submit hook skips v2 retrieval entirely, so a null return
 *    leaves the turn with no NEW injected memory (prior turns' frozen
 *    sections still ride history).
 *
 *  - {@link memoryV3PointerInjector} (id `memory-v3-pointer`,
 *    `after-memory-prefix`): the per-turn pointer layer. Lists this turn's
 *    selected sections that are ALREADY resident in history (selected again,
 *    not injected net-new this turn) as a `<memory_pointer>` block of
 *    `memory/concepts/<slug>.md § <key>` lines, no bodies, so the model knows
 *    which frozen sections the turn is about. Runtime assembly splices the
 *    block onto the current user message immediately after any frozen
 *    `<memory>` sections; the user-prompt-submit hook persists the wrapped
 *    text under `metadata.memoryV3PointerBlock` and `conversation.ts`
 *    rehydrates it on load. Historical user messages keep the pointer they
 *    were sent with, so the provider prefix through those messages stays
 *    byte-identical; mid-turn re-entry and post-compact tail-strip the
 *    current tail before splicing a fresh pointer so the block does not
 *    double-stack.
 *
 * Gating: `memory.v3.live` (config) runs orchestration and attaches blocks;
 * with it off, no orchestration runs and nothing is attached.
 *
 * Both injectors apply the same personal-memory trust gate as v2
 * ({@link isPersonalMemoryAllowed}): an untrusted remote actor's turn
 * produces nothing, no orchestration, no sections, no pointer, and nothing
 * recorded or persisted. Memory pages, skill/CLI capability content, and
 * matched sections all surface private user content, and because v3 blocks
 * are persisted to message metadata and rehydrated forever, the gate must
 * also keep an untrusted turn from recording or persisting anything.
 *
 * Re-entry assemblies (the post-compaction hook, which also serves the
 * overflow ladder's rungs) attach their blocks in memory only: metadata is
 * persisted at the first-call site alone, and every message a re-entry
 * attaches to predates a compaction's `historyStrippedAt` marker, which
 * keeps `loadFromDb` from rehydrating it. The turn memo remembers what the
 * first produce rendered, and a re-entry re-emits those entries byte for
 * byte: the hook's tail strip cleared their only copy while the store still
 * counts them active, so partitioning against the store alone would read
 * them as resident and drop them for the rest of the turn. Around them it
 * points at the pairs still active, renders anew any pair a compaction's
 * store reset left unclaimed, and skips any pair tombstoned since (the
 * Step-0 strip's verdict stands). A re-entry block carries no commit, and
 * runtime assembly withholds the commit on a `reinjection` assembly
 * besides, so a turn's sections are recorded exactly once, at the
 * first-call site that persists them. After a compaction the re-rendered
 * sections stay unclaimed: the next turn injects them net-new onto its own
 * persisted user message, and the re-entry copy still in the live history
 * is superseded by the newest-copy rule at the assembly after that
 * (`stripPrunedSectionsFromMessages`).
 */

import { getConfig } from "../../../../config/loader.js";
import {
  isMemoryEnabled,
  isMemoryV3Live,
} from "../../../../config/memory-v3-gate.js";
import {
  type PendingConversationNotice,
  queueConversationNotice,
} from "../../../../daemon/conversation-notices.js";
import { isPersonalMemoryAllowed } from "../../../../daemon/trust-context.js";
import {
  type InjectionBlock,
  type Injector,
  type TurnContext,
} from "../../../types.js";
import { getLogger } from "../logging.js";
import { wrapMemoryBlock, wrapMemoryPointerBlock } from "../memory-marker.js";
import { injectionSectionKey, isCapabilitySlug } from "./capabilities.js";
import { renderedBytes } from "./card.js";
import {
  getActiveSections,
  getPrunedSections,
  recordInjected,
  sectionRefSetHas,
} from "./ever-injected-store.js";
import type { OrchestrateResult } from "./orchestrate.js";
import { renderV3InjectionEntry } from "./page-content.js";
import { MemoryV3RetrievalUnavailableError } from "./pool-select.js";
import { schedulePruneValve } from "./prune.js";
import {
  renderInjectionBlockInner,
  renderPointerInner,
} from "./render-injection.js";
import { observeTurn } from "./shadow-plugin.js";
import {
  MEMORY_V3_BLOCK_ID,
  MEMORY_V3_COMMIT_META_KEY,
  MEMORY_V3_POINTER_BLOCK_ID,
  type Section,
  type SectionRef,
  type Slug,
} from "./types.js";

const log = getLogger("memory-v3-shadow");

/**
 * Cap on the per-conversation memo below. Least-recently-touched entries are
 * evicted first; an evicted conversation simply re-runs orchestration on its
 * next turn.
 */
const MAX_TRACKED_CONVERSATIONS = 256;

/**
 * LRU-set `key` on `map`: delete-then-set so a re-touched key moves to the
 * back of the Map's insertion order (a plain `set` on an existing key keeps
 * its original position, which would evict the most long-lived ACTIVE
 * conversation first). Eviction only fires when inserting a genuinely new
 * key at the cap.
 */
function lruSet<V>(map: Map<string, V>, key: string, value: V): void {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= MAX_TRACKED_CONVERSATIONS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
  map.set(key, value);
}

function queueMemoryV3ConversationNotice(
  err: MemoryV3RetrievalUnavailableError,
  ctx: TurnContext,
): void {
  const notice: PendingConversationNotice = err.conversationNotice ?? {
    source: "memory_v3",
    code: "UNKNOWN",
    userMessage:
      "Memory is temporarily unavailable, so this response may not use your saved memories. You can retry in a moment.",
    errorCategory: "memory_v3_degraded",
  };
  queueConversationNotice(
    ctx.conversationId,
    `memory_v3:${ctx.turnIndex}:${notice.errorCategory ?? notice.code}`,
    notice,
  );
}

/**
 * The gates both injectors share: memory on, v3 live, a trusted actor, and
 * not the voice front door (which keeps carried sections from history but
 * defers current-turn retrieval to the escalated leg so memory cannot delay
 * its first token).
 */
function turnIsEligible(ctx: TurnContext): boolean {
  const config = getConfig();
  if (!isMemoryEnabled(config) || !isMemoryV3Live(config)) {
    return false;
  }
  if (!isPersonalMemoryAllowed(ctx.trust)) {
    return false;
  }
  return ctx.callSite !== "voiceFrontDoor";
}

// ─── shared per-turn orchestration memo ─────────────────────────────────────

interface ObservedTurn {
  turnIndex: number;
  result: Promise<OrchestrateResult | null>;
  /** The resident sections this turn's latest sections-produce pointed at,
   *  rendered by the pointer injector (which runs after it). */
  pointer?: SectionRef[];
  /** The entries the turn's FIRST produce rendered net-new (the ones its
   *  commit recorded), by slug and section key. A re-entry assembly within
   *  the turn re-emits them byte for byte instead of partitioning them
   *  against the store, which counts them active although their only copy
   *  rode the tail the re-injection strip cleared. Set even when empty, so
   *  a re-entry is recognised as one. */
  rendered?: ReadonlyMap<Slug, ReadonlyMap<string, string>>;
}

/** Latest observed turn per conversation (both injectors + re-entry sites
 *  share one orchestration per turn). */
const observedTurns = new Map<string, ObservedTurn>();

/**
 * Run {@link observeTurn} once per (conversation, turn) and memoize the
 * promise. The sections and pointer injectors both consume the result, and
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
  if (cached && cached.turnIndex === turnIndex) {
    return cached.result;
  }
  const result = observeTurn(conversationId, turnIndex);
  lruSet(observedTurns, conversationId, { turnIndex, result });
  return result;
}

function observedTurn(
  conversationId: string,
  turnIndex: number,
): ObservedTurn | undefined {
  const cached = observedTurns.get(conversationId);
  return cached && cached.turnIndex === turnIndex ? cached : undefined;
}

function rememberPointerEntries(
  conversationId: string,
  turnIndex: number,
  entries: SectionRef[],
): void {
  const cached = observedTurn(conversationId, turnIndex);
  if (cached) {
    cached.pointer = entries;
  }
}

function rememberRendered(
  conversationId: string,
  turnIndex: number,
  entries: ReadonlyArray<SectionRef & { text: string }>,
): void {
  const cached = observedTurn(conversationId, turnIndex);
  if (!cached) {
    return;
  }
  const rendered = new Map<Slug, Map<string, string>>();
  for (const { slug, key, text } of entries) {
    let keys = rendered.get(slug);
    if (!keys) {
      keys = new Map();
      rendered.set(slug, keys);
    }
    keys.set(key, text);
  }
  cached.rendered = rendered;
}

/** Test-only reset for the per-turn memo. */
export function resetMemoryV3InjectorStateForTests(): void {
  observedTurns.clear();
}

// ─── injectors ───────────────────────────────────────────────────────────────

/** One selection this assembly's block carries, in selection order: `text`
 *  is the first produce's entry when re-emitted by a re-entry, and is
 *  rendered here otherwise. */
interface BlockSlot {
  slug: Slug;
  key: string;
  matched: Section | undefined;
  text: string | undefined;
}

export const memoryV3Injector: Injector = {
  name: "memory-v3-shadow",
  // High order so it sorts last; the live `<memory>` block uses the
  // after-memory-prefix placement so it lands at the memory boundary regardless
  // of this sort key, which only orders content-producing injectors.
  order: 1000,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    if (!turnIsEligible(ctx)) {
      return null;
    }

    let observed: OrchestrateResult | null;
    try {
      observed = await observeTurnOnce(ctx.conversationId, ctx.turnIndex);
    } catch (err) {
      if (err instanceof MemoryV3RetrievalUnavailableError) {
        queueMemoryV3ConversationNotice(err, ctx);
        log.error(
          {
            err: err.message,
            conversationId: ctx.conversationId,
            mode: "live",
          },
          "memory-v3 selection failed; skipping v3 memory for this turn",
        );
      }
      return null;
    }
    // Empty selection → return null (attach nothing). The user-prompt-submit
    // hook skipped v2 retrieval under live, so a turn with nothing selected
    // simply gets no v3 `<memory>` block (prior turns' frozen sections still
    // ride history).
    if (!observed || observed.selections.length === 0) {
      return null;
    }
    // `const` so the non-null narrowing survives capture in the `commit`
    // closure below (a `let` would re-widen to `OrchestrateResult | null`).
    const result = observed;

    try {
      // Partition this turn's selections. Each page injects under ONE key
      // this turn: its matched section's key, or `""` for the lead (and for
      // capability content, which injects whole). A resident pair (active in
      // the section store) is a pointer entry; capability slugs are left out
      // of the pointer because they have no `memory/concepts/` path to point
      // at. On a re-entry assembly (`rendered` set by the turn's first
      // produce) an entry the first produce rendered is re-emitted from the
      // memo byte for byte: the store counts it active, but its only copy
      // rode the tail the re-injection strip cleared, so the store alone
      // would read it as resident and drop it for the rest of the turn. A
      // pair tombstoned since the first produce is skipped outright (a
      // re-entry never revives what the valve pruned), and a pair the first
      // produce saw resident whose copy a compaction's store reset has since
      // unclaimed (neither active nor tombstoned) renders anew, in memory
      // only.
      const rendered = observedTurn(
        ctx.conversationId,
        ctx.turnIndex,
      )?.rendered;
      const firstProduce = rendered === undefined;
      const active = getActiveSections(ctx.conversationId);
      const pruned = firstProduce
        ? undefined
        : getPrunedSections(ctx.conversationId);
      const resident: SectionRef[] = [];
      const slots: BlockSlot[] = [];
      for (const { slug } of result.selections) {
        const matched = result.matchedSections.get(slug);
        const key = injectionSectionKey(slug, matched);
        if (pruned && sectionRefSetHas(pruned, slug, key)) {
          continue;
        }
        const reemitted = rendered?.get(slug)?.get(key);
        if (reemitted !== undefined) {
          slots.push({ slug, key, matched, text: reemitted });
          continue;
        }
        if (sectionRefSetHas(active, slug, key)) {
          if (!isCapabilitySlug(slug)) {
            resident.push({ slug, key });
          }
          continue;
        }
        slots.push({ slug, key, matched, text: undefined });
      }
      rememberPointerEntries(ctx.conversationId, ctx.turnIndex, resident);

      // Render net-new sections (each an independent page read, so in
      // parallel), skipping pairs that resolve to no content (deleted pages,
      // unresolvable capabilities, empty sections): nothing is attached for
      // them, so nothing is recorded either.
      const netNew = slots.filter((slot) => slot.text === undefined);
      const renderedNow = await Promise.all(
        netNew.map(({ slug, matched }) =>
          renderV3InjectionEntry(slug, matched),
        ),
      );
      for (const [i, slot] of netNew.entries()) {
        slot.text = renderedNow[i]!;
      }
      const entries: Array<SectionRef & { text: string }> = [];
      for (const { slug, key, text } of slots) {
        if (text !== undefined && text.trim().length > 0) {
          entries.push({ slug, key, text });
        }
      }
      // Every net-new section rendered empty: return null rather than an
      // empty-text block. Under live there is no v2 block, so the turn simply
      // gets no new memory. Distinct from the all-repeat case (empty
      // `netNew`), where the empty block correctly keeps v2 suppressed
      // because the sections already ride history.
      if (netNew.length > 0 && entries.length === 0) {
        return null;
      }

      // Empty net-new → empty-text block: assembly attaches no content
      // (`applyInjectionBlock` no-ops empty text) but the block's presence
      // still marks v3 as this turn's `<memory>` source for v2 suppression.
      const inner = renderInjectionBlockInner(entries.map((e) => e.text));
      const block: InjectionBlock = {
        id: MEMORY_V3_BLOCK_ID,
        text: inner.length === 0 ? "" : wrapMemoryBlock(inner),
        // Mirror v2's dynamic `<memory>` block placement.
        placement: "after-memory-prefix",
      };
      if (!firstProduce) {
        return block;
      }

      rememberRendered(ctx.conversationId, ctx.turnIndex, entries);
      // The section-store write and the prune-valve schedule are DEFERRED to
      // this commit callback, invoked by runtime assembly at the point where
      // attachment is guaranteed (the turn's tail is a user message, the
      // same gate as metadata capture). Recording here in `produce()` would
      // let a never-attached turn (non-user tail) claim sections in the
      // store, suppressing them until compaction. Only the turn's first
      // produce carries it: a re-entry block re-emits what this one
      // rendered and is never persisted, so it must not record anything.
      // The valve is scheduled after `recordInjected` so the resident
      // accounting includes this turn's sections; it evicts by recency with
      // no lane exemptions. It runs on a timer, so this turn's block may not
      // have folded back into the live history when it strips; a section it
      // prunes from this very turn is stripped by assembly Step 0 on the
      // next turn, which applies the store's full tombstone set every turn.
      const commit = (): void => {
        recordInjected(
          ctx.conversationId,
          entries.map(({ slug, key, text }) => ({
            slug,
            key,
            // Capability content (skills / CLI commands) renders with its own
            // `# Skill:` / `# CLI command:` header, which the prune valve's
            // section grammar can never locate to free. Record it at zero
            // bytes so it never inflates the freeable resident accounting
            // (the valve would otherwise loop-fire on bytes it cannot free).
            bytes: isCapabilitySlug(slug) ? 0 : renderedBytes(text),
          })),
        );
        schedulePruneValve(ctx.conversationId);
      };
      return { ...block, meta: { [MEMORY_V3_COMMIT_META_KEY]: commit } };
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          conversationId: ctx.conversationId,
        },
        "memory-v3 live render failed (non-fatal) — returning null (no v3 block this turn)",
      );
      return null;
    }
  },
};

export const memoryV3PointerInjector: Injector = {
  name: "memory-v3-pointer",
  // After the sections injector, whose produce records the resident
  // selections of this assembly on the shared memo (a re-entry recomputes
  // them, so the pointer follows what its own block re-emitted or rendered).
  order: 1001,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    if (!turnIsEligible(ctx)) {
      return null;
    }
    const entries = observedTurn(ctx.conversationId, ctx.turnIndex)?.pointer;
    if (!entries || entries.length === 0) {
      return null;
    }
    return {
      id: MEMORY_V3_POINTER_BLOCK_ID,
      text: wrapMemoryPointerBlock(renderPointerInner(entries)),
      // Immediately after the frozen `<memory>` blocks: `countMemoryPrefixBlocks`
      // counts `<memory>` but not `<memory_pointer>`, so this lands between
      // the sections and NOW.md / user text.
      placement: "after-memory-prefix",
    };
  },
};
