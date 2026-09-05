/**
 * Per-conversation record of memory-v3's injected sections.
 *
 * Backed by `memory_v3_injected_sections`, which lives on the dedicated memory
 * connection (`assistant-memory.db`): every read/write resolves it via
 * `memoryDbOrNull` and degrades to a no-op when that connection is
 * unavailable. One row per (conversation, page slug, section key) the v3
 * injector ever attached: the key is the section's `sectionKey()`, `""` for a
 * page's lead and for capability content (skills and CLI commands inject
 * whole). The active (non-pruned) rows are the injection dedup record: a pair
 * present here rides the cached message prefix and must not be re-rendered.
 * `bytes` sums into the resident footprint the prune valve bounds. Rows are
 * never deleted by pruning (`pruned_at` is set instead) so the record stays
 * auditable; a pruned section that is re-selected re-injects by clearing
 * `pruned_at` on upsert. `clearConversation` is the compaction reset: the
 * cached blocks those sections lived on are gone, so future turns are free to
 * re-inject them.
 *
 * Fork semantics mirror v2's activation-store hooks. The fork copy runs on the
 * memory connection, so it is not atomic with the main-DB `forkConversation()`
 * transaction that drives it: a best-effort copy that no-ops when the memory
 * database is unavailable.
 *   - full-history forks copy the parent's rows wholesale
 *     (`forkEverInjected`), pruned state included;
 *   - truncated forks seed from the section headers scanned out of the
 *     inherited messages' persisted blocks (`seedEverInjectedFromBlocks`): a
 *     wholesale copy would over-claim sections injected on turns the child
 *     does not contain, suppressing their re-injection forever.
 */

import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";

import { memoryV3InjectedSections } from "../../../../persistence/schema/index.js";
import { getLogger } from "../logging.js";
import { memoryDbOrNull } from "../memory-db.js";
import { unwrapMemoryBlock } from "../memory-marker.js";
import { parseInjectedSections } from "../substrate/injected-block-slugs.js";
import { renderedBytes } from "./card.js";
import type { SectionRef } from "./types.js";

const log = getLogger("memory-v3-ever-injected-store");

/**
 * Message-metadata key the v3 injector persists each turn's section block
 * under (the v3 counterpart of v2's `memoryInjectedBlock`). Shared by the
 * writer, the conversation-load rehydration splice, and the truncated-fork
 * seed scan so all three agree on the key.
 */
export const MEMORY_V3_INJECTED_BLOCK_METADATA_KEY = "memoryV3InjectedBlock";

/**
 * A set of section refs keyed by slug, the shape the dedup and prune filters
 * consume: `slug → keys`. Built by {@link getActiveSections} and
 * {@link getPrunedSections}; membership via {@link sectionRefSetHas}.
 */
export type SectionRefSet = ReadonlyMap<string, ReadonlySet<string>>;

/** Whether `(slug, key)` is a member of the set. */
export function sectionRefSetHas(
  set: SectionRefSet,
  slug: string,
  key: string,
): boolean {
  return set.get(slug)?.has(key) ?? false;
}

function toSectionRefSet(rows: SectionRef[]): Map<string, Set<string>> {
  const set = new Map<string, Set<string>>();
  for (const row of rows) {
    let keys = set.get(row.slug);
    if (!keys) {
      keys = new Set();
      set.set(row.slug, keys);
    }
    keys.add(row.key);
  }
  return set;
}

/** One row of the record, pruned or resident. */
export interface InjectedSectionRow extends SectionRef {
  bytes: number;
  /** Epoch ms the section was (last) injected. */
  injectedAt: number;
  /** Epoch ms the prune valve removed the section, or `null` while resident. */
  prunedAt: number | null;
}

/**
 * Run a read against the memory connection, degrading to `fallback` when the
 * connection is unavailable or the statement fails (a missing table on an
 * install whose migration is still deferred, an I/O error). A read failure
 * must never take memory-v3 down with it: an empty dedup set re-injects a
 * section at worst, while a throw inside `observeTurn` would skip the turn's
 * memory entirely.
 */
function readOr<T>(
  context: string,
  fallback: T,
  read: (mdb: NonNullable<ReturnType<typeof memoryDbOrNull>>) => T,
): T {
  try {
    const mdb = memoryDbOrNull(context);
    return mdb ? read(mdb) : fallback;
  } catch (err) {
    log.warn({ err, context }, "injected-section read failed; continuing");
    return fallback;
  }
}

/**
 * The full per-conversation record, pruned rows included, ordered by
 * `(slug, key)`. Test oracle only: no production code path reads it;
 * production consumers use the narrower accessors ({@link getActiveSections},
 * {@link getActiveEntries}, {@link getPrunedSections}, {@link residentBytes}).
 */
export function getInjected(conversationId: string): InjectedSectionRow[] {
  return readOr("getInjected", [], (mdb) =>
    mdb
      .select({
        slug: memoryV3InjectedSections.slug,
        key: memoryV3InjectedSections.sectionKey,
        bytes: memoryV3InjectedSections.bytes,
        injectedAt: memoryV3InjectedSections.injectedAt,
        prunedAt: memoryV3InjectedSections.prunedAt,
      })
      .from(memoryV3InjectedSections)
      .where(eq(memoryV3InjectedSections.conversationId, conversationId))
      .orderBy(
        memoryV3InjectedSections.slug,
        memoryV3InjectedSections.sectionKey,
      )
      .all(),
  );
}

function selectRefs(
  conversationId: string,
  pruned: boolean,
  context: string,
): SectionRef[] {
  return readOr(context, [], (mdb) =>
    mdb
      .select({
        slug: memoryV3InjectedSections.slug,
        key: memoryV3InjectedSections.sectionKey,
      })
      .from(memoryV3InjectedSections)
      .where(
        and(
          eq(memoryV3InjectedSections.conversationId, conversationId),
          pruned
            ? isNotNull(memoryV3InjectedSections.prunedAt)
            : isNull(memoryV3InjectedSections.prunedAt),
        ),
      )
      .all(),
  );
}

/** The injection dedup set: sections currently resident, keyed by slug. */
export function getActiveSections(conversationId: string): SectionRefSet {
  return toSectionRefSet(
    selectRefs(conversationId, false, "getActiveSections"),
  );
}

/** One active (resident) row of the prune valve's candidate set. */
export interface ActiveInjectedEntry extends SectionRef {
  bytes: number;
  /** Epoch ms the section was (last) injected: the recency fallback for
   *  sections with no matching selection rows (e.g. rows copied by a full
   *  fork). */
  injectedAt: number;
}

/**
 * Active (non-pruned) rows with byte and injection-time accounting: the prune
 * valve's candidate set ({@link ActiveInjectedEntry}).
 */
export function getActiveEntries(
  conversationId: string,
): ActiveInjectedEntry[] {
  return readOr("getActiveEntries", [], (mdb) =>
    mdb
      .select({
        slug: memoryV3InjectedSections.slug,
        key: memoryV3InjectedSections.sectionKey,
        bytes: memoryV3InjectedSections.bytes,
        injectedAt: memoryV3InjectedSections.injectedAt,
      })
      .from(memoryV3InjectedSections)
      .where(
        and(
          eq(memoryV3InjectedSections.conversationId, conversationId),
          isNull(memoryV3InjectedSections.prunedAt),
        ),
      )
      .all(),
  );
}

/**
 * Sections currently marked pruned, keyed by slug: the skip set shared by the
 * live-history strip and the `loadFromDb` rehydration filter (see `prune.ts`
 * / `daemon/conversation.ts`).
 */
export function getPrunedSections(conversationId: string): SectionRefSet {
  return toSectionRefSet(selectRefs(conversationId, true, "getPrunedSections"));
}

/**
 * Upsert this turn's injected sections. Re-recording an existing pair clears
 * `pruned_at` and refreshes `bytes`/`injected_at`: a pruned section that is
 * re-selected re-injects as a fresh entry.
 */
export function recordInjected(
  conversationId: string,
  entries: Array<SectionRef & { bytes: number }>,
  at: number = Date.now(),
): void {
  if (entries.length === 0) {
    return;
  }
  // Best-effort: a derived injection-accounting write must never abort the
  // agent turn, so a degraded memory connection or a failed statement only
  // logs a warning.
  try {
    const mdb = memoryDbOrNull("recordInjected");
    if (!mdb) {
      return;
    }
    for (const entry of entries) {
      mdb
        .insert(memoryV3InjectedSections)
        .values({
          conversationId,
          slug: entry.slug,
          sectionKey: entry.key,
          injectedAt: at,
          bytes: entry.bytes,
          prunedAt: null,
        })
        .onConflictDoUpdate({
          target: [
            memoryV3InjectedSections.conversationId,
            memoryV3InjectedSections.slug,
            memoryV3InjectedSections.sectionKey,
          ],
          set: { injectedAt: at, bytes: entry.bytes, prunedAt: null },
        })
        .run();
    }
  } catch (err) {
    log.warn({ err }, "failed to record injected sections; continuing");
  }
}

/**
 * Mark sections pruned from the live context. Rows are never deleted: the
 * record stays auditable and the sections stay eligible for re-injection.
 */
export function markPruned(
  conversationId: string,
  refs: SectionRef[],
  at: number,
): void {
  if (refs.length === 0) {
    return;
  }
  try {
    const mdb = memoryDbOrNull("markPruned");
    if (!mdb) {
      return;
    }
    mdb
      .update(memoryV3InjectedSections)
      .set({ prunedAt: at })
      .where(
        and(
          eq(memoryV3InjectedSections.conversationId, conversationId),
          or(
            ...refs.map((ref) =>
              and(
                eq(memoryV3InjectedSections.slug, ref.slug),
                eq(memoryV3InjectedSections.sectionKey, ref.key),
              ),
            ),
          ),
        ),
      )
      .run();
  } catch (err) {
    log.warn({ err }, "failed to mark injected sections pruned; continuing");
  }
}

/**
 * Delete the conversation's entire record. Compaction reset: the cached
 * blocks are gone from history, so every section must become re-injectable.
 */
export function clearConversation(conversationId: string): void {
  try {
    const mdb = memoryDbOrNull("clearConversation");
    if (!mdb) {
      return;
    }
    mdb
      .delete(memoryV3InjectedSections)
      .where(eq(memoryV3InjectedSections.conversationId, conversationId))
      .run();
  } catch (err) {
    log.warn(
      { err },
      "failed to clear injected-section record for conversation; continuing",
    );
  }
}

/** Total bytes of resident (non-pruned) sections: the prune-valve input. */
export function residentBytes(conversationId: string): number {
  return readOr(
    "residentBytes",
    0,
    (mdb) =>
      mdb
        .select({
          total: sql<number>`COALESCE(SUM(${memoryV3InjectedSections.bytes}), 0)`,
        })
        .from(memoryV3InjectedSections)
        .where(
          and(
            eq(memoryV3InjectedSections.conversationId, conversationId),
            isNull(memoryV3InjectedSections.prunedAt),
          ),
        )
        .get()?.total ?? 0,
  );
}

/**
 * Copy the parent conversation's rows to a new conversation id, pruned state
 * included. No-op if the parent has no rows. Full-history forks only;
 * truncated forks must use {@link seedEverInjectedFromBlocks} instead.
 *
 * The rows live on the memory connection, so this writes there rather than on
 * the main fork transaction's handle. The copy is best-effort: an unavailable
 * memory database is a no-op.
 */
export function forkEverInjected(
  parentConversationId: string,
  newConversationId: string,
): void {
  try {
    const mdb = memoryDbOrNull("forkEverInjected");
    if (!mdb) {
      return;
    }
    const parentRows = mdb
      .select({
        slug: memoryV3InjectedSections.slug,
        sectionKey: memoryV3InjectedSections.sectionKey,
        injectedAt: memoryV3InjectedSections.injectedAt,
        bytes: memoryV3InjectedSections.bytes,
        prunedAt: memoryV3InjectedSections.prunedAt,
      })
      .from(memoryV3InjectedSections)
      .where(eq(memoryV3InjectedSections.conversationId, parentConversationId))
      .all();
    for (const row of parentRows) {
      mdb
        .insert(memoryV3InjectedSections)
        .values({ conversationId: newConversationId, ...row })
        .onConflictDoUpdate({
          target: [
            memoryV3InjectedSections.conversationId,
            memoryV3InjectedSections.slug,
            memoryV3InjectedSections.sectionKey,
          ],
          set: {
            injectedAt: row.injectedAt,
            bytes: row.bytes,
            prunedAt: row.prunedAt,
          },
        })
        .run();
    }
  } catch (err) {
    log.warn({ err }, "failed to fork injected-section record; continuing");
  }
}

/**
 * Seed a truncated fork's record from the sections whose blocks the child
 * actually inherited: the `# memory/concepts/<slug>.md § <key>` and lead
 * headers scanned out of the copied messages' persisted
 * `MEMORY_V3_INJECTED_BLOCK_METADATA_KEY` blocks (`blocks`, unwrapped or
 * wrapped; the header grammar is the same either way). Mirrors
 * `seedForkActivationState`: a wholesale copy would over-claim, while seeding
 * nothing would re-attach every inherited section as a duplicate.
 *
 * Rows are stamped `injected_at = at` and `bytes` = the byte length of the
 * section's span in the inherited block (header through body, the measure
 * `recordInjected` takes from the live render), so the child's resident
 * accounting starts at what it actually inherited and the valve can evict an
 * inherited section like any other. A section present in several inherited
 * blocks (re-injected after a prune) takes its latest span, mirroring the
 * upsert. Capability chunks carry no concept header and are not seeded,
 * matching the injector's zero-byte treatment of them.
 *
 * The parent's `pruned_at` tombstones are carried over: pruning leaves the
 * persisted metadata block intact and relies on the tombstone to filter the
 * section out at rehydration, so the metadata scan feeding this seed
 * necessarily sees pruned sections too. Seeding those as active would
 * resurrect parent-pruned sections in the child on its next load (and
 * diverge from the full-fork copy path, which preserves tombstones). A
 * tombstoned seed keeps the child's rehydrated view identical to the parent's
 * live view at fork time; re-selection clears the tombstone and re-injects,
 * same as in the parent.
 *
 * No-op when the child inherited no blocks. The rows live on the memory
 * connection, so this writes there rather than on the main fork transaction's
 * handle, and an unavailable memory database is a best-effort no-op.
 */
export function seedEverInjectedFromBlocks(
  parentConversationId: string,
  newConversationId: string,
  blocks: string[],
  at: number,
): void {
  const inherited = new Map<string, SectionRef & { bytes: number }>();
  for (const block of blocks) {
    for (const section of parseInjectedSections(unwrapMemoryBlock(block))
      .sections) {
      inherited.set(`${section.slug} ${section.key}`, {
        slug: section.slug,
        key: section.key,
        bytes: renderedBytes(section.text),
      });
    }
  }
  if (inherited.size === 0) {
    return;
  }
  try {
    const mdb = memoryDbOrNull("seedEverInjectedFromBlocks");
    if (!mdb) {
      return;
    }
    const prunedRows = mdb
      .select({
        slug: memoryV3InjectedSections.slug,
        key: memoryV3InjectedSections.sectionKey,
        prunedAt: memoryV3InjectedSections.prunedAt,
      })
      .from(memoryV3InjectedSections)
      .where(
        and(
          eq(memoryV3InjectedSections.conversationId, parentConversationId),
          isNotNull(memoryV3InjectedSections.prunedAt),
        ),
      )
      .all();
    const parentPrunedAt = new Map(
      prunedRows.map((r) => [`${r.slug} ${r.key}`, r.prunedAt]),
    );
    for (const [id, { slug, key, bytes }] of inherited) {
      mdb
        .insert(memoryV3InjectedSections)
        .values({
          conversationId: newConversationId,
          slug,
          sectionKey: key,
          injectedAt: at,
          bytes,
          prunedAt: parentPrunedAt.get(id) ?? null,
        })
        .onConflictDoNothing({
          target: [
            memoryV3InjectedSections.conversationId,
            memoryV3InjectedSections.slug,
            memoryV3InjectedSections.sectionKey,
          ],
        })
        .run();
    }
  } catch (err) {
    log.warn(
      { err },
      "failed to seed forked injected-section record; continuing",
    );
  }
}
