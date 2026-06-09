/**
 * Memory-v3 prune valve: a structural bound on the resident frozen-card
 * footprint.
 *
 * Frozen cards accumulate in history with no per-turn bound (the injector
 * renders net-new only and never strips prior blocks — the cache contract).
 * The valve is the backstop: when the resident (non-pruned) card bytes exceed
 * `memory.v3.prune.maxResidentBytes`, the least-recently-selected
 * non-core/non-hot cards are pruned, oldest first, until the footprint is at
 * `targetResidentBytes`.
 *
 * Pruning is `markPruned` (the store's audit-preserving tombstone) plus two
 * FILTER points — never a metadata rewrite, so the persisted
 * `metadata.memoryV3InjectedBlock` rows stay intact (auditable, and a
 * re-selected slug re-injects as a fresh card because `recordInjected` clears
 * `pruned_at`):
 *
 *   (a) a one-time strip of the pruned cards' sections from the `<memory>`
 *       blocks riding the LIVE in-memory history
 *       ({@link stripPrunedCardsFromMessages} — per-card boundaries are the
 *       `# memory/concepts/<slug>.md` headers within a block). The strip
 *       mutates the shared message objects in place so the agent loop's
 *       end-of-turn history fold-back keeps the stripped content;
 *   (b) the `loadFromDb` rehydration splice in `daemon/conversation.ts`
 *       re-applies {@link filterPrunedCardSections} on every load, so prunes
 *       persist across daemon restarts without touching the metadata.
 *
 * The first post-prune request loses the provider prefix cache from the
 * earliest affected message — ONE amortized bust per prune, logged with
 * `prunedSlugs` / `bytesFreed`.
 *
 * v2-coexistence note: v2's dynamic `<memory>` blocks share the exact wrapper
 * and `# memory/concepts/<slug>.md` header convention, so the live strip
 * cannot tell layers apart syntactically. A block is treated as v3-owned only
 * when EVERY card section in it byte-matches a section of some persisted
 * `memoryV3InjectedBlock` for the conversation
 * ({@link collectPersistedV3CardSections}) — v2 sections render the page
 * SUMMARY (or full page) rather than the card head+TOC, so pre-flip v2 blocks
 * never qualify and are left untouched, keeping their unfiltered rehydration
 * byte-identical.
 */

import { getConfig } from "../../../config/loader.js";
import { getDb, getSqliteFrom } from "../../../memory/db-connection.js";
import {
  unwrapMemoryBlock,
  wrapMemoryBlock,
} from "../../../memory/memory-marker.js";
import type { ContentBlock, Message } from "../../../providers/types.js";
import { getLogger } from "../../../util/logger.js";
import {
  getActiveEntries,
  getPrunedSlugs,
  markPruned,
  MEMORY_V3_INJECTED_BLOCK_METADATA_KEY,
  residentBytes,
} from "./ever-injected-store.js";

const log = getLogger("memory-v3-shadow");

// ─── card-section parsing & filtering ────────────────────────────────────────

/** Matches a card's path-header line; capture group 1 is the page slug. */
const CARD_HEADER_REGEX = /^# memory\/concepts\/(.+)\.md$/gm;

/** One parsed card section: the header line plus everything up to the next
 *  card header (or end of block), trailing whitespace removed. */
export interface CardSection {
  slug: string;
  /** The section text INCLUDING its `# memory/concepts/<slug>.md` header
   *  line, `trimEnd()`ed so re-joining with `\n\n` reproduces the renderer's
   *  exact bytes. */
  text: string;
}

/**
 * Split an UNWRAPPED card-block body into its preamble (the instruction
 * header — everything before the first card header) and per-card sections.
 * Returns zero sections when the text carries no card headers.
 */
export function parseCardSections(inner: string): {
  preamble: string;
  sections: CardSection[];
} {
  const matches = [...inner.matchAll(CARD_HEADER_REGEX)];
  if (matches.length === 0) return { preamble: inner, sections: [] };

  const preamble = inner.slice(0, matches[0]!.index).trimEnd();
  const sections = matches.map((match, i) => {
    const end = i + 1 < matches.length ? matches[i + 1]!.index : inner.length;
    return { slug: match[1]!, text: inner.slice(match.index, end).trimEnd() };
  });
  return { preamble, sections };
}

/**
 * Remove pruned slugs' card sections from an unwrapped block body.
 *
 * Returns the input string UNCHANGED (same reference) when nothing is
 * removed — callers use identity to detect a no-op — and `""` when every
 * card section is pruned (the caller drops/skips the whole block; a bare
 * instruction header with no cards carries no content). Kept sections are
 * re-joined exactly as the renderer joined them (`\n\n`), so an unpruned
 * remainder stays byte-identical to what a fresh render of those cards would
 * produce.
 */
export function filterPrunedCardSections(
  inner: string,
  prunedSlugs: ReadonlySet<string>,
): string {
  const { preamble, sections } = parseCardSections(inner);
  if (sections.length === 0) return inner;

  const kept = sections.filter((section) => !prunedSlugs.has(section.slug));
  if (kept.length === sections.length) return inner;
  if (kept.length === 0) return "";

  const pieces = kept.map((section) => section.text);
  if (preamble.length > 0) pieces.unshift(preamble);
  return pieces.join("\n\n");
}

// ─── prune planning ──────────────────────────────────────────────────────────

export interface PrunePlan {
  /** Slugs to prune, least-recently-selected first. */
  slugs: string[];
  /** Resident bytes the plan frees once executed. */
  bytesFreed: number;
}

export interface PruneDeps {
  maxResidentBytes: number;
  targetResidentBytes: number;
  /** Core + hot lane members — the selector's stable prefix must never be
   *  pruned out from under it. */
  exemptSlugs: ReadonlySet<string>;
}

/**
 * Plan a prune for the conversation, or `null` when the resident footprint is
 * within `maxResidentBytes` (or nothing is prunable).
 *
 * Candidates are the ACTIVE injected slugs ranked by last selection recency —
 * `MAX(created_at)` per slug from `memory_v3_selections`, falling back to the
 * store's `injected_at` for slugs with no selection rows (e.g. rows copied by
 * a full fork) — taken oldest-first until the resident footprint is at
 * `targetResidentBytes`. Core/hot lane members are exempt, and zero-byte rows
 * (truncated-fork seeds: dedup-only, no byte accounting) are skipped — pruning
 * them frees nothing while discarding inherited context.
 */
export function planPrune(
  deps: PruneDeps,
  conversationId: string,
): PrunePlan | null {
  const resident = residentBytes(conversationId);
  if (resident <= deps.maxResidentBytes) return null;

  const selectionRows = getSqliteFrom(getDb())
    .query(
      /*sql*/ `
      SELECT slug, MAX(created_at) AS lastSelectedAt FROM memory_v3_selections
      WHERE conversation_id = ?
      GROUP BY slug
    `,
    )
    .all(conversationId) as Array<{ slug: string; lastSelectedAt: number }>;
  const lastSelectedAt = new Map(
    selectionRows.map((row) => [row.slug, row.lastSelectedAt]),
  );

  const candidates = getActiveEntries(conversationId)
    .filter((entry) => entry.bytes > 0 && !deps.exemptSlugs.has(entry.slug))
    .map((entry) => ({
      ...entry,
      recency: lastSelectedAt.get(entry.slug) ?? entry.injectedAt,
    }))
    // Oldest first; slug ascending as the deterministic tiebreak.
    .sort((a, b) => a.recency - b.recency || (a.slug < b.slug ? -1 : 1));

  const slugs: string[] = [];
  let bytesFreed = 0;
  for (const candidate of candidates) {
    if (resident - bytesFreed <= deps.targetResidentBytes) break;
    slugs.push(candidate.slug);
    bytesFreed += candidate.bytes;
  }
  return slugs.length === 0 ? null : { slugs, bytesFreed };
}

// ─── live-history strip ──────────────────────────────────────────────────────

/**
 * The conversation's known v3 card sections, collected from every persisted
 * `metadata.memoryV3InjectedBlock` row. The live strip's v3-ownership test:
 * a live `<memory>` block is v3-owned iff all of its card sections appear in
 * this set (see the module doc's v2-coexistence note).
 */
export function collectPersistedV3CardSections(
  conversationId: string,
): Set<string> {
  // Substring prefilter (indexable LIKE) mirrors the Slack metadata scan;
  // rows are validated by the JSON parse below.
  const rows = getSqliteFrom(getDb())
    .query(
      /*sql*/ `
      SELECT metadata FROM messages
      WHERE conversation_id = ? AND metadata LIKE '%' || ? || '%'
    `,
    )
    .all(conversationId, MEMORY_V3_INJECTED_BLOCK_METADATA_KEY) as Array<{
    metadata: string | null;
  }>;

  const sections = new Set<string>();
  for (const row of rows) {
    if (!row.metadata) continue;
    try {
      const meta = JSON.parse(row.metadata) as Record<string, unknown>;
      const block = meta[MEMORY_V3_INJECTED_BLOCK_METADATA_KEY];
      if (typeof block !== "string") continue;
      for (const section of parseCardSections(unwrapMemoryBlock(block))
        .sections) {
        sections.add(section.text);
      }
    } catch {
      /* malformed metadata rows are skipped */
    }
  }
  return sections;
}

/**
 * One-time strip of pruned cards from the live in-memory history: for every
 * v3-owned `<memory>` text block (ownership per `knownV3Sections` — see the
 * module doc), drop the pruned slugs' card sections; a block whose cards are
 * all pruned is removed outright (matching the rehydration splice, which
 * skips an all-pruned block).
 *
 * Mutates the affected `Message` objects IN PLACE (`message.content`
 * reassignment): the agent loop's working arrays share these object
 * references, so its end-of-turn history fold-back keeps the strip. Returns
 * the number of blocks changed.
 */
export function stripPrunedCardsFromMessages(
  messages: Message[],
  prunedSlugs: ReadonlySet<string>,
  knownV3Sections: ReadonlySet<string>,
): number {
  let strippedBlocks = 0;
  for (const message of messages) {
    if (message.role !== "user") continue;
    let changed = false;
    const nextContent: ContentBlock[] = [];
    for (const block of message.content) {
      if (
        block.type !== "text" ||
        !block.text.startsWith("<memory>\n") ||
        !block.text.endsWith("\n</memory>")
      ) {
        nextContent.push(block);
        continue;
      }
      const inner = unwrapMemoryBlock(block.text);
      const { sections } = parseCardSections(inner);
      const isV3Block =
        sections.length > 0 &&
        sections.every((section) => knownV3Sections.has(section.text));
      if (!isV3Block) {
        nextContent.push(block);
        continue;
      }
      const filtered = filterPrunedCardSections(inner, prunedSlugs);
      if (filtered === inner) {
        nextContent.push(block);
        continue;
      }
      strippedBlocks += 1;
      changed = true;
      if (filtered.length > 0) {
        nextContent.push({ type: "text", text: wrapMemoryBlock(filtered) });
      }
    }
    if (changed) message.content = nextContent;
  }
  return strippedBlocks;
}

// ─── valve execution & trigger ───────────────────────────────────────────────

export interface PruneValveOptions {
  /** Core + hot lane members (never pruned). */
  exemptSlugs: ReadonlySet<string>;
  /** Test seam: resolve the conversation's LIVE in-memory message array.
   *  Defaults to the daemon conversation registry (dynamically imported — a
   *  static import would cycle with `daemon/conversation.ts`, which imports
   *  this module for the rehydration filter). `null` skips the live strip
   *  (the rehydration filter still applies the prune on next load). */
  liveMessages?: (conversationId: string) => Message[] | null;
  /** Test seam for the `pruned_at` timestamp. */
  now?: number;
}

async function defaultLiveMessages(
  conversationId: string,
): Promise<Message[] | null> {
  const { findConversationOrSubagent } =
    await import("../../../daemon/conversation-registry.js");
  return findConversationOrSubagent(conversationId)?.messages ?? null;
}

/**
 * Run the prune valve once: plan against `memory.v3.prune` config, mark the
 * planned slugs pruned, and strip their cards from the live in-memory
 * history. Returns the executed plan, or `null` when the footprint is within
 * bounds (the common case — repeated invocations below the cap are no-ops).
 *
 * The live strip filters with the conversation's FULL pruned set (not just
 * this plan's slugs), so a card an earlier strip could not reach — e.g. a
 * block not yet folded back into the live history when that prune ran —
 * self-heals on the next prune.
 */
export async function runPruneValve(
  conversationId: string,
  options: PruneValveOptions,
): Promise<PrunePlan | null> {
  // Defensive read: test configs may omit the prune block entirely.
  const pruneConfig = getConfig().memory?.v3?.prune;
  if (!pruneConfig) return null;

  const plan = planPrune(
    {
      maxResidentBytes: pruneConfig.maxResidentBytes,
      targetResidentBytes: pruneConfig.targetResidentBytes,
      exemptSlugs: options.exemptSlugs,
    },
    conversationId,
  );
  if (!plan) return null;

  markPruned(conversationId, plan.slugs, options.now ?? Date.now());

  const liveMessages = options.liveMessages
    ? options.liveMessages(conversationId)
    : await defaultLiveMessages(conversationId);
  let strippedBlocks = 0;
  if (liveMessages) {
    strippedBlocks = stripPrunedCardsFromMessages(
      liveMessages,
      getPrunedSlugs(conversationId),
      collectPersistedV3CardSections(conversationId),
    );
  }

  log.info(
    {
      conversationId,
      prunedSlugs: plan.slugs.length,
      bytesFreed: plan.bytesFreed,
      strippedBlocks,
      residentBytes: residentBytes(conversationId),
    },
    "memory-v3 prune valve: pruned least-recently-selected cards (one amortized prefix-cache bust)",
  );
  return plan;
}

/** Pending valve work, chained so runs serialize per process and tests can
 *  await completion ({@link flushPruneValveForTests}). */
let pendingPrune: Promise<unknown> = Promise.resolve();

/**
 * End-of-turn trigger: defer a {@link runPruneValve} pass so prune work never
 * delays the in-flight turn's assembly. Failures are logged and swallowed —
 * the valve must never affect the live turn.
 */
export function schedulePruneValve(
  conversationId: string,
  options: PruneValveOptions,
): void {
  pendingPrune = pendingPrune
    .then(() => new Promise((resolve) => setTimeout(resolve, 0)))
    .then(() => runPruneValve(conversationId, options))
    .catch((err) => {
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          conversationId,
        },
        "memory-v3 prune valve failed (non-fatal)",
      );
    });
}

/** Await all scheduled valve work (deterministic teardown for tests). */
export function flushPruneValveForTests(): Promise<void> {
  return pendingPrune.then(() => undefined);
}
