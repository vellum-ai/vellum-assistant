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
 *   (a) a one-time strip of the pruned sections from the `<memory>` blocks
 *       riding the LIVE in-memory history, and of their lines from the
 *       `<memory_pointer>` blocks that named them
 *       ({@link stripPrunedSectionsFromMessages}; per-section boundaries are
 *       the `# memory/concepts/<slug>.md` / `# memory/concepts/<slug>.md § <key>`
 *       headers within a block, terminated at the next header or at a
 *       non-section chunk such as capability content; see
 *       `parseInjectedSections` in `substrate/injected-block-slugs.ts`). The
 *       strip mutates the shared message objects in place so the agent
 *       loop's end-of-turn history fold-back keeps the stripped content;
 *   (b) the `loadFromDb` rehydration splice in `daemon/conversation.ts`
 *       re-applies {@link filterPrunedSections} and
 *       {@link filterPrunedPointerEntries} on every load, so prunes persist
 *       across daemon restarts without touching the metadata.
 *
 * The first post-prune request loses the provider prefix cache from the
 * earliest affected message — ONE amortized bust per prune, logged with
 * `prunedSections` / `bytesFreed`. A pointer always sits after the block of
 * every section it names, so filtering it never widens that bust.
 *
 * v2-coexistence note: v2's dynamic `<memory>` blocks share the exact wrapper
 * and `# memory/concepts/<slug>.md` header convention, so the live strip
 * cannot tell layers apart syntactically. A block is treated as v3-owned only
 * when EVERY section in it byte-matches a section of some persisted
 * `memoryV3InjectedBlock` for the conversation
 * ({@link collectPersistedV3Sections}), v2 sections render the page SUMMARY
 * (or full page) rather than an injected section, so pre-flip v2 blocks never
 * qualify and are left untouched, keeping their unfiltered rehydration
 * byte-identical. The `<memory_pointer>` wrapper is v3-only, so pointer
 * blocks need no ownership test.
 *
 * Capability note: skill / CLI-command content renders under its own
 * `# Skill:` / `# CLI command:` header, not a section header, so it can
 * never be located (and therefore never stripped) by slug. The injector
 * records capability slugs at `bytes: 0`, which keeps them out of the resident
 * measure AND out of candidacy (zero-byte rows are skipped — pruning them
 * frees nothing); capability content riding a block survives the prune of
 * its neighboring sections as a non-section chunk.
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

import { getDb, getSqliteFrom } from "../../../../persistence/db-connection.js";
import { getMemoryConfig } from "../config.js";
import { getLogger } from "../logging.js";
import { memorySqliteOrNull } from "../memory-db.js";
import {
  unwrapMemoryBlock,
  unwrapMemoryPointerBlock,
  wrapMemoryBlock,
  wrapMemoryPointerBlock,
} from "../memory-marker.js";
import {
  parseInjectedSectionPath,
  parseInjectedSections,
  readInjectedBlock,
} from "../substrate/injected-block-slugs.js";
import {
  getActiveEntries,
  getKnownSlugs,
  getPrunedSections,
  markPruned,
  MEMORY_V3_INJECTED_BLOCK_METADATA_KEY,
  residentBytes,
  type SectionRefSet,
  sectionRefSetHas,
} from "./ever-injected-store.js";
import { sectionKeyTitle, type SectionRef } from "./types.js";

const log = getLogger("memory-v3-shadow");

// ─── pruned-section filtering ────────────────────────────────────────────────

/**
 * Remove pruned sections from an unwrapped block body. `knownSlugs` (the
 * conversation's recorded slugs, see `getKnownSlugs`) lets the parser split a
 * card frozen before body escaping only at headers naming recorded pages.
 *
 * Returns the input string UNCHANGED (same reference) when nothing is
 * removed — callers use identity to detect a no-op — and `""` when every
 * chunk is pruned (the caller drops/skips the whole block; a bare
 * instruction header with no sections carries no content). Non-section
 * chunks (capability content) are always kept, so a block whose sections are
 * all pruned but which carries capability content keeps its preamble and
 * that content. Kept chunks are re-joined exactly as the renderer joined
 * them (`\n\n`), so an unpruned remainder stays byte-identical to what a
 * fresh render of those chunks would produce.
 */
export function filterPrunedSections(
  inner: string,
  pruned: SectionRefSet,
  knownSlugs?: ReadonlySet<string>,
): string {
  const { preamble, sections, pieces } = parseInjectedSections(inner, {
    knownSlugs,
  });
  if (sections.length === 0) {
    return inner;
  }

  const kept = pieces.filter(
    (piece) =>
      piece.kind !== "section" ||
      !sectionRefSetHas(pruned, piece.slug, piece.key),
  );
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
 * Remove pruned sections' lines from a WRAPPED `<memory_pointer>` block, so
 * the pointer never claims a section is in context after the valve removed
 * it. Same contract as {@link filterPrunedSections}: the input is returned
 * UNCHANGED (same reference) when it is not a pointer block or names no
 * pruned section, and `""` when every entry line is pruned (the caller drops
 * the block: a pointer with nothing to point at carries no content). The
 * lead line and any other non-path line are kept as-is.
 */
export function filterPrunedPointerEntries(
  block: string,
  pruned: SectionRefSet,
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
    if (sectionRefSetHas(pruned, ref.slug, ref.key)) {
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
 * Collect the conversation's known v3 SECTION TEXTS from every persisted
 * `metadata.memoryV3InjectedBlock` row — the live strip's v3-ownership test:
 * a live `<memory>` block is v3-owned iff all of its sections appear here
 * (see the module doc's v2-coexistence note). Capability chunks never
 * contribute: their content renders under `# Skill:` / `# CLI command:`
 * headers, which parse as non-section chunks. `knownSlugs` defaults to the
 * conversation's recorded slugs; the valve passes the set it already read.
 */
export function collectPersistedV3Sections(
  conversationId: string,
  knownSlugs: ReadonlySet<string> = getKnownSlugs(conversationId),
): Set<string> {
  // Substring prefilter (indexable LIKE) mirrors the Slack metadata scan;
  // rows are validated by `readInjectedBlock`'s JSON parse.
  const rows = getSqliteFrom(getDb())
    .query(
      /*sql*/ `
      -- Any-state scan: only metadata markers are read, and the marker is
      -- written by the injection path on rows it owns regardless of state.
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
    if (block === null) {
      continue;
    }
    for (const section of parseInjectedSections(unwrapMemoryBlock(block), {
      knownSlugs,
    }).sections) {
      sections.add(section.text);
    }
  }
  return sections;
}

/**
 * One-time strip of pruned sections from the live in-memory history: for
 * every v3-owned `<memory>` text block (ownership per `knownV3Sections`, see
 * the module doc), drop the pruned sections, and for every `<memory_pointer>`
 * block drop the lines naming them; a block left with no sections (or no
 * pointer entries) is removed outright (matching the rehydration splice,
 * which skips such a block).
 *
 * Mutates the affected `Message` objects IN PLACE (`message.content`
 * reassignment): the agent loop's working arrays share these object
 * references, so its end-of-turn history fold-back keeps the strip. Returns
 * the number of blocks changed. `knownSlugs` is the conversation's recorded
 * slug set, parsed with the same set the ownership texts were collected
 * under.
 */
export function stripPrunedSectionsFromMessages(
  messages: Message[],
  pruned: SectionRefSet,
  knownV3Sections: ReadonlySet<string>,
  knownSlugs?: ReadonlySet<string>,
): number {
  let strippedBlocks = 0;
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    let changed = false;
    const nextContent: ContentBlock[] = [];
    for (const block of message.content) {
      if (block.type !== "text") {
        nextContent.push(block);
        continue;
      }
      const pointer = filterPrunedPointerEntries(block.text, pruned);
      if (pointer !== block.text) {
        strippedBlocks += 1;
        changed = true;
        if (pointer.length > 0) {
          nextContent.push({ type: "text", text: pointer });
        }
        continue;
      }
      const inner = unwrapMemoryBlock(block.text);
      if (inner === block.text) {
        // Not a wrapped `<memory>` block (unwrap is identity on anything
        // without the full wrapper pair).
        nextContent.push(block);
        continue;
      }
      const { sections } = parseInjectedSections(inner, { knownSlugs });
      const isV3Block =
        sections.length > 0 &&
        sections.every((section) => knownV3Sections.has(section.text));
      if (!isV3Block) {
        nextContent.push(block);
        continue;
      }
      const filtered = filterPrunedSections(inner, pruned, knownSlugs);
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
 * this plan's sections), so a section an earlier strip could not reach,
 * e.g. a block not yet folded back into the live history when that prune
 * ran, self-heals on the next prune.
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

  // Planning needs only the store (cheap); the persisted-metadata scan for
  // the live strip's ownership test runs only once a plan exists — a
  // conversation within the cap never pays it (the common case).
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
    const knownSlugs = getKnownSlugs(conversationId);
    strippedBlocks = stripPrunedSectionsFromMessages(
      liveMessages,
      getPrunedSections(conversationId),
      collectPersistedV3Sections(conversationId, knownSlugs),
      knownSlugs,
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
