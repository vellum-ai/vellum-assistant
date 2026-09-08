/**
 * The memory-v3 {@link Injector}s: frozen net-new sections + per-turn pointer.
 *
 * Two injectors share one orchestration result per turn (memoized via
 * {@link observeTurnOnce}, so re-entry assemblies, overflow convergence and
 * post-compaction re-injection, reuse the turn's selections instead of
 * re-running the selector):
 *
 *  - {@link memoryV3Injector} (id `memory-v3`, `after-memory-prefix`): the
 *    PERSISTENT layer. The injection unit is the SECTION: each selected page
 *    contributes every section selected for it, or its lead when it was
 *    selected with none (a capability slug contributes its whole capability
 *    content). It renders only this turn's NET-NEW units, the pairs
 *    `(slug, section key)` not already active in the section store, inside
 *    one `<memory>` block. The resident pairs are stamped with the turn's
 *    selection time (`touchSelected`, the prune valve's recency); the
 *    net-new record (`recordInjected`) and the valve schedule are DEFERRED
 *    to a commit callback the block carries
 *    (`meta[MEMORY_V3_COMMIT_META_KEY]`), which runtime assembly invokes
 *    only when the block attached to a user tail, so a block that fails to
 *    attach never claims its sections (which would suppress them until
 *    compaction). The user-prompt-submit hook persists the unwrapped text
 *    under `metadata.memoryV3InjectedBlock` and `conversation.ts` rehydrates
 *    it on load. The block is FROZEN thereafter: prior turns' blocks stay
 *    byte-identical in history, ride the provider's cached prefix, and
 *    survive restarts, mirroring v2's `memoryInjectedBlock`. An all-repeat
 *    turn returns an EMPTY-TEXT block: assembly attaches nothing, but its
 *    presence keys v2 suppression. A `null` return (failure, empty
 *    selection, every net-new section rendered empty) attaches no v3 block,
 *    and since the hook skips v2 retrieval under `memory-v3-live` the turn
 *    gets no NEW injected memory (prior turns' frozen sections still ride
 *    history).
 *
 *  - {@link memoryV3PointerInjector} (id `memory-v3-pointer`,
 *    `after-memory-prefix`): the per-turn pointer layer. Lists this turn's
 *    selected sections that are ALREADY resident in history as a
 *    `<memory_pointer>` block of `memory/concepts/<slug>.md § <key>` lines,
 *    no bodies, so the model knows which frozen sections the turn is about.
 *    The entries are re-validated against the section store at render time:
 *    a pair the valve tombstoned since classification is dropped (it
 *    re-injects on its next selection), and with nothing left no block is
 *    emitted. Runtime assembly splices the block right after any frozen
 *    `<memory>` sections; the hook persists the wrapped text under
 *    `metadata.memoryV3PointerBlock` and `conversation.ts` rehydrates it.
 *    Historical user messages keep the pointer they were sent with, so the
 *    prefix through them stays byte-identical; re-entry and post-compaction
 *    assemblies tail-strip the current pointer before splicing a fresh one.
 *
 * Gating: `memory.v3.live` (config) runs orchestration and attaches blocks;
 * with it off, nothing runs and nothing is attached. Both injectors apply
 * the personal-memory trust gate ({@link isPersonalMemoryAllowed}): an
 * untrusted remote actor's turn produces, records, and persists nothing,
 * since v3 blocks are persisted to message metadata and rehydrated forever.
 *
 * A re-entry assembly (the post-compaction hook, which also serves the
 * overflow ladder's rungs) attaches its blocks in memory only: metadata is
 * persisted at the first-call site alone, and every message a re-entry
 * attaches to predates a compaction's `historyStrippedAt` marker, which
 * keeps `loadFromDb` from rehydrating it. How a re-entry, and an assembly
 * whose run messages a transcript replaces, classify the turn's units is
 * documented at the partition in {@link memoryV3Injector}.
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
import { findConversationOrSubagent } from "../../../../daemon/conversation-registry.js";
import { isPersonalMemoryAllowed } from "../../../../daemon/trust-context.js";
import {
  type InjectionBlock,
  type Injector,
  type TurnContext,
} from "../../../types.js";
import { getLogger } from "../logging.js";
import { wrapMemoryBlock, wrapMemoryPointerBlock } from "../memory-marker.js";
import { renderedBytes } from "../substrate/injected-block-slugs.js";
import {
  type InjectionUnit,
  injectionUnits,
  isCapabilitySlug,
} from "./capabilities.js";
import {
  getActiveSections,
  getPrunedSections,
  recordInjected,
  sectionRefSetHas,
  touchSelected,
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
  type SectionRef,
  type Slug,
} from "./types.js";

const log = getLogger("memory-v3-shadow");

/**
 * Cap on the per-conversation memo below, counted over IDLE conversations:
 * the least-recently-touched idle entry is evicted first, and an evicted
 * conversation simply re-runs orchestration on its next turn. A memo whose
 * turn is still running is never evicted ({@link turnInFlight}), whatever
 * the number of other conversations touching the process: a later re-entry
 * of that turn re-emits the memo's rendered entries, and without them it
 * would read the turn's committed sections as resident and emit pointers
 * for bodies the re-injection strip cleared. The map can therefore exceed
 * the cap by the number of turns in flight, never by idle entries, and the
 * touches that follow such a burst, inserts and refreshes alike, evict idle
 * entries until it fits again.
 */
const MAX_TRACKED_CONVERSATIONS = 256;
let trackedConversationsCap = MAX_TRACKED_CONVERSATIONS;

/**
 * Whether the conversation's turn is running: the live conversation's
 * processing flag, set at turn start and cleared in the agent loop's
 * `finally`, which is the window every re-entry assembly runs in. A
 * conversation the registry does not hold, or a registry double without the
 * method, reads as idle.
 */
function turnInFlight(conversationId: string): boolean {
  const conversation = findConversationOrSubagent(conversationId);
  return (
    typeof conversation?.isProcessing === "function" &&
    conversation.isProcessing()
  );
}

/**
 * LRU-set `key` on `map`: delete-then-set so a re-touched key moves to the
 * back of the Map's insertion order (a plain `set` on an existing key keeps
 * its original position, which would evict the most long-lived ACTIVE
 * conversation first). Eviction fires on any touch, an insert or a refresh
 * of a tracked key, that finds the rest of the map at the cap, and takes
 * the least-recently-touched entries whose turn is not in flight.
 */
function lruSet<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  // Evict idle entries, least recently touched first, until the entry fits
  // the cap: a burst of turns in flight can carry the map past it, and the
  // touches that follow bring it back once they finish. A refresh evicts
  // like an insert, since after a burst the only conversations still
  // active may all be tracked already.
  for (const candidate of map.keys()) {
    if (map.size < trackedConversationsCap) {
      break;
    }
    if (!turnInFlight(candidate)) {
      map.delete(candidate);
    }
  }
  map.set(key, value);
}

/** Test-only: the memo's current size. */
export function memoryV3TurnMemoSizeForTests(): number {
  return observedTurns.size;
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

/** Test-only reset for the per-turn memo and its cap; a `capacity` shrinks
 *  the cap so eviction is reachable with a handful of conversations. */
export function resetMemoryV3InjectorStateForTests(
  capacity: number = MAX_TRACKED_CONVERSATIONS,
): void {
  observedTurns.clear();
  trackedConversationsCap = capacity;
}

// ─── injectors ───────────────────────────────────────────────────────────────

/** One unit this assembly's block carries, in selection order: `text` is
 *  the first produce's entry when re-emitted by a re-entry, and is rendered
 *  here otherwise. */
interface BlockSlot extends InjectionUnit {
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
      // Partition this turn's injection units: each selected section under
      // its own key, a page selected with none under `""` (its lead;
      // capability content injects whole under `""` too).
      //  - A pair tombstoned since the turn's first produce is skipped: a
      //    re-entry never revives what the valve pruned.
      //  - On a re-entry assembly (`rendered` set by the first produce) an
      //    entry the first produce rendered is re-emitted from the memo byte
      //    for byte: the store counts it active, but its only copy rode the
      //    tail the re-injection strip cleared, so the store alone would
      //    read it as resident and drop it for the rest of the turn. A
      //    re-entry block carries no commit (and runtime assembly withholds
      //    one on a `reinjection` assembly besides), so a turn's sections
      //    are recorded once, at the first-call site; after a compaction they
      //    stay unclaimed until the next turn injects them net-new onto its
      //    own persisted message, and the newest-copy rule
      //    (`stripPrunedSectionsFromMessages`) retires the re-entry copy.
      //  - A pair active in the store is resident: a pointer entry, stamped
      //    with the turn's selection time below. Capability slugs are
      //    stamped too but left out of the pointer (no `memory/concepts/`
      //    path to point at).
      //  - Every other pair renders net-new, including one the first produce
      //    saw resident whose copy a compaction's store reset has since
      //    unclaimed (neither active nor tombstoned), in memory only.
      // Under a run-messages replacement (`ctx.replacesRunMessages`: the
      // Slack chronological transcript, rendered from persisted rows, so it
      // carries no earlier turn's block) residency means nothing. The
      // store's active set is not consulted, every pair renders or
      // re-emits, none is pointed at, and the block carries no commit, so
      // nothing is recorded or scheduled and runtime assembly attaches the
      // block in memory only as the prompt's single copy. A Slack
      // conversation whose transcript injector is absent is not replaced and
      // injects as an ordinary committed turn.
      const rendered = observedTurn(
        ctx.conversationId,
        ctx.turnIndex,
      )?.rendered;
      const firstProduce = rendered === undefined;
      const replaced = ctx.replacesRunMessages === true;
      const active = replaced ? null : getActiveSections(ctx.conversationId);
      const pruned = firstProduce
        ? undefined
        : getPrunedSections(ctx.conversationId);
      const resident: SectionRef[] = [];
      const slots: BlockSlot[] = [];
      for (const { slug, key, matched } of injectionUnits(result.selections)) {
        if (pruned && sectionRefSetHas(pruned, slug, key)) {
          continue;
        }
        const reemitted = rendered?.get(slug)?.get(key);
        if (reemitted !== undefined) {
          slots.push({ slug, key, matched, text: reemitted });
          continue;
        }
        if (active && sectionRefSetHas(active, slug, key)) {
          resident.push({ slug, key });
          continue;
        }
        slots.push({ slug, key, matched, text: undefined });
      }
      rememberPointerEntries(
        ctx.conversationId,
        ctx.turnIndex,
        resident.filter(({ slug }) => !isCapabilitySlug(slug)),
      );
      // The turn's selection time, stamped on the resident pairs NOW, in the
      // same synchronous segment as the classification above: the page reads
      // below yield to the event loop, and a prune valve queued by an earlier
      // turn's commit fires on a timer, so it can run while they are awaited
      // and would otherwise rank a pair this turn is about by its stale
      // stamp and evict it. The stamp is a recency bump, not a claim, so a
      // turn whose block never attaches (or that returns null below because
      // every net-new pair rendered empty) bumps harmlessly. Only the first
      // produce stamps: a re-entry re-emits the turn's selections, and a
      // run-messages replacement claims nothing (`resident` is empty there).
      // The net-new pairs take the same time with their record in the commit.
      const selectedAt = Date.now();
      if (firstProduce) {
        touchSelected(ctx.conversationId, resident, selectedAt);
      }

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
      // A block rendered for a run-messages replacement rides that prompt
      // only: no copy of it persists, so the store must not claim its
      // sections and the valve has nothing new to account for.
      if (replaced) {
        return block;
      }
      // The net-new record and the prune-valve schedule are DEFERRED to this
      // commit callback, invoked by runtime assembly at the point where
      // attachment is guaranteed (the turn's tail is a user message, the
      // same gate as metadata capture). Recording here in `produce()` would
      // let a never-attached turn (non-user tail) claim sections in the
      // store, suppressing them until compaction. Only the turn's first
      // produce carries it: a re-entry block re-emits what this one rendered
      // and is never persisted, so it must not record anything. The valve is
      // scheduled after the record so the resident accounting, and the
      // recency it ranks by, include this turn's sections (the resident
      // pairs carry their stamp from the classification above); it evicts by
      // recency with no lane exemptions. It runs on a timer, so this turn's
      // block may not have folded back into the live history when it strips;
      // a section it prunes from this very turn is stripped by assembly Step
      // 0 on the next turn, which applies the store's full tombstone set
      // every turn.
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
          selectedAt,
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
    const remembered = observedTurn(ctx.conversationId, ctx.turnIndex)?.pointer;
    if (!remembered || remembered.length === 0) {
      return null;
    }
    // Re-validate against the store at render time: the sections injector
    // classified these pairs as resident before awaiting its page reads, and
    // a prune valve queued by an earlier turn's commit can fire in that
    // window and tombstone one of them, stripping its body from the live
    // history. A pair no longer active is dropped rather than pointed at; it
    // is simply absent this turn and re-injects on its next selection.
    const active = getActiveSections(ctx.conversationId);
    const entries = remembered.filter(({ slug, key }) =>
      sectionRefSetHas(active, slug, key),
    );
    if (entries.length === 0) {
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
