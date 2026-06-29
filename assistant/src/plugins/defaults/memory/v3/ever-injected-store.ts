/**
 * Per-conversation everInjected record for memory-v3's frozen-card carry.
 *
 * Backed by `memory_v3_ever_injected` (migration 277): one row per
 * (conversation, page-slug) the v3 injector ever attached as a card. The
 * active (non-pruned) slug set is the injection dedup record — a slug present
 * here rides the cached message prefix and must not be re-rendered — and
 * `bytes` sums into the resident footprint the prune valve bounds. Rows are
 * never deleted by pruning (`pruned_at` is set instead) so the record stays
 * auditable; a pruned page that is re-selected re-injects by clearing
 * `pruned_at` on upsert. `clearConversation` is the compaction reset: the
 * cached blocks those slugs lived on are gone, so future turns are free to
 * re-inject them.
 *
 * Fork semantics mirror v2's activation-store hooks (both run synchronously
 * inside the `forkConversation()` transaction — see
 * `assistant/src/memory/conversation-crud.ts`):
 *   - full-history forks copy the parent's rows wholesale
 *     (`forkEverInjected`), pruned state included;
 *   - truncated forks seed from the slugs scanned out of the inherited
 *     messages' persisted card blocks (`seedEverInjectedFromSlugs`) — a
 *     wholesale copy would over-claim slugs injected on turns the child does
 *     not contain, suppressing their re-injection forever.
 */

import {
  type DrizzleDb,
  getDb,
  getSqliteFrom,
} from "../../../../persistence/db-connection.js";

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
  const rows = getSqliteFrom(getDb())
    .query(
      /*sql*/ `
      SELECT slug, bytes, pruned_at AS prunedAt FROM memory_v3_ever_injected
      WHERE conversation_id = ?
    `,
    )
    .all(conversationId) as Array<{
    slug: string;
    bytes: number;
    prunedAt: number | null;
  }>;

  return new Map(
    rows.map((row) => [row.slug, { bytes: row.bytes, prunedAt: row.prunedAt }]),
  );
}

/** The injection dedup set: slugs whose cards are currently resident. */
export function getActiveSlugs(conversationId: string): Set<string> {
  const rows = getSqliteFrom(getDb())
    .query(
      /*sql*/ `
      SELECT slug FROM memory_v3_ever_injected
      WHERE conversation_id = ? AND pruned_at IS NULL
    `,
    )
    .all(conversationId) as Array<{ slug: string }>;
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
  return getSqliteFrom(getDb())
    .query(
      /*sql*/ `
      SELECT slug, bytes, injected_at AS injectedAt FROM memory_v3_ever_injected
      WHERE conversation_id = ? AND pruned_at IS NULL
    `,
    )
    .all(conversationId) as ActiveInjectedEntry[];
}

/**
 * Slugs currently marked pruned — the card-section skip set shared by the
 * live-history strip and the `loadFromDb` rehydration filter (see
 * `prune.ts` / `daemon/conversation.ts`).
 */
export function getPrunedSlugs(conversationId: string): Set<string> {
  const rows = getSqliteFrom(getDb())
    .query(
      /*sql*/ `
      SELECT slug FROM memory_v3_ever_injected
      WHERE conversation_id = ? AND pruned_at IS NOT NULL
    `,
    )
    .all(conversationId) as Array<{ slug: string }>;
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
  const stmt = getSqliteFrom(getDb()).query(/*sql*/ `
    INSERT INTO memory_v3_ever_injected (conversation_id, slug, injected_at, bytes, pruned_at)
    VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT (conversation_id, slug) DO UPDATE SET
      injected_at = excluded.injected_at,
      bytes = excluded.bytes,
      pruned_at = NULL
  `);
  for (const entry of entries) {
    stmt.run(conversationId, entry.slug, at, entry.bytes);
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
  const placeholders = slugs.map(() => "?").join(", ");
  getSqliteFrom(getDb())
    .query(
      /*sql*/ `
      UPDATE memory_v3_ever_injected SET pruned_at = ?
      WHERE conversation_id = ? AND slug IN (${placeholders})
    `,
    )
    .run(at, conversationId, ...slugs);
}

/**
 * Delete the conversation's entire record. Compaction reset: the cached
 * blocks are gone from history, so every slug must become re-injectable.
 */
export function clearConversation(conversationId: string): void {
  getSqliteFrom(getDb())
    .query(
      /*sql*/ `
      DELETE FROM memory_v3_ever_injected WHERE conversation_id = ?
    `,
    )
    .run(conversationId);
}

/** Total bytes of resident (non-pruned) cards — the prune-valve input. */
export function residentBytes(conversationId: string): number {
  const row = getSqliteFrom(getDb())
    .query(
      /*sql*/ `
      SELECT COALESCE(SUM(bytes), 0) AS total FROM memory_v3_ever_injected
      WHERE conversation_id = ? AND pruned_at IS NULL
    `,
    )
    .get(conversationId) as { total: number };
  return row.total;
}

/**
 * Copy the parent conversation's rows to a new conversation id, pruned state
 * included. No-op if the parent has no rows. Mirrors `forkActivationState`:
 * synchronous so it can run inside the bun:sqlite transaction that wraps
 * `forkConversation()`, keeping the copy atomic with the message copies.
 * Full-history forks only — truncated forks must use
 * `seedEverInjectedFromSlugs` instead.
 */
export function forkEverInjected(
  db: DrizzleDb,
  parentConversationId: string,
  newConversationId: string,
): void {
  getSqliteFrom(db)
    .query(
      /*sql*/ `
      INSERT INTO memory_v3_ever_injected (conversation_id, slug, injected_at, bytes, pruned_at)
      SELECT ?, slug, injected_at, bytes, pruned_at FROM memory_v3_ever_injected
      WHERE conversation_id = ?
      ON CONFLICT (conversation_id, slug) DO UPDATE SET
        injected_at = excluded.injected_at,
        bytes = excluded.bytes,
        pruned_at = excluded.pruned_at
    `,
    )
    .run(newConversationId, parentConversationId);
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
 * No-op when the child inherited no card blocks. Synchronous so it can run
 * inside the `forkConversation()` transaction.
 */
export function seedEverInjectedFromSlugs(
  db: DrizzleDb,
  parentConversationId: string,
  newConversationId: string,
  slugs: string[],
  at: number,
): void {
  if (slugs.length === 0) return;
  const prunedRows = getSqliteFrom(db)
    .query(
      /*sql*/ `
      SELECT slug, pruned_at AS prunedAt FROM memory_v3_ever_injected
      WHERE conversation_id = ? AND pruned_at IS NOT NULL
    `,
    )
    .all(parentConversationId) as Array<{ slug: string; prunedAt: number }>;
  const parentPrunedAt = new Map(prunedRows.map((r) => [r.slug, r.prunedAt]));
  const stmt = getSqliteFrom(db).query(/*sql*/ `
    INSERT INTO memory_v3_ever_injected (conversation_id, slug, injected_at, bytes, pruned_at)
    VALUES (?, ?, ?, 0, ?)
    ON CONFLICT (conversation_id, slug) DO NOTHING
  `);
  for (const slug of slugs) {
    stmt.run(newConversationId, slug, at, parentPrunedAt.get(slug) ?? null);
  }
}
