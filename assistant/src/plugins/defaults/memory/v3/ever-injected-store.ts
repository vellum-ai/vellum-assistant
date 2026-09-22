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
 * `bytes` sums into the resident footprint the prune valve bounds, and
 * `last_selected_at` is the recency the valve ranks by: the injector stamps
 * it on every section the turn selected, the resident ones through
 * `touchSelected` as soon as it classifies them and the net-new ones through
 * `recordInjected` at its commit, so each section ages from its own latest
 * selection (`injected_at` stands in for a row with no stamp). Rows are
 * never deleted by pruning (`pruned_at` is set
 * instead) so the record stays auditable; a pruned section that is
 * re-selected re-injects by clearing `pruned_at` on upsert.
 * `clearConversation` is the compaction reset: the cached blocks those
 * sections lived on are gone, so future turns are free to re-inject them; it
 * takes the conversation's legacy card rows with it (`plugin-schema.ts`), so
 * no later copy re-imports them.
 *
 * Fork semantics mirror v2's activation-store hooks. The fork copy runs on the
 * memory connection, so it is not atomic with the main-DB `forkConversation()`
 * transaction that drives it: a best-effort copy that no-ops when the memory
 * database is unavailable.
 *   - full-history forks copy the parent's rows wholesale
 *     (`forkEverInjected`), pruned state included;
 *   - truncated forks seed from the section headers scanned out of the
 *     inherited messages' persisted current-format blocks
 *     (`seedEverInjectedFromBlocks`): a wholesale copy would over-claim
 *     sections injected on turns the child does not contain, suppressing
 *     their re-injection forever.
 */

import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";

import { memoryV3InjectedSections } from "../../../../persistence/schema/index.js";
import { getLogger } from "../logging.js";
import { memoryDbOrNull } from "../memory-db.js";
import { unwrapMemoryBlock } from "../memory-marker.js";
import { capabilitySlugOf } from "../substrate/capability-slugs.js";
import {
  parseInjectedSections,
  renderedBytes,
} from "../substrate/injected-block-slugs.js";
import {
  deleteLegacyCardRows,
  ensureMemoryV3InjectedSectionsSchemaOnce,
  memoryReader,
} from "./plugin-schema.js";
import {
  type InjectedBlock,
  type InjectedBlockFormat,
  type SectionRef,
  sectionRefId,
} from "./types.js";

const log = getLogger("memory-v3-ever-injected-store");

/** The memory connection every read and write resolves, its table ensured
 *  first (`plugin-schema.ts`, which also copies the legacy card rows in);
 *  `null`, with the degraded-mode warning, when the connection is
 *  unavailable. */
function memoryDb(context: string): ReturnType<typeof memoryDbOrNull> {
  const mdb = memoryDbOrNull(context);
  if (mdb) {
    ensureMemoryV3InjectedSectionsSchemaOnce(mdb.$client);
  }
  return mdb;
}

/**
 * Message-metadata key the v3 injector persists each turn's section block
 * under (the v3 counterpart of v2's `memoryInjectedBlock`). Shared by the
 * writer, the conversation-load rehydration splice, and the truncated-fork
 * seed scan so all three agree on the key.
 */
export const MEMORY_V3_INJECTED_BLOCK_METADATA_KEY = "memoryV3InjectedBlock";

/**
 * Message-metadata key the persisting build stamps beside
 * `MEMORY_V3_INJECTED_BLOCK_METADATA_KEY`: the block's rendering format
 * ({@link MEMORY_V3_INJECTED_BLOCK_FORMAT}). A row carrying the section block
 * without it was persisted before the stamp existed and holds a legacy card
 * block (`InjectedBlockFormat` in `./types.ts`).
 */
export const MEMORY_V3_INJECTED_BLOCK_FORMAT_METADATA_KEY =
  "memoryV3InjectedBlockFormat";

/**
 * The format this build renders and stamps (section headers plus body
 * escaping, the grammar of `substrate/injected-block-slugs.ts`), and the
 * value {@link v3BlockFormatOf} compares a row's stamp against. No other
 * value is ever written: a build that changes the grammar bumps this and
 * extends that classification to the rows the earlier value marks.
 */
export const MEMORY_V3_INJECTED_BLOCK_FORMAT = 2;

/** The rendering format a message row's metadata records for its v3 section
 *  block: current when its stamp equals this build's
 *  {@link MEMORY_V3_INJECTED_BLOCK_FORMAT}, legacy for a row without one. */
export function v3BlockFormatOf(
  metadata: Readonly<Record<string, unknown>>,
): InjectedBlockFormat {
  return metadata[MEMORY_V3_INJECTED_BLOCK_FORMAT_METADATA_KEY] ===
    MEMORY_V3_INJECTED_BLOCK_FORMAT
    ? "current"
    : "legacy";
}

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
interface InjectedSectionRow extends SectionRef {
  bytes: number;
  /** Epoch ms the section was (last) injected. */
  injectedAt: number;
  /** Epoch ms of the latest turn that selected the section, or `null` for a
   *  row no turn has stamped (see {@link ActiveInjectedEntry}). */
  lastSelectedAt: number | null;
  /** Epoch ms the prune valve removed the section, or `null` while resident. */
  prunedAt: number | null;
}

/** The store's fail-soft read (`plugin-schema.ts`): a throw inside
 *  `observeTurn` would skip the turn's memory entirely, so a failed read
 *  degrades to its fallback instead. */
const readOr = memoryReader(memoryDb, (err, context) =>
  log.warn({ err, context }, "injected-section read failed; continuing"),
);

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
        lastSelectedAt: memoryV3InjectedSections.lastSelectedAt,
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
  /** Epoch ms the section was (last) injected: the recency the prune valve
   *  falls back to for a row with no `lastSelectedAt`. */
  injectedAt: number;
  /** Epoch ms of the latest turn that selected the section, net-new or
   *  already resident: the prune valve's recency. `null` for a row no turn
   *  has stamped (a truncated fork's seeded row, or one written before the
   *  column existed). */
  lastSelectedAt: number | null;
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
        lastSelectedAt: memoryV3InjectedSections.lastSelectedAt,
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
 * Upsert this turn's injected sections, each stamped `last_selected_at = at`
 * (the turn that injects a section selected it). Re-recording an existing
 * pair clears `pruned_at` and refreshes `bytes`, `injected_at`, and the
 * stamp: a pruned section that is re-selected re-injects as a fresh entry on
 * the current message. Its older
 * copies stay in earlier messages' persisted metadata; rehydration and the
 * live strip keep only the newest persisted copy of a pair
 * (`newestCopyIndexes` in `prune.ts`), so clearing the tombstone never
 * revives them.
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
    const mdb = memoryDb("recordInjected");
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
          lastSelectedAt: at,
          bytes: entry.bytes,
          prunedAt: null,
        })
        .onConflictDoUpdate({
          target: [
            memoryV3InjectedSections.conversationId,
            memoryV3InjectedSections.slug,
            memoryV3InjectedSections.sectionKey,
          ],
          set: {
            injectedAt: at,
            lastSelectedAt: at,
            bytes: entry.bytes,
            prunedAt: null,
          },
        })
        .run();
    }
  } catch (err) {
    log.warn({ err }, "failed to record injected sections; continuing");
  }
}

/** Composite keys per statement of a `(slug, key)`-addressed update. Each
 *  key is one `OR` term, and SQLite caps expression depth at 1000, so a ref
 *  list of any size is applied in batches well under that. */
const REF_KEY_BATCH_SIZE = 100;

/**
 * Apply `set` to the conversation's rows named by `refs`, in
 * {@link REF_KEY_BATCH_SIZE}-key batches inside one transaction, so a list of
 * any size neither exceeds SQLite's expression-depth limit nor leaves a
 * partially applied update. Best-effort like every store write: a degraded
 * memory connection or a failed statement logs `failureMessage` and leaves
 * the rows as they were. A ref with no row is a no-op.
 */
function updateRefs(
  context: string,
  conversationId: string,
  refs: SectionRef[],
  set: Partial<typeof memoryV3InjectedSections.$inferInsert>,
  failureMessage: string,
): void {
  if (refs.length === 0) {
    return;
  }
  try {
    const mdb = memoryDb(context);
    if (!mdb) {
      return;
    }
    mdb.transaction((tx) => {
      for (let i = 0; i < refs.length; i += REF_KEY_BATCH_SIZE) {
        const batch = refs.slice(i, i + REF_KEY_BATCH_SIZE);
        tx.update(memoryV3InjectedSections)
          .set(set)
          .where(
            and(
              eq(memoryV3InjectedSections.conversationId, conversationId),
              or(
                ...batch.map((ref) =>
                  and(
                    eq(memoryV3InjectedSections.slug, ref.slug),
                    eq(memoryV3InjectedSections.sectionKey, ref.key),
                  ),
                ),
              ),
            ),
          )
          .run();
      }
    });
  } catch (err) {
    log.warn({ err }, failureMessage);
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
  updateRefs(
    "markPruned",
    conversationId,
    refs,
    { prunedAt: at },
    "failed to mark injected sections pruned; continuing",
  );
}

/**
 * Stamp `last_selected_at = at` on the sections a turn selected that were
 * already resident (the injector's pointer entries and its resident
 * capability units): the prune valve's recency, so a section re-selected
 * turn after turn is never evicted as stale. The injector stamps them in the
 * same synchronous segment that classifies them, so a valve already queued
 * never ranks the stale stamp in between. The turn's net-new sections take
 * the stamp from {@link recordInjected} instead.
 */
export function touchSelected(
  conversationId: string,
  refs: SectionRef[],
  at: number,
): void {
  updateRefs(
    "touchSelected",
    conversationId,
    refs,
    { lastSelectedAt: at },
    "failed to stamp selected sections; continuing",
  );
}

/**
 * Delete the conversation's entire record, its legacy card rows included
 * ({@link deleteLegacyCardRows}: a copy that runs after the reset must not
 * bring them back). Compaction reset: the cached blocks are gone from
 * history, so every section must become re-injectable. Both deletes ride
 * one transaction, so a failed reset leaves the record whole rather than
 * half-cleared. Returns whether the record is clear: `true` once the rows are
 * deleted, or when there is no memory database to hold any; `false` when the
 * delete fails and the record still claims its sections.
 */
export function clearConversation(conversationId: string): boolean {
  try {
    const mdb = memoryDb("clearConversation");
    if (!mdb) {
      return true;
    }
    mdb.transaction((tx) => {
      tx.delete(memoryV3InjectedSections)
        .where(eq(memoryV3InjectedSections.conversationId, conversationId))
        .run();
      // The legacy table has no schema object: a raw statement on the
      // transaction's own connection, inside it.
      deleteLegacyCardRows(mdb.$client, conversationId);
    });
    return true;
  } catch (err) {
    log.warn(
      { err },
      "failed to clear injected-section record for conversation; continuing",
    );
    return false;
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
    const mdb = memoryDb("forkEverInjected");
    if (!mdb) {
      return;
    }
    const parentRows = mdb
      .select({
        slug: memoryV3InjectedSections.slug,
        sectionKey: memoryV3InjectedSections.sectionKey,
        injectedAt: memoryV3InjectedSections.injectedAt,
        lastSelectedAt: memoryV3InjectedSections.lastSelectedAt,
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
            lastSelectedAt: row.lastSelectedAt,
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
 * `MEMORY_V3_INJECTED_BLOCK_METADATA_KEY` blocks (`blocks`, each with the
 * format its row's metadata records, see `persistedV3Block` in `prune.ts`;
 * a wrapped body is unwrapped). Mirrors
 * `seedForkActivationState`: a wholesale copy would over-claim, while seeding
 * nothing would re-attach every inherited section as a duplicate.
 *
 * Rows are stamped `injected_at = at`, with no `last_selected_at` (no turn of
 * the child has selected them; the valve ranks them by `injected_at` until
 * one does), and `bytes` = the byte length of the section's span in the
 * inherited block (header through body, the measure `recordInjected` takes
 * from the live render), so the child's resident accounting starts at what it
 * actually inherited and the valve can evict an inherited section like any
 * other. A section present in several inherited
 * blocks (re-injected after a prune) takes its latest span, mirroring the
 * upsert. An inherited capability chunk (`# Skill: ` / `# CLI command: `)
 * seeds its capability slug exactly as the injector records one: under the
 * empty key at zero bytes, dedup-only, so the child never re-injects
 * capability content that already rides its inherited history.
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
 * A legacy-format block (a pre-stamp row's) seeds nothing: the child
 * rehydrates it with no tombstone of its own for the cards it holds, and a
 * later selection of a section it holds injects that section afresh, which
 * supersedes the card at the next strip; accepted for the one-time window
 * such rows live in (they leave with the child's first compaction).
 *
 * No-op when the child inherited no current-format blocks. The rows live on
 * the memory connection, so this writes there rather than on the main fork
 * transaction's handle, and an unavailable memory database is a best-effort
 * no-op.
 */
export function seedEverInjectedFromBlocks(
  parentConversationId: string,
  newConversationId: string,
  blocks: ReadonlyArray<InjectedBlock>,
  at: number,
): void {
  const inherited = new Map<string, SectionRef & { bytes: number }>();
  for (const block of blocks) {
    if (block.format === "legacy") {
      continue;
    }
    for (const piece of parseInjectedSections(unwrapMemoryBlock(block.inner))
      .pieces) {
      if (piece.kind === "section") {
        inherited.set(sectionRefId(piece), {
          slug: piece.slug,
          key: piece.key,
          bytes: renderedBytes(piece.text),
        });
      } else if (piece.kind === "capability") {
        const ref = { slug: capabilitySlugOf(piece), key: "" };
        inherited.set(sectionRefId(ref), { ...ref, bytes: 0 });
      }
    }
  }
  if (inherited.size === 0) {
    return;
  }
  try {
    const mdb = memoryDb("seedEverInjectedFromBlocks");
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
      prunedRows.map((r) => [sectionRefId(r), r.prunedAt]),
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
