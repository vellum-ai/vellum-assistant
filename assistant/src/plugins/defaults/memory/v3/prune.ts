/**
 * Memory-v3 prune valve: a structural bound on the resident frozen-section
 * footprint.
 *
 * Frozen sections accumulate in history with no per-turn bound (the injector
 * renders net-new only and never strips prior blocks — the cache contract).
 * The valve is the backstop: when the resident (non-pruned) section bytes
 * exceed `memory.v3.prune.maxResidentBytes`, the least-recently-selected
 * sections are pruned, oldest first, until the footprint is at
 * `targetResidentBytes`. Every section is a candidate: core and hot pages
 * are evicted by recency like any other.
 *
 * Pruning is `markPruned` (the store's audit-preserving tombstone) plus two
 * FILTER points — never a metadata rewrite, so the persisted
 * `metadata.memoryV3InjectedBlock` / `memoryV3PointerBlock` rows stay intact
 * (auditable, and a re-selected section re-injects as a fresh entry because
 * `recordInjected` clears `pruned_at`):
 *
 *   (a) a strip of the pruned sections from the `<memory>` blocks riding
 *       the LIVE in-memory history, and of their lines from the
 *       `<memory_pointer>` blocks that named them
 *       ({@link stripPrunedSectionsFromMessages}; per-section boundaries are
 *       the `# memory/concepts/<slug>.md` / `# memory/concepts/<slug>.md § <key>`
 *       headers within a block, terminated at the next header or at a
 *       non-section chunk such as capability content; see
 *       `parseInjectedSections` in `substrate/injected-block-slugs.ts`). The
 *       strip mutates the shared message objects in place so the agent
 *       loop's end-of-turn history fold-back keeps the stripped content. It
 *       runs with the conversation's full tombstone set at two points: in
 *       the valve itself, and at runtime assembly Step 0 on every turn
 *       (`applyRuntimeInjections`). The valve fires on a timer while the
 *       turn that scheduled it may still be in flight, against a history
 *       that turn's block has not folded back into, so a section pruned on
 *       the turn that injected it can ride back in; the assembly strip
 *       catches it on the next turn, and the live history converges to the
 *       store no matter when the valve ran;
 *   (b) the `loadFromDb` rehydration splice in `daemon/conversation.ts`
 *       re-applies {@link filterResidentSections} and
 *       {@link filterResidentPointerEntries} on every load, so prunes persist
 *       across daemon restarts without touching the metadata.
 *
 * A pruned section that is re-selected re-injects as a fresh entry on a
 * later message, and `recordInjected` clears its tombstone. Its older copies
 * still sit in earlier messages' persisted metadata, so both filter points
 * also keep only each section's NEWEST persisted copy
 * ({@link newestCopyIndexes}): the live conversation holds exactly that one,
 * every earlier copy having been stripped when the section was pruned, and
 * rehydrating an earlier copy beside it would double the section and change
 * the cached prefix. Pointer entries follow the same rule: a line naming a
 * section whose newest copy sits further down predates its re-injection and
 * is dropped.
 *
 * The first post-prune request loses the provider prefix cache from the
 * earliest affected message — ONE amortized bust per prune, logged with
 * `prunedSections` / `bytesFreed`. A pointer always sits after the block of
 * every section it names, so filtering it never widens that bust.
 *
 * v2-coexistence note: v2's dynamic `<memory>` blocks share the exact wrapper
 * and `# memory/concepts/<slug>.md` header convention, and a pre-cutover v2
 * block can even be byte-identical to a v3 lead entry (v2's full-page
 * fallback on a headingless page), so the live strip never decides ownership
 * by text. It owns a block by object identity (`isV3LiveBlock` in
 * `types.ts`): the blocks runtime assembly attaches for the `memory-v3`
 * injector, `loadFromDb` splices from persisted metadata, and the strip
 * writes back in their place. Every other `<memory>` block is left untouched,
 * keeping v2 blocks' unfiltered rehydration byte-identical. The
 * `<memory_pointer>` wrapper is v3-only, so pointer blocks need no ownership
 * test.
 *
 * Capability note: skill / CLI-command content renders under its own
 * `# Skill:` / `# CLI command:` header, not a section header. The injector
 * records capability slugs at `bytes: 0`, which keeps them out of the resident
 * measure AND out of candidacy (zero-byte rows are skipped — pruning them
 * frees nothing), so capability content riding a block survives the prune of
 * its neighboring sections. Both filter points still reach it under the
 * identity the store records it by (its capability slug, empty key): a copy
 * a later block renders again (a post-compaction re-entry copy, once the
 * next turn persists the capability anew) is superseded like a section's.
 *
 * Accounting-drift note: a section whose recorded bytes have no locatable
 * persisted text (e.g. its metadata row was lost) can be planned and
 * tombstoned — the strip/rehydration filter simply finds nothing to remove,
 * its content (if any) stays in context, and its bytes leave the resident
 * accounting with the tombstone. That self-heals in ONE pass: the next valve
 * run measures the corrected footprint, so the valve never loop-fires against
 * bytes it cannot free.
 */

import type { ContentBlock, Message } from "@vellumai/plugin-api";

import { getMemoryConfig } from "../config.js";
import { getLogger } from "../logging.js";
import { memorySqliteOrNull } from "../memory-db.js";
import {
  unwrapMemoryBlock,
  unwrapMemoryPointerBlock,
  wrapMemoryBlock,
  wrapMemoryPointerBlock,
} from "../memory-marker.js";
import { capabilitySlugOf } from "../substrate/capability-slugs.js";
import {
  type InjectedBlock,
  type InjectedBlockFormat,
  type InjectionBlockPiece,
  parseInjectedSectionPath,
  parseInjectedSections,
  readInjectedMetadata,
} from "../substrate/injected-block-slugs.js";
import {
  getActiveEntries,
  getKnownCardBytes,
  getPrunedSections,
  markPruned,
  MEMORY_V3_INJECTED_BLOCK_METADATA_KEY,
  residentBytes,
  type SectionRefSet,
  sectionRefSetHas,
  v3BlockFormatOf,
} from "./ever-injected-store.js";
import {
  markV3LiveBlock,
  sectionKeyTitle,
  type SectionRef,
  v3LiveBlockFormat,
} from "./types.js";

const log = getLogger("memory-v3-shadow");

// ─── pruned-section filtering ────────────────────────────────────────────────

/**
 * Remove pruned sections from an unwrapped block body. `knownCardBytes` (the
 * conversation's recorded lead-entry bytes, see `getKnownCardBytes`) lets the
 * parser split a card frozen before body escaping only at headers whose span
 * is a card the conversation actually froze.
 *
 * Returns the input string UNCHANGED (same reference) when nothing is
 * removed (callers use identity to detect a no-op) and `""` when every
 * chunk is pruned (the caller drops/skips the whole block; a bare
 * instruction header with no sections carries no content). A capability
 * chunk is reached under its capability slug with the empty key (the
 * identity the store records it by); the store never tombstones one, so a
 * block whose sections are all pruned but which carries capability content
 * keeps its preamble and that content. Kept chunks are re-joined exactly as
 * the renderer joined them (`\n\n`), so an unpruned remainder stays
 * byte-identical to what a fresh render of those chunks would produce: the
 * skills hint chunk the renderer adds beside skill chunks leaves with the
 * block's last skill chunk.
 */
export function filterPrunedSections(
  inner: string,
  format: InjectedBlockFormat,
  pruned: SectionRefSet,
  knownCardBytes?: ReadonlyMap<string, number>,
): string {
  return filterSections(
    inner,
    format,
    (slug, key) => sectionRefSetHas(pruned, slug, key),
    knownCardBytes,
  );
}

function refId(slug: string, key: string): string {
  return `${slug}\n${key}`;
}

/** The `(slug, key)` identity a parsed chunk carries in the section store:
 *  a section's own pair, a capability chunk's capability slug under the
 *  empty key, and none for the skills hint chunk. */
function pieceIdentity(
  piece: InjectionBlockPiece,
): { slug: string; key: string } | null {
  switch (piece.kind) {
    case "section":
      return { slug: piece.slug, key: piece.key };
    case "capability":
      return { slug: capabilitySlugOf(piece), key: "" };
    case "other":
      return null;
  }
}

function isSkillChunk(piece: InjectionBlockPiece): boolean {
  return piece.kind === "capability" && piece.capability === "skill";
}

/**
 * A message row's persisted v3 section block, unwrapped and with the
 * rendering format the row's metadata records for it (current when the
 * persisting build stamped `MEMORY_V3_INJECTED_BLOCK_FORMAT_METADATA_KEY`,
 * legacy otherwise), or `null` when the row carries none (or its metadata
 * is malformed): the per-row input of {@link newestCopyIndexes} and the
 * fork seeder, for hosts that reach the block grammar only through this
 * module.
 */
export function persistedV3Block(
  metadata: string | null | undefined,
): InjectedBlock | null {
  const parsed = readInjectedMetadata(metadata);
  const block = parsed?.[MEMORY_V3_INJECTED_BLOCK_METADATA_KEY];
  if (parsed === null || typeof block !== "string") {
    return null;
  }
  return { inner: unwrapMemoryBlock(block), format: v3BlockFormatOf(parsed) };
}

/**
 * The block index carrying each section's and each capability chunk's
 * newest copy, over a conversation's v3 blocks in message order (`null` for
 * a message without one). A section re-injected after a prune has an older
 * copy on an earlier message too, and a capability a post-compaction
 * re-entry rendered in memory gets a persisted copy again when a later turn
 * selects it against the reset store; the live conversation holds only the
 * newest, so rehydration and the live strip keep exactly that copy and treat
 * every earlier one as superseded.
 */
export function newestCopyIndexes(
  blocks: ReadonlyArray<InjectedBlock | null>,
  knownCardBytes?: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const newest = new Map<string, number>();
  blocks.forEach((block, index) => {
    if (block === null) {
      return;
    }
    for (const piece of parseInjectedSections(block.inner, {
      format: block.format,
      knownCardBytes,
    }).pieces) {
      const identity = pieceIdentity(piece);
      if (identity !== null) {
        newest.set(refId(identity.slug, identity.key), index);
      }
    }
  });
  return newest;
}

/**
 * Remove from block `index` of that sequence every section that is pruned or
 * whose newest copy lives on a later block (`newest` from
 * {@link newestCopyIndexes}). Same contract as {@link filterPrunedSections}.
 */
export function filterResidentSections(
  inner: string,
  format: InjectedBlockFormat,
  index: number,
  pruned: SectionRefSet,
  newest: ReadonlyMap<string, number>,
  knownCardBytes?: ReadonlyMap<string, number>,
): string {
  return filterSections(
    inner,
    format,
    (slug, key) =>
      sectionRefSetHas(pruned, slug, key) ||
      (newest.get(refId(slug, key)) ?? index) !== index,
    knownCardBytes,
  );
}

function filterSections(
  inner: string,
  format: InjectedBlockFormat,
  drop: (slug: string, key: string) => boolean,
  knownCardBytes?: ReadonlyMap<string, number>,
): string {
  const { preamble, pieces } = parseInjectedSections(inner, {
    format,
    knownCardBytes,
  });
  if (pieces.length === 0) {
    return inner;
  }

  const survivors = pieces.filter((piece) => {
    const identity = pieceIdentity(piece);
    return identity === null || !drop(identity.slug, identity.key);
  });
  // The renderer adds the skills hint chunk only beside skill chunks, so a
  // block that loses its last one loses the hint with it.
  const kept =
    pieces.some(isSkillChunk) && !survivors.some(isSkillChunk)
      ? survivors.filter((piece) => piece.kind !== "other")
      : survivors;
  if (kept.length === pieces.length) {
    return inner;
  }
  if (kept.length === 0) {
    return "";
  }

  const texts = kept.map((piece) => piece.text);
  if (preamble.length > 0) {
    texts.unshift(preamble);
  }
  return texts.join("\n\n");
}

/**
 * Remove from a WRAPPED `<memory_pointer>` block sitting at `index` (a
 * message index at rehydration, a block index in the live strip) every entry
 * that is pruned or whose section's newest persisted copy sits on a LATER
 * index (`newest` from {@link newestCopyIndexes}): such a pointer predates
 * the section's re-injection, and the live history lost the line when the
 * section was pruned, so restoring it would claim a section that is only in
 * context further down. Same contract as {@link filterPrunedSections}: the
 * input is returned UNCHANGED (same reference) when it is not a pointer block
 * or nothing is dropped, and `""` when every entry line is dropped (the
 * caller drops the block: a pointer with nothing to point at carries no
 * content). The lead line and any other non-path line are kept as-is.
 */
export function filterResidentPointerEntries(
  block: string,
  index: number,
  pruned: SectionRefSet,
  newest: ReadonlyMap<string, number>,
): string {
  const inner = unwrapMemoryPointerBlock(block);
  if (inner === block) {
    return block;
  }
  let entries = 0;
  let kept = 0;
  const lines = inner.split("\n").filter((line) => {
    const ref = parseInjectedSectionPath(line);
    if (ref === null) {
      return true;
    }
    entries += 1;
    if (
      sectionRefSetHas(pruned, ref.slug, ref.key) ||
      (newest.get(refId(ref.slug, ref.key)) ?? index) > index
    ) {
      return false;
    }
    kept += 1;
    return true;
  });
  if (kept === entries) {
    return block;
  }
  if (kept === 0) {
    return "";
  }
  return wrapMemoryPointerBlock(lines.join("\n"));
}

// ─── prune planning ──────────────────────────────────────────────────────────

export interface PrunePlan {
  /** Sections to prune, least-recently-selected first. */
  sections: SectionRef[];
  /** Resident bytes the plan frees once executed. */
  bytesFreed: number;
}

export interface PruneDeps {
  maxResidentBytes: number;
  targetResidentBytes: number;
}

/**
 * Plan a prune for the conversation, or `null` when the resident footprint is
 * within `maxResidentBytes` (or nothing is prunable).
 *
 * The footprint and the candidates both range over the ACTIVE injected
 * sections. Candidates are ranked by last selection recency, read from
 * `memory_v3_selections` over the dedicated memory connection (an unavailable
 * memory database reads as no selection rows): a heading section takes the
 * latest `created_at` of a selection of its page whose `section_title` is
 * that heading (the key decoded through `sectionKeyTitle`, so a chunked or
 * repeated heading shares its title's recency), and a lead section (empty
 * title) takes the latest selection of its page under any title. A section
 * with no matching selection rows (e.g. rows copied or seeded by a fork)
 * falls back to the store's `injected_at`. Candidates are taken oldest-first
 * until the footprint is at `targetResidentBytes`. There are no exemptions;
 * zero-byte rows (capability slugs: dedup-only, no byte accounting) are
 * skipped, since pruning them frees nothing.
 */
export function planPrune(
  deps: PruneDeps,
  conversationId: string,
): PrunePlan | null {
  const activeEntries = getActiveEntries(conversationId);
  const resident = activeEntries.reduce((sum, e) => sum + e.bytes, 0);
  if (resident <= deps.maxResidentBytes) {
    return null;
  }

  const memoryRaw = memorySqliteOrNull("planPrune");
  const selectionRows = memoryRaw
    ? (memoryRaw
        .query(
          /*sql*/ `
      SELECT slug, section_title AS title, MAX(created_at) AS lastSelectedAt
      FROM memory_v3_selections
      WHERE conversation_id = ?
      GROUP BY slug, section_title
    `,
        )
        .all(conversationId) as Array<{
        slug: string;
        title: string | null;
        lastSelectedAt: number;
      }>)
    : [];
  const bySlug = new Map<string, number>();
  const byTitle = new Map<string, number>();
  for (const row of selectionRows) {
    bySlug.set(
      row.slug,
      Math.max(bySlug.get(row.slug) ?? -Infinity, row.lastSelectedAt),
    );
    if (row.title !== null) {
      const id = `${row.slug}\n${row.title}`;
      byTitle.set(
        id,
        Math.max(byTitle.get(id) ?? -Infinity, row.lastSelectedAt),
      );
    }
  }

  const candidates = activeEntries
    .filter((entry) => entry.bytes > 0)
    .map((entry) => {
      const title = sectionKeyTitle(entry.key);
      const lastSelectedAt =
        title.length === 0
          ? bySlug.get(entry.slug)
          : byTitle.get(`${entry.slug}\n${title}`);
      return { ...entry, recency: lastSelectedAt ?? entry.injectedAt };
    })
    // Oldest first; slug then key ascending as the deterministic tiebreak.
    .sort(
      (a, b) =>
        a.recency - b.recency ||
        a.slug.localeCompare(b.slug) ||
        a.key.localeCompare(b.key),
    );

  const sections: SectionRef[] = [];
  let bytesFreed = 0;
  for (const candidate of candidates) {
    if (resident - bytesFreed <= deps.targetResidentBytes) {
      break;
    }
    sections.push({ slug: candidate.slug, key: candidate.key });
    bytesFreed += candidate.bytes;
  }
  return sections.length === 0 ? null : { sections, bytesFreed };
}

// ─── live-history strip ──────────────────────────────────────────────────────

/**
 * The rendering format of the v3-owned `<memory>` block a user message
 * already carries, or `undefined` when it carries none. At a turn's first
 * assembly the tail carries one only when the turn re-runs onto its original
 * anchor row (`/conversations/:id/retry`), rehydrated from the anchor's
 * metadata with the first run's frozen entries.
 */
export function ownedTailBlockFormat(
  message: Message,
): InjectedBlockFormat | undefined {
  for (const block of message.content) {
    const format = block.type === "text" ? v3LiveBlockFormat(block) : undefined;
    if (format !== undefined) {
      return format;
    }
  }
  return undefined;
}

/**
 * Where a turn's net-new section block goes when the tail user message
 * already carries a v3-owned block ({@link ownedTailBlockFormat}):
 *  - `"none"`: it carries none; the block is spliced as on any turn.
 *  - `"merged"`: it carries a current-format block, which took the new
 *    entries: `messages` holds the tail with that block replaced by one
 *    holding the first run's entries followed by the new ones (re-marked
 *    current in the owner's place), and `inner` is the merged block
 *    unwrapped, what the turn persists so every section the store claims
 *    has a body that rehydrates.
 *  - `"legacy"`: it carries a legacy-format block, which cannot take
 *    current-format entries under one metadata key; the caller attaches the
 *    new block in memory only and neither persists nor claims it.
 */
export type AnchorBlockMerge =
  | { kind: "none" }
  | { kind: "legacy" }
  | { kind: "merged"; messages: Message[]; inner: string };

/**
 * Append a turn's net-new section block (`newInner`, unwrapped, as
 * `renderInjectionBlockInner` produced it) to the v3-owned block the tail
 * user message of `messages` already carries; see {@link AnchorBlockMerge}.
 * The new block's entries are taken piece by piece behind its preamble, and
 * its skills hint chunk is dropped when the anchor's block already carries
 * one, so the merged block reads as one render.
 */
export function mergeIntoAnchorBlock(
  messages: Message[],
  newInner: string,
): AnchorBlockMerge {
  const tail = messages[messages.length - 1];
  if (!tail || tail.role !== "user") {
    return { kind: "none" };
  }
  const index = tail.content.findIndex(
    (block) => block.type === "text" && v3LiveBlockFormat(block) !== undefined,
  );
  if (index === -1) {
    return { kind: "none" };
  }
  const owned = tail.content[index]!;
  if (owned.type !== "text" || v3LiveBlockFormat(owned) !== "current") {
    return { kind: "legacy" };
  }
  const existing = unwrapMemoryBlock(owned.text);
  const hasHint = parseInjectedSections(existing, {
    format: "current",
  }).pieces.some((piece) => piece.kind === "other");
  const appended = parseInjectedSections(newInner, { format: "current" })
    .pieces.filter((piece) => !(hasHint && piece.kind === "other"))
    .map((piece) => piece.text);
  if (appended.length === 0) {
    return { kind: "none" };
  }
  const inner = [existing, ...appended].join("\n\n");
  const merged = markV3LiveBlock(
    { type: "text" as const, text: wrapMemoryBlock(inner) },
    "current",
  );
  return {
    kind: "merged",
    messages: [
      ...messages.slice(0, -1),
      {
        ...tail,
        content: [
          ...tail.content.slice(0, index),
          merged,
          ...tail.content.slice(index + 1),
        ],
      },
    ],
    inner,
  };
}

/**
 * Strip pruned sections from the live in-memory history: for every
 * `<memory>` text block memory-v3 owns (by object identity, see the module
 * doc), drop the pruned sections and any copy superseded by a newer one
 * later in the history, and for every `<memory_pointer>` block drop the
 * lines naming pruned sections; a block left with no sections (or no pointer
 * entries) is removed outright (matching the rehydration splice, which skips
 * such a block). A rewritten block is registered in the owner's place.
 *
 * Idempotent over the full tombstone set, so the valve and runtime assembly
 * Step 0 (every turn) both call it with `getPrunedSections`; a history the
 * valve already stripped is walked and left as is. Mutates the affected
 * `Message` objects IN PLACE (`message.content` reassignment): the agent
 * loop's working arrays share these object references, so its end-of-turn
 * history fold-back keeps the strip. Returns the number of blocks changed.
 * `knownCardBytes` is the conversation's recorded frozen card lengths
 * (`getKnownCardBytes`).
 */
export function stripPrunedSectionsFromMessages(
  messages: Message[],
  pruned: SectionRefSet,
  knownCardBytes?: ReadonlyMap<string, number>,
): number {
  // A v3-owned `<memory>` block's inner text with the format the registry
  // recorded for it, or `null` for any other block.
  const ownedBlock = (block: ContentBlock): InjectedBlock | null => {
    if (block.type !== "text") {
      return null;
    }
    const format = v3LiveBlockFormat(block);
    return format === undefined
      ? null
      : { inner: unwrapMemoryBlock(block.text), format };
  };
  // Owned blocks in history order, so each section's newest live copy is
  // known before any block is filtered.
  const owned: Array<InjectedBlock | null> = [];
  for (const message of messages) {
    if (message.role === "user") {
      for (const block of message.content) {
        owned.push(ownedBlock(block));
      }
    }
  }
  const newest = newestCopyIndexes(owned, knownCardBytes);

  let strippedBlocks = 0;
  let ownedIndex = 0;
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    let changed = false;
    const nextContent: ContentBlock[] = [];
    for (const block of message.content) {
      const index = ownedIndex++;
      const ownedHere = owned[index] ?? null;
      if (block.type !== "text") {
        nextContent.push(block);
        continue;
      }
      if (ownedHere === null) {
        const pointer = filterResidentPointerEntries(
          block.text,
          index,
          pruned,
          newest,
        );
        if (pointer === block.text) {
          nextContent.push(block);
          continue;
        }
        strippedBlocks += 1;
        changed = true;
        if (pointer.length > 0) {
          nextContent.push({ type: "text", text: pointer });
        }
        continue;
      }
      const filtered = filterResidentSections(
        ownedHere.inner,
        ownedHere.format,
        index,
        pruned,
        newest,
        knownCardBytes,
      );
      if (filtered === ownedHere.inner) {
        nextContent.push(block);
        continue;
      }
      strippedBlocks += 1;
      changed = true;
      if (filtered.length > 0) {
        nextContent.push(
          markV3LiveBlock(
            { type: "text", text: wrapMemoryBlock(filtered) },
            ownedHere.format,
          ),
        );
      }
    }
    if (changed) {
      message.content = nextContent;
    }
  }
  return strippedBlocks;
}

// ─── valve execution & trigger ───────────────────────────────────────────────

export interface PruneValveOptions {
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
    await import("../../../../daemon/conversation-registry.js");
  return findConversationOrSubagent(conversationId)?.messages ?? null;
}

/**
 * Run the prune valve once: plan against `memory.v3.prune` config, mark the
 * planned sections pruned, and strip them from the live in-memory history.
 * Returns the executed plan, or `null` when the footprint is within bounds
 * (the common case, repeated invocations below the cap are no-ops).
 *
 * The live strip filters with the conversation's FULL pruned set (not just
 * this plan's sections). A block not yet folded back into the live history
 * when the valve runs (the turn that scheduled it still in flight) keeps
 * its pruned sections until the next runtime assembly, whose Step 0 applies
 * the same full-set strip.
 */
export async function runPruneValve(
  conversationId: string,
  options: PruneValveOptions = {},
): Promise<PrunePlan | null> {
  // Defensive read: test configs may omit the prune block entirely.
  const pruneConfig = getMemoryConfig()?.v3?.prune;
  if (!pruneConfig) {
    return null;
  }

  // Planning needs only the store (cheap): a conversation within the cap
  // never pays for more than that (the common case).
  const plan = planPrune(
    {
      maxResidentBytes: pruneConfig.maxResidentBytes,
      targetResidentBytes: pruneConfig.targetResidentBytes,
    },
    conversationId,
  );
  if (!plan) {
    return null;
  }

  markPruned(conversationId, plan.sections, options.now ?? Date.now());

  const liveMessages = options.liveMessages
    ? options.liveMessages(conversationId)
    : await defaultLiveMessages(conversationId);
  let strippedBlocks = 0;
  if (liveMessages) {
    strippedBlocks = stripPrunedSectionsFromMessages(
      liveMessages,
      getPrunedSections(conversationId),
      getKnownCardBytes(conversationId),
    );
  }

  log.info(
    {
      conversationId,
      prunedSections: plan.sections.length,
      bytesFreed: plan.bytesFreed,
      strippedBlocks,
      residentBytes: residentBytes(conversationId),
    },
    "memory-v3 prune valve: pruned least-recently-selected sections (one amortized prefix-cache bust)",
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
  options: PruneValveOptions = {},
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
