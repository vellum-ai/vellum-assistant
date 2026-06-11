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
 *       `# memory/concepts/<slug>.md` headers within a block, terminated at
 *       any other top-level header chunk such as capability content; see
 *       {@link parseCardSections}). The strip mutates the shared message
 *       objects in place so the agent loop's end-of-turn history fold-back
 *       keeps the stripped content;
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
 * ({@link collectPersistedV3Cards}) — v2 sections render the page SUMMARY
 * (or full page) rather than the card head+TOC, so pre-flip v2 blocks never
 * qualify and are left untouched, keeping their unfiltered rehydration
 * byte-identical.
 *
 * Capability note: skill / CLI-command content renders under its own
 * `# Skill:` / `# CLI command:` header — not a card section — so it can never
 * be located (and therefore never stripped) by slug. The injector records
 * capability slugs at `bytes: 0`, which keeps them out of the resident
 * measure AND out of candidacy (zero-byte rows are skipped — pruning them
 * frees nothing); capability content riding a card block survives the prune
 * of its neighboring cards as a non-card chunk.
 *
 * Accounting-drift note: a slug whose recorded bytes have no locatable
 * persisted card section (e.g. its metadata row was lost) can be planned and
 * tombstoned — the strip/rehydration filter simply finds nothing to remove,
 * its content (if any) stays in context, and its bytes leave the resident
 * accounting with the tombstone. That self-heals in ONE pass: the next valve
 * run measures the corrected footprint, so the valve never loop-fires against
 * bytes it cannot free.
 */

import { getConfig } from "../../../config/loader.js";
import { getDb, getSqliteFrom } from "../../../memory/db-connection.js";
import {
  unwrapMemoryBlock,
  wrapMemoryBlock,
} from "../../../memory/memory-marker.js";
import {
  INJECTED_CONCEPT_HEADER_REGEX,
  readInjectedBlock,
} from "../../../memory/v2/injected-block-slugs.js";
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

/** Matches any top-level `# ` header line — concept card headers AND foreign
 *  headers like a capability chunk's `# Skill:` / `# CLI command:` line. */
const TOP_LEVEL_HEADER_REGEX = /^# /gm;

/** One parsed card section: the header line plus everything up to the next
 *  chunk boundary (or end of block), trailing whitespace removed. */
export interface CardSection {
  slug: string;
  /** The section text INCLUDING its `# memory/concepts/<slug>.md` header
   *  line, `trimEnd()`ed so re-joining with `\n\n` reproduces the renderer's
   *  exact bytes. */
  text: string;
}

/** One ordered chunk of a parsed card block: a concept card (prunable, owned
 *  by `slug`) or any other `\n\n`-joined chunk (e.g. capability content under
 *  its own `# Skill:` / `# CLI command:` header — never prunable). */
export type CardBlockPiece =
  | { kind: "card"; slug: string; text: string }
  | { kind: "other"; text: string };

/**
 * Split an UNWRAPPED card-block body into its preamble (the instruction
 * header — everything before the first boundary), the ordered chunk pieces,
 * and the card sections (the `kind: "card"` pieces, kept as a convenience
 * view). Returns zero sections/pieces when the text carries no concept card
 * headers.
 *
 * A card's section ends at the next concept header OR at any other top-level
 * `# ` header that starts its own `\n\n`-joined chunk — so a capability chunk
 * trailing a concept card (`renderCardsBlockInner` joins them with `\n\n`) is
 * parsed as a separate non-card piece instead of being absorbed into the
 * card, and pruning the card never deletes it. The blank-line requirement
 * keeps a card head's own `# Title` line (which follows the path header with
 * a single `\n`) from splitting the card, and guarantees splits land on the
 * renderer's `\n\n` seams so re-joins stay byte-identical.
 */
export function parseCardSections(inner: string): {
  preamble: string;
  sections: CardSection[];
  pieces: CardBlockPiece[];
} {
  const cardMatches = [...inner.matchAll(INJECTED_CONCEPT_HEADER_REGEX)];
  if (cardMatches.length === 0) {
    return { preamble: inner, sections: [], pieces: [] };
  }

  const cardStarts = new Set(cardMatches.map((match) => match.index!));
  const boundaries: Array<{ index: number; slug: string | null }> =
    cardMatches.map((match) => ({ index: match.index!, slug: match[1]! }));
  for (const match of inner.matchAll(TOP_LEVEL_HEADER_REGEX)) {
    const i = match.index!;
    if (cardStarts.has(i)) continue;
    // Foreign header on a `\n\n` seam → starts its own chunk.
    if (i >= 2 && inner[i - 1] === "\n" && inner[i - 2] === "\n") {
      boundaries.push({ index: i, slug: null });
    }
  }
  boundaries.sort((a, b) => a.index - b.index);

  const preamble = inner.slice(0, boundaries[0]!.index).trimEnd();
  const pieces = boundaries.map((boundary, i): CardBlockPiece => {
    const end =
      i + 1 < boundaries.length ? boundaries[i + 1]!.index : undefined;
    const text = inner.slice(boundary.index, end).trimEnd();
    return boundary.slug === null
      ? { kind: "other", text }
      : { kind: "card", slug: boundary.slug, text };
  });
  const sections = pieces.filter(
    (piece): piece is Extract<CardBlockPiece, { kind: "card" }> =>
      piece.kind === "card",
  );
  return { preamble, sections, pieces };
}

/**
 * Remove pruned slugs' card sections from an unwrapped block body.
 *
 * Returns the input string UNCHANGED (same reference) when nothing is
 * removed — callers use identity to detect a no-op — and `""` when every
 * chunk is pruned (the caller drops/skips the whole block; a bare
 * instruction header with no cards carries no content). Non-card chunks
 * (capability content) are always kept, so a block whose concept cards are
 * all pruned but which carries capability content keeps its preamble and
 * that content. Kept chunks are re-joined exactly as the renderer joined
 * them (`\n\n`), so an unpruned remainder stays byte-identical to what a
 * fresh render of those chunks would produce.
 */
export function filterPrunedCardSections(
  inner: string,
  prunedSlugs: ReadonlySet<string>,
): string {
  const { preamble, sections, pieces } = parseCardSections(inner);
  if (sections.length === 0) return inner;

  const kept = pieces.filter(
    (piece) => piece.kind !== "card" || !prunedSlugs.has(piece.slug),
  );
  if (kept.length === pieces.length) return inner;
  if (kept.length === 0) return "";

  const texts = kept.map((piece) => piece.text);
  if (preamble.length > 0) texts.unshift(preamble);
  return texts.join("\n\n");
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
 * The footprint and the candidates both range over the ACTIVE injected slugs.
 * Candidates are ranked by last selection recency — `MAX(created_at)` per
 * slug from `memory_v3_selections`, falling back to the store's `injected_at`
 * for slugs with no selection rows (e.g. rows copied by a full fork) — taken
 * oldest-first until the footprint is at `targetResidentBytes`. Core/hot lane
 * members are exempt, and zero-byte rows (capability slugs, truncated-fork
 * seeds: dedup-only, no byte accounting) are skipped — pruning them frees
 * nothing while discarding inherited context.
 */
export function planPrune(
  deps: PruneDeps,
  conversationId: string,
): PrunePlan | null {
  const activeEntries = getActiveEntries(conversationId);
  const resident = activeEntries.reduce((sum, e) => sum + e.bytes, 0);
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

  const candidates = activeEntries
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
 * Collect the conversation's known v3 card SECTION TEXTS from every persisted
 * `metadata.memoryV3InjectedBlock` row — the live strip's v3-ownership test:
 * a live `<memory>` block is v3-owned iff all of its card sections appear
 * here (see the module doc's v2-coexistence note). Capability chunks never
 * contribute: their content renders under `# Skill:` / `# CLI command:`
 * headers, which parse as non-card chunks.
 */
export function collectPersistedV3Cards(conversationId: string): Set<string> {
  // Substring prefilter (indexable LIKE) mirrors the Slack metadata scan;
  // rows are validated by `readInjectedBlock`'s JSON parse.
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
    const block = readInjectedBlock(
      row.metadata,
      MEMORY_V3_INJECTED_BLOCK_METADATA_KEY,
    );
    if (block === null) continue;
    for (const section of parseCardSections(unwrapMemoryBlock(block))
      .sections) {
      sections.add(section.text);
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
      if (block.type !== "text") {
        nextContent.push(block);
        continue;
      }
      const inner = unwrapMemoryBlock(block.text);
      if (inner === block.text) {
        // Not a wrapped `<memory>` block (unwrap is identity on anything
        // without the full wrapper pair).
        nextContent.push(block);
        continue;
      }
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

  // Planning needs only the store (cheap); the persisted-metadata scan for
  // the live strip's ownership test runs only once a plan exists — a
  // conversation within the cap never pays it (the common case).
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
      collectPersistedV3Cards(conversationId),
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
