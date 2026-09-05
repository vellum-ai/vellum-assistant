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
import {
  memoryDbOrNull,
  type MemorySqlite,
  memorySqliteOrNull,
} from "../memory-db.js";
import { unwrapMemoryBlock } from "../memory-marker.js";
import { capabilitySlugOf } from "../substrate/capability-slugs.js";
import {
  type InjectedBlock,
  type InjectedBlockFormat,
  parseInjectedSections,
  renderedBytes,
} from "../substrate/injected-block-slugs.js";
import { ensureMemoryV3InjectedSectionsSchema } from "./plugin-schema.js";
import type { SectionRef } from "./types.js";

const log = getLogger("memory-v3-ever-injected-store");

/** Connections whose `memory_v3_injected_sections` schema this process has
 *  ensured. */
const ensuredConnections = new WeakSet<MemorySqlite>();
let ensureWarned = false;

/**
 * Ensure the store's table on `raw` once per connection in this process
 * (see `plugin-schema.ts`, which also copies the legacy card rows in):
 * idempotent DDL, fail-open. A failed ensure warns once and leaves the
 * statement that follows to fail soft like any other; a reopened connection
 * is ensured again.
 */
function ensureSectionsSchemaOnce(raw: MemorySqlite): void {
  if (ensuredConnections.has(raw)) {
    return;
  }
  try {
    ensureMemoryV3InjectedSectionsSchema(raw);
    ensuredConnections.add(raw);
  } catch (err) {
    if (!ensureWarned) {
      ensureWarned = true;
      log.warn(
        { err },
        "failed to ensure memory_v3_injected_sections; section record degraded",
      );
    }
  }
}

/**
 * Ensure the store's table on the memory connection of this process, for the
 * memory plugin's `init` hook. No-op when the connection is unavailable (the
 * store degrades to no-ops as on any turn).
 */
export function ensureMemoryV3InjectedSectionsStore(): void {
  const raw = memorySqliteOrNull("ensureMemoryV3InjectedSectionsStore");
  if (raw) {
    ensureSectionsSchemaOnce(raw);
  }
}

/** The memory connection every read and write resolves, its table ensured
 *  first ({@link ensureSectionsSchemaOnce}); `null`, with the degraded-mode
 *  warning, when the connection is unavailable. */
function memoryDb(context: string): ReturnType<typeof memoryDbOrNull> {
  const raw = memorySqliteOrNull(context);
  if (!raw) {
    return null;
  }
  ensureSectionsSchemaOnce(raw);
  return memoryDbOrNull(context);
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
 * without it was persisted before the stamp existed and holds a legacy
 * compact-card block, which the parser reads by the card shape and the
 * conversation's frozen card lengths (`InjectedBlockFormat` in
 * `substrate/injected-block-slugs.ts`).
 */
export const MEMORY_V3_INJECTED_BLOCK_FORMAT_METADATA_KEY =
  "memoryV3InjectedBlockFormat";

/** The format this build renders and stamps: section headers plus body
 *  escaping. */
export const MEMORY_V3_INJECTED_BLOCK_FORMAT = 2;

/** The rendering format a message row's metadata records for its v3 section
 *  block: current when the persisting build stamped the format key, legacy
 *  otherwise. */
export function v3BlockFormatOf(
  metadata: Readonly<Record<string, unknown>>,
): InjectedBlockFormat {
  return typeof metadata[MEMORY_V3_INJECTED_BLOCK_FORMAT_METADATA_KEY] ===
    "number"
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
    const mdb = memoryDb(context);
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
 * The frozen length (`frozen_card_bytes`) of each lead entry (key `""`) that
 * carries one for the conversation, resident or pruned: the block parser's
 * `knownCardBytes` for the conversation's persisted blocks. For a card frozen
 * before body escaping it is the exact length that build's injector measured
 * for the whole card (the store's schema ensure carries it over from `memory_v3_ever_injected`; capability entries at
 * zero), which is what lets the parser tell a real card header from a
 * header-shaped line inside a lead. `recordInjected` never refreshes it, so a
 * card's evidence survives its lead being pruned and injected again. Empty
 * when the memory connection is unavailable, which leaves the parser to the
 * card shape alone.
 */
export function getKnownCardBytes(
  conversationId: string,
): ReadonlyMap<string, number> {
  return readOr(
    "getKnownCardBytes",
    new Map<string, number>(),
    (mdb) =>
      new Map(
        mdb
          .select({
            slug: memoryV3InjectedSections.slug,
            frozenCardBytes: memoryV3InjectedSections.frozenCardBytes,
          })
          .from(memoryV3InjectedSections)
          .where(
            and(
              eq(memoryV3InjectedSections.conversationId, conversationId),
              eq(memoryV3InjectedSections.sectionKey, ""),
              isNotNull(memoryV3InjectedSections.frozenCardBytes),
            ),
          )
          .all()
          .map((row) => [row.slug, row.frozenCardBytes!] as const),
      ),
  );
}

/**
 * Upsert this turn's injected sections. Re-recording an existing pair clears
 * `pruned_at` and refreshes `bytes`/`injected_at`, never `frozen_card_bytes`:
 * a pruned section that is re-selected re-injects as a fresh entry on the
 * current message. Its older copies stay in earlier messages' persisted
 * metadata; rehydration and the live strip keep only the newest persisted
 * copy of a pair (`newestCopyIndexes` in `prune.ts`), so clearing the
 * tombstone never revives them, and the frozen length keeps parsing the
 * older copy correctly.
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

/** Composite keys per tombstone statement. Each key is one `OR` term, and
 *  SQLite caps expression depth at 1000, so a plan of any size is applied in
 *  batches well under that. */
const PRUNE_KEY_BATCH_SIZE = 100;

/**
 * Mark sections pruned from the live context. Rows are never deleted: the
 * record stays auditable and the sections stay eligible for re-injection.
 * The update runs in {@link PRUNE_KEY_BATCH_SIZE}-key batches inside one
 * transaction, so a large plan neither exceeds SQLite's expression-depth
 * limit nor leaves a partially applied tombstone set.
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
    const mdb = memoryDb("markPruned");
    if (!mdb) {
      return;
    }
    mdb.transaction((tx) => {
      for (let i = 0; i < refs.length; i += PRUNE_KEY_BATCH_SIZE) {
        const batch = refs.slice(i, i + PRUNE_KEY_BATCH_SIZE);
        tx.update(memoryV3InjectedSections)
          .set({ prunedAt: at })
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
    log.warn({ err }, "failed to mark injected sections pruned; continuing");
  }
}

/**
 * Delete the conversation's entire record. Compaction reset: the cached
 * blocks are gone from history, so every section must become re-injectable.
 */
export function clearConversation(conversationId: string): void {
  try {
    const mdb = memoryDb("clearConversation");
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
    const mdb = memoryDb("forkEverInjected");
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
        frozenCardBytes: memoryV3InjectedSections.frozenCardBytes,
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
            frozenCardBytes: row.frozenCardBytes,
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
 * Rows are stamped `injected_at = at` and `bytes` = the byte length of the
 * section's span in the inherited block (header through body, the measure
 * `recordInjected` takes from the live render), so the child's resident
 * accounting starts at what it actually inherited and the valve can evict an
 * inherited section like any other. A section present in several inherited
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
 * A legacy inherited block is parsed with the parent's frozen card lengths as
 * the parser's `knownCardBytes`, so a card frozen before body escaping splits
 * only at headers whose span is a card the parent actually froze. A lead
 * inherited from a legacy block records the parent's recorded legacy length
 * (its own span when the parent has none) as its `frozen_card_bytes`, and a
 * capability chunk from one zero, so the child's legacy copies parse the same
 * way after its own re-injections; a copy from a current-format block records
 * none, so inheriting a legacy card and a later current re-injection of the
 * same lead keeps the legacy length.
 *
 * No-op when the child inherited no blocks. The rows live on the memory
 * connection, so this writes there rather than on the main fork transaction's
 * handle, and an unavailable memory database is a best-effort no-op.
 */
export function seedEverInjectedFromBlocks(
  parentConversationId: string,
  newConversationId: string,
  blocks: ReadonlyArray<InjectedBlock>,
  at: number,
): void {
  const knownCardBytes = getKnownCardBytes(parentConversationId);
  const inherited = new Map<
    string,
    SectionRef & { bytes: number; frozenCardBytes: number | null }
  >();
  // A copy's frozen evidence comes from legacy-format blocks alone: a lead
  // inherited from one records the parent's recorded legacy length (its own
  // span when the parent has none), a capability chunk from one records
  // zero, and a copy from a current-format block records nothing, so a later
  // current re-injection of a lead never overwrites the evidence the legacy
  // block parses by. The span (`bytes`) still follows the latest copy.
  const seed = (
    id: string,
    entry: SectionRef & { bytes: number },
    frozenCardBytes: number | null,
  ): void => {
    inherited.set(id, {
      ...entry,
      frozenCardBytes:
        frozenCardBytes ?? inherited.get(id)?.frozenCardBytes ?? null,
    });
  };
  for (const block of blocks) {
    const legacy = block.format === "legacy";
    for (const piece of parseInjectedSections(unwrapMemoryBlock(block.inner), {
      format: block.format,
      knownCardBytes,
    }).pieces) {
      if (piece.kind === "section") {
        const bytes = renderedBytes(piece.text);
        seed(
          `${piece.slug} ${piece.key}`,
          { slug: piece.slug, key: piece.key, bytes },
          legacy && piece.key.length === 0
            ? (knownCardBytes.get(piece.slug) ?? bytes)
            : null,
        );
      } else if (piece.kind === "capability") {
        const slug = capabilitySlugOf(piece);
        seed(`${slug} `, { slug, key: "", bytes: 0 }, legacy ? 0 : null);
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
      prunedRows.map((r) => [`${r.slug} ${r.key}`, r.prunedAt]),
    );
    for (const [id, { slug, key, bytes, frozenCardBytes }] of inherited) {
      mdb
        .insert(memoryV3InjectedSections)
        .values({
          conversationId: newConversationId,
          slug,
          sectionKey: key,
          injectedAt: at,
          bytes,
          prunedAt: parentPrunedAt.get(id) ?? null,
          frozenCardBytes,
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
