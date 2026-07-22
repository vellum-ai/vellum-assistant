/**
 * Per-conversation everInjected record for memory-v3's frozen-card carry.
 *
 * Backed by `memory_v3_ever_injected`, which lives on the dedicated memory
 * connection (`assistant-memory.db`) — every read/write resolves it via
 * `memoryDbOrNull` and degrades to a no-op when that connection is
 * unavailable. One row per (conversation, page-slug) the v3 injector ever
 * attached as a card. The
 * active (non-pruned) slug set is the injection dedup record — a slug present
 * here rides the cached message prefix and must not be re-rendered — and
 * `bytes` sums into the resident footprint the prune valve bounds. Rows are
 * never deleted by pruning (`pruned_at` is set instead) so the record stays
 * auditable; a pruned page that is re-selected re-injects by clearing
 * `pruned_at` on upsert. `clearConversation` is the compaction reset: the
 * cached blocks those slugs lived on are gone, so future turns are free to
 * re-inject them.
 *
 * Fork semantics mirror v2's activation-store hooks. The fork copy runs on the
 * memory connection, so it is no longer atomic with the main-DB
 * `forkConversation()` transaction that drives it — a best-effort copy that
 * no-ops when the memory database is unavailable:
 *   - full-history forks copy the parent's rows wholesale
 *     (`forkEverInjected`), pruned state included;
 *   - truncated forks seed from the slugs scanned out of the inherited
 *     messages' persisted card blocks (`seedEverInjectedFromSlugs`) — a
 *     wholesale copy would over-claim slugs injected on turns the child does
 *     not contain, suppressing their re-injection forever.
 */

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import type { DrizzleDb } from "../../../../persistence/db-connection.js";
import { memoryV3EverInjected } from "../../../../persistence/schema/index.js";
import { getLogger } from "../logging.js";
import { memoryDbOrNull } from "../memory-db.js";

const log = getLogger("memory-v3-ever-injected-store");

/**
 * Message-metadata key the v3 injector persists each turn's card block under
 * (the v3 counterpart of v2's `memoryInjectedBlock`). Shared by the writer,
 * the conversation-load rehydration splice, and the truncated-fork seed scan
 * in `conversation-crud.ts` so all three agree on the key.
 */
export const MEMORY_V3_INJECTED_BLOCK_METADATA_KEY = "memoryV3InjectedBlock";

export interface EverInjectedEntry {
  bytes: number;
  /** Epoch ms the prune valve removed the card, or `null` while resident. */
  prunedAt: number | null;
}

/**
 * The full per-conversation record, pruned rows included. Test oracle only —
 * no production code path reads it; production consumers use the narrower
 * accessors ({@link getActiveSlugs}, {@link getActiveEntries},
 * {@link getPrunedSlugs}, {@link residentBytes}).
 */
export function getInjected(
  conversationId: string,
): Map<string, EverInjectedEntry> {
  const mdb = memoryDbOrNull("getInjected");
  if (!mdb) return new Map();
  const rows = mdb
    .select({
      slug: memoryV3EverInjected.slug,
      bytes: memoryV3EverInjected.bytes,
      prunedAt: memoryV3EverInjected.prunedAt,
    })
    .from(memoryV3EverInjected)
    .where(eq(memoryV3EverInjected.conversationId, conversationId))
    .all();

  return new Map(
    rows.map((row) => [row.slug, { bytes: row.bytes, prunedAt: row.prunedAt }]),
  );
}

/** The injection dedup set: slugs whose cards are currently resident. */
export function getActiveSlugs(conversationId: string): Set<string> {
  const mdb = memoryDbOrNull("getActiveSlugs");
  if (!mdb) return new Set();
  const rows = mdb
    .select({ slug: memoryV3EverInjected.slug })
    .from(memoryV3EverInjected)
    .where(
      and(
        eq(memoryV3EverInjected.conversationId, conversationId),
        isNull(memoryV3EverInjected.prunedAt),
      ),
    )
    .all();
  return new Set(rows.map((row) => row.slug));
}

/** One active (resident) row of the prune valve's candidate set. */
export interface ActiveInjectedEntry {
  slug: string;
  bytes: number;
  /** Epoch ms the card was (last) injected — the recency fallback for slugs
   *  with no selection rows (e.g. rows copied by a full fork). */
  injectedAt: number;
}

/**
 * Active (non-pruned) rows with byte and injection-time accounting — the
 * prune valve's candidate set ({@link ActiveInjectedEntry}).
 */
export function getActiveEntries(
  conversationId: string,
): ActiveInjectedEntry[] {
  const mdb = memoryDbOrNull("getActiveEntries");
  if (!mdb) return [];
  return mdb
    .select({
      slug: memoryV3EverInjected.slug,
      bytes: memoryV3EverInjected.bytes,
      injectedAt: memoryV3EverInjected.injectedAt,
    })
    .from(memoryV3EverInjected)
    .where(
      and(
        eq(memoryV3EverInjected.conversationId, conversationId),
        isNull(memoryV3EverInjected.prunedAt),
      ),
    )
    .all();
}

/**
 * Slugs currently marked pruned — the card-section skip set shared by the
 * live-history strip and the `loadFromDb` rehydration filter (see
 * `prune.ts` / `daemon/conversation.ts`).
 */
export function getPrunedSlugs(conversationId: string): Set<string> {
  const mdb = memoryDbOrNull("getPrunedSlugs");
  if (!mdb) return new Set();
  const rows = mdb
    .select({ slug: memoryV3EverInjected.slug })
    .from(memoryV3EverInjected)
    .where(
      and(
        eq(memoryV3EverInjected.conversationId, conversationId),
        isNotNull(memoryV3EverInjected.prunedAt),
      ),
    )
    .all();
  return new Set(rows.map((row) => row.slug));
}

/**
 * Upsert this turn's injected cards. Re-recording an existing slug clears
 * `pruned_at` and refreshes `bytes`/`injected_at` — a pruned page that is
 * re-selected re-injects as a fresh card.
 */
export function recordInjected(
  conversationId: string,
  entries: Array<{ slug: string; bytes: number }>,
  at: number = Date.now(),
): void {
  if (entries.length === 0) return;
  // Best-effort — a derived injection-accounting write must never abort the
  // agent turn, so a degraded memory connection or a failed statement only
  // logs a warning.
  try {
    const mdb = memoryDbOrNull("recordInjected");
    if (!mdb) return;
    for (const entry of entries) {
      mdb
        .insert(memoryV3EverInjected)
        .values({
          conversationId,
          slug: entry.slug,
          injectedAt: at,
          bytes: entry.bytes,
          prunedAt: null,
        })
        .onConflictDoUpdate({
          target: [
            memoryV3EverInjected.conversationId,
            memoryV3EverInjected.slug,
          ],
          set: { injectedAt: at, bytes: entry.bytes, prunedAt: null },
        })
        .run();
    }
  } catch (err) {
    log.warn({ err }, "failed to record ever-injected cards; continuing");
  }
}

/**
 * Mark cards pruned from the live context. Rows are never deleted — the
 * record stays auditable and the slugs stay eligible for re-injection.
 */
export function markPruned(
  conversationId: string,
  slugs: string[],
  at: number,
): void {
  if (slugs.length === 0) return;
  try {
    const mdb = memoryDbOrNull("markPruned");
    if (!mdb) return;
    mdb
      .update(memoryV3EverInjected)
      .set({ prunedAt: at })
      .where(
        and(
          eq(memoryV3EverInjected.conversationId, conversationId),
          inArray(memoryV3EverInjected.slug, slugs),
        ),
      )
      .run();
  } catch (err) {
    log.warn({ err }, "failed to mark ever-injected cards pruned; continuing");
  }
}

/**
 * Delete the conversation's entire record. Compaction reset: the cached
 * blocks are gone from history, so every slug must become re-injectable.
 */
export function clearConversation(conversationId: string): void {
  try {
    const mdb = memoryDbOrNull("clearConversation");
    if (!mdb) return;
    mdb
      .delete(memoryV3EverInjected)
      .where(eq(memoryV3EverInjected.conversationId, conversationId))
      .run();
  } catch (err) {
    log.warn(
      { err },
      "failed to clear ever-injected record for conversation; continuing",
    );
  }
}

/** Total bytes of resident (non-pruned) cards — the prune-valve input. */
export function residentBytes(conversationId: string): number {
  const mdb = memoryDbOrNull("residentBytes");
  if (!mdb) return 0;
  const row = mdb
    .select({
      total: sql<number>`COALESCE(SUM(${memoryV3EverInjected.bytes}), 0)`,
    })
    .from(memoryV3EverInjected)
    .where(
      and(
        eq(memoryV3EverInjected.conversationId, conversationId),
        isNull(memoryV3EverInjected.prunedAt),
      ),
    )
    .get();
  return row?.total ?? 0;
}

/**
 * Copy the parent conversation's rows to a new conversation id, pruned state
 * included. No-op if the parent has no rows. Full-history forks only —
 * truncated forks must use `seedEverInjectedFromSlugs` instead.
 *
 * The rows live on the memory connection, so this writes there rather than on
 * the main fork transaction's handle — the `_db` main handle is unused. The
 * copy is best-effort: an unavailable memory database is a no-op.
 */
export function forkEverInjected(
  _db: DrizzleDb,
  parentConversationId: string,
  newConversationId: string,
): void {
  try {
    const mdb = memoryDbOrNull("forkEverInjected");
    if (!mdb) return;
    const parentRows = mdb
      .select({
        slug: memoryV3EverInjected.slug,
        injectedAt: memoryV3EverInjected.injectedAt,
        bytes: memoryV3EverInjected.bytes,
        prunedAt: memoryV3EverInjected.prunedAt,
      })
      .from(memoryV3EverInjected)
      .where(eq(memoryV3EverInjected.conversationId, parentConversationId))
      .all();
    for (const row of parentRows) {
      mdb
        .insert(memoryV3EverInjected)
        .values({ conversationId: newConversationId, ...row })
        .onConflictDoUpdate({
          target: [
            memoryV3EverInjected.conversationId,
            memoryV3EverInjected.slug,
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
    log.warn({ err }, "failed to fork ever-injected record; continuing");
  }
}

/**
 * Seed a truncated fork's record from the slugs whose card blocks the child
 * actually inherited (scanned out of the copied messages'
 * `MEMORY_V3_INJECTED_BLOCK_METADATA_KEY` metadata). Mirrors
 * `seedForkActivationState`: a wholesale copy would over-claim, while seeding
 * nothing would re-attach every inherited card as a duplicate.
 *
 * Rows are stamped `injected_at = at` and `bytes = 0` — the rendered size of
 * inherited cards is unknown, so `residentBytes` accounting restarts from the
 * fork's own injections.
 *
 * The parent's `pruned_at` tombstones are carried over: pruning leaves the
 * persisted metadata block intact and relies on the tombstone to filter the
 * section out at rehydration, so the metadata scan feeding this seed
 * necessarily sees pruned cards' sections too. Seeding those slugs as active
 * would resurrect parent-pruned cards in the child on its next load (and
 * diverge from the full-fork copy path, which preserves tombstones). A
 * tombstoned seed keeps the child's rehydrated view identical to the parent's
 * live view at fork time; re-selection clears the tombstone and re-injects,
 * same as in the parent.
 *
 * No-op when the child inherited no card blocks. The rows live on the memory
 * connection, so this writes there rather than on the main fork transaction's
 * handle — the `_db` main handle is unused, and an unavailable memory database
 * is a best-effort no-op.
 */
export function seedEverInjectedFromSlugs(
  _db: DrizzleDb,
  parentConversationId: string,
  newConversationId: string,
  slugs: string[],
  at: number,
): void {
  if (slugs.length === 0) return;
  try {
    const mdb = memoryDbOrNull("seedEverInjectedFromSlugs");
    if (!mdb) return;
    const prunedRows = mdb
      .select({
        slug: memoryV3EverInjected.slug,
        prunedAt: memoryV3EverInjected.prunedAt,
      })
      .from(memoryV3EverInjected)
      .where(
        and(
          eq(memoryV3EverInjected.conversationId, parentConversationId),
          isNotNull(memoryV3EverInjected.prunedAt),
        ),
      )
      .all();
    const parentPrunedAt = new Map(prunedRows.map((r) => [r.slug, r.prunedAt]));
    for (const slug of slugs) {
      mdb
        .insert(memoryV3EverInjected)
        .values({
          conversationId: newConversationId,
          slug,
          injectedAt: at,
          bytes: 0,
          prunedAt: parentPrunedAt.get(slug) ?? null,
        })
        .onConflictDoNothing({
          target: [
            memoryV3EverInjected.conversationId,
            memoryV3EverInjected.slug,
          ],
        })
        .run();
    }
  } catch (err) {
    log.warn({ err }, "failed to seed forked ever-injected record; continuing");
  }
}
