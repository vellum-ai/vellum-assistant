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

import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { memoryV3EverInjected } from "../../../../persistence/schema/index.js";
import { getLogger } from "../logging.js";
import { memoryDbOrNull } from "../memory-db.js";

const log = getLogger("memory-v3-ever-injected-store");
const lastKnownPrunedSlugs = new Map<string, Set<string>>();

interface PendingInjection {
  bytes: number;
  injectedAt: number;
}

const pendingReinjections = new Map<string, Map<string, PendingInjection>>();
const pendingPersistedReconciliations = new Map<
  string,
  Map<string, PendingInjection>
>();
const pendingPrunes = new Map<string, Map<string, number>>();

type MemoryDb = NonNullable<ReturnType<typeof memoryDbOrNull>>;

function queueReinjections(
  conversationId: string,
  entries: Array<{ slug: string } & PendingInjection>,
): void {
  if (entries.length === 0) {
    return;
  }
  const pending = pendingReinjections.get(conversationId) ?? new Map();
  const pruned = lastKnownPrunedSlugs.get(conversationId);
  const queuedPrunes = pendingPrunes.get(conversationId);
  for (const entry of entries) {
    const prior = pending.get(entry.slug);
    if (prior && prior.injectedAt > entry.injectedAt) {
      continue;
    }
    pending.set(entry.slug, {
      bytes: entry.bytes,
      injectedAt: entry.injectedAt,
    });
    const prunedAt = queuedPrunes?.get(entry.slug);
    if (prunedAt === undefined || entry.injectedAt > prunedAt) {
      queuedPrunes?.delete(entry.slug);
      pruned?.delete(entry.slug);
    }
  }
  pendingReinjections.set(conversationId, pending);
  if (queuedPrunes?.size === 0) {
    pendingPrunes.delete(conversationId);
  }
}

function queuePersistedReconciliations(
  conversationId: string,
  entries: Array<{ slug: string } & PendingInjection>,
): void {
  const pending =
    pendingPersistedReconciliations.get(conversationId) ?? new Map();
  for (const entry of entries) {
    const prior = pending.get(entry.slug);
    if (!prior || entry.injectedAt > prior.injectedAt) {
      pending.set(entry.slug, entry);
    }
  }
  pendingPersistedReconciliations.set(conversationId, pending);
}

function queuePrunes(
  conversationId: string,
  slugs: string[],
  prunedAt: number,
): void {
  const pending = pendingPrunes.get(conversationId) ?? new Map();
  const snapshot = lastKnownPrunedSlugs.get(conversationId) ?? new Set();
  for (const slug of slugs) {
    const reinjectedAt = Math.max(
      pendingReinjections.get(conversationId)?.get(slug)?.injectedAt ??
        -Infinity,
      pendingPersistedReconciliations.get(conversationId)?.get(slug)
        ?.injectedAt ?? -Infinity,
    );
    if (reinjectedAt !== undefined && reinjectedAt > prunedAt) {
      continue;
    }
    const prior = pending.get(slug);
    if (prior === undefined || prunedAt > prior) {
      pending.set(slug, prunedAt);
    }
    snapshot.add(slug);
  }
  if (pending.size > 0) {
    pendingPrunes.set(conversationId, pending);
  }
  if (snapshot.size > 0) {
    lastKnownPrunedSlugs.set(conversationId, snapshot);
  }
}

function persistPendingAccounting(mdb: MemoryDb, conversationId: string): void {
  const reinjections = [...(pendingReinjections.get(conversationId) ?? [])];
  const prunes = [...(pendingPrunes.get(conversationId) ?? [])];
  if (reinjections.length === 0 && prunes.length === 0) {
    return;
  }
  mdb.transaction((tx) => {
    for (const [slug, entry] of reinjections) {
      tx.insert(memoryV3EverInjected)
        .values({
          conversationId,
          slug,
          injectedAt: entry.injectedAt,
          bytes: entry.bytes,
          prunedAt: null,
        })
        .onConflictDoUpdate({
          target: [
            memoryV3EverInjected.conversationId,
            memoryV3EverInjected.slug,
          ],
          set: {
            injectedAt: entry.injectedAt,
            bytes: entry.bytes,
            prunedAt: null,
          },
        })
        .run();
    }
    for (const [slug, prunedAt] of prunes) {
      tx.update(memoryV3EverInjected)
        .set({ prunedAt })
        .where(
          and(
            eq(memoryV3EverInjected.conversationId, conversationId),
            eq(memoryV3EverInjected.slug, slug),
          ),
        )
        .run();
    }
  });
  for (const [slug] of reinjections) {
    pendingReinjections.get(conversationId)?.delete(slug);
  }
  for (const [slug] of prunes) {
    pendingPrunes.get(conversationId)?.delete(slug);
  }
  if (pendingReinjections.get(conversationId)?.size === 0) {
    pendingReinjections.delete(conversationId);
  }
  if (pendingPrunes.get(conversationId)?.size === 0) {
    pendingPrunes.delete(conversationId);
  }
}

function retryPendingAccounting(mdb: MemoryDb, conversationId: string): void {
  try {
    reconcilePendingPersistedInjections(mdb, conversationId);
    persistPendingAccounting(mdb, conversationId);
  } catch (err) {
    log.warn({ err }, "failed to retry pending card accounting; continuing");
  }
}

function reconcilePendingPersistedInjections(
  mdb: MemoryDb,
  conversationId: string,
): void {
  const pending = pendingPersistedReconciliations.get(conversationId);
  if (!pending) {
    return;
  }
  const stored = new Map(
    mdb
      .select({
        slug: memoryV3EverInjected.slug,
        injectedAt: memoryV3EverInjected.injectedAt,
        prunedAt: memoryV3EverInjected.prunedAt,
      })
      .from(memoryV3EverInjected)
      .where(eq(memoryV3EverInjected.conversationId, conversationId))
      .all()
      .map((row) => [row.slug, row]),
  );
  const recoverable = [...pending.entries()]
    .filter(([slug, entry]) => {
      const row = stored.get(slug);
      if (!row) {
        return true;
      }
      const accountedThrough = row.prunedAt ?? row.injectedAt;
      return entry.injectedAt > accountedThrough;
    })
    .map(([slug, entry]) => ({ slug, ...entry }));
  pendingPersistedReconciliations.delete(conversationId);
  queueReinjections(conversationId, recoverable);
}

function pendingEntries(conversationId: string): Map<string, PendingInjection> {
  const entries = new Map<string, PendingInjection>();
  const knownPruned = lastKnownPrunedSlugs.get(conversationId);
  for (const [slug, entry] of pendingPersistedReconciliations.get(
    conversationId,
  ) ?? []) {
    if (!knownPruned?.has(slug)) {
      entries.set(slug, entry);
    }
  }
  for (const [slug, entry] of pendingReinjections.get(conversationId) ?? []) {
    const prior = entries.get(slug);
    if (!prior || entry.injectedAt >= prior.injectedAt) {
      entries.set(slug, entry);
    }
  }
  for (const [slug, prunedAt] of pendingPrunes.get(conversationId) ?? []) {
    if ((entries.get(slug)?.injectedAt ?? -Infinity) <= prunedAt) {
      entries.delete(slug);
    }
  }
  return entries;
}

function currentPrunedSnapshot(conversationId: string): Set<string> {
  const slugs = new Set(lastKnownPrunedSlugs.get(conversationId) ?? []);
  for (const slug of pendingPrunes.get(conversationId)?.keys() ?? []) {
    slugs.add(slug);
  }
  for (const [slug, entry] of pendingReinjections.get(conversationId) ?? []) {
    const prunedAt = pendingPrunes.get(conversationId)?.get(slug);
    if (prunedAt === undefined || entry.injectedAt > prunedAt) {
      slugs.delete(slug);
    }
  }
  return slugs;
}

/**
 * Message-metadata key the v3 injector persists each turn's card block under
 * (the v3 counterpart of v2's `memoryInjectedBlock`). Shared by the writer,
 * the conversation-load rehydration splice, and the truncated-fork seed scan
 * in `conversation-crud.ts` so all three agree on the key.
 */
export const MEMORY_V3_INJECTED_BLOCK_METADATA_KEY = "memoryV3InjectedBlock";
/** Durable ordering marker used to recover a card whose accounting write failed. */
export const MEMORY_V3_INJECTED_AT_METADATA_KEY = "memoryV3InjectedAt";

export function _resetEverInjectedRuntimeStateForTests(): void {
  lastKnownPrunedSlugs.clear();
  pendingReinjections.clear();
  pendingPersistedReconciliations.clear();
  pendingPrunes.clear();
}

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
  if (!mdb) {
    return new Map();
  }
  retryPendingAccounting(mdb, conversationId);
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
  if (!mdb) {
    return new Set(pendingEntries(conversationId).keys());
  }
  retryPendingAccounting(mdb, conversationId);
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
  const queuedPrunes = pendingPrunes.get(conversationId);
  return new Set([
    ...rows.map((row) => row.slug).filter((slug) => !queuedPrunes?.has(slug)),
    ...pendingEntries(conversationId).keys(),
  ]);
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
  if (!mdb) {
    return [...pendingEntries(conversationId)].map(([slug, entry]) => ({
      slug,
      ...entry,
    }));
  }
  retryPendingAccounting(mdb, conversationId);
  const rows = mdb
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
  const entries = new Map(rows.map((row) => [row.slug, row]));
  for (const slug of pendingPrunes.get(conversationId)?.keys() ?? []) {
    entries.delete(slug);
  }
  for (const [slug, entry] of pendingEntries(conversationId)) {
    entries.set(slug, { slug, ...entry });
  }
  return [...entries.values()];
}

/**
 * Slugs currently marked pruned — the card-section skip set shared by the
 * live-history strip and the `loadFromDb` rehydration filter (see
 * `prune.ts` / `daemon/conversation.ts`).
 */
export function getPrunedSlugs(conversationId: string): Set<string> {
  try {
    const mdb = memoryDbOrNull("getPrunedSlugs");
    if (!mdb) {
      return currentPrunedSnapshot(conversationId);
    }
    retryPendingAccounting(mdb, conversationId);
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
    const slugs = new Set(rows.map((row) => row.slug));
    lastKnownPrunedSlugs.set(conversationId, slugs);
    return currentPrunedSnapshot(conversationId);
  } catch (err) {
    log.warn({ err }, "failed to read pruned card state; using last snapshot");
    return currentPrunedSnapshot(conversationId);
  }
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
  if (entries.length === 0) {
    return;
  }
  queueReinjections(
    conversationId,
    entries.map((entry) => ({ ...entry, injectedAt: at })),
  );
  // Best-effort — a derived injection-accounting write must never abort the
  // agent turn, so a degraded memory connection or a failed statement only
  // logs a warning.
  try {
    const mdb = memoryDbOrNull("recordInjected");
    if (!mdb) {
      return;
    }
    retryPendingAccounting(mdb, conversationId);
  } catch (err) {
    log.warn({ err }, "failed to record ever-injected cards; continuing");
  }
}

/** Restore accounting from card blocks that were durably attached to messages. */
export function reconcilePersistedInjections(
  conversationId: string,
  entries: Array<{ slug: string; bytes: number; injectedAt: number }>,
): void {
  if (entries.length === 0) {
    return;
  }
  queuePersistedReconciliations(conversationId, entries);
  try {
    const mdb = memoryDbOrNull("reconcilePersistedInjections");
    if (!mdb) {
      return;
    }
    retryPendingAccounting(mdb, conversationId);
  } catch (err) {
    log.warn({ err }, "failed to reconcile persisted card accounting");
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
  if (slugs.length === 0) {
    return;
  }
  queuePrunes(conversationId, slugs, at);
  try {
    const mdb = memoryDbOrNull("markPruned");
    if (!mdb) {
      return;
    }
    retryPendingAccounting(mdb, conversationId);
  } catch (err) {
    log.warn({ err }, "failed to mark ever-injected cards pruned; continuing");
  }
}

/**
 * Delete the conversation's entire record. Compaction reset: the cached
 * blocks are gone from history, so every slug must become re-injectable.
 */
export function clearConversation(conversationId: string): void {
  lastKnownPrunedSlugs.delete(conversationId);
  pendingReinjections.delete(conversationId);
  pendingPersistedReconciliations.delete(conversationId);
  pendingPrunes.delete(conversationId);
  try {
    const mdb = memoryDbOrNull("clearConversation");
    if (!mdb) {
      return;
    }
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
  return getActiveEntries(conversationId).reduce(
    (total, entry) => total + entry.bytes,
    0,
  );
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
  parentConversationId: string,
  newConversationId: string,
): void {
  try {
    const mdb = memoryDbOrNull("forkEverInjected");
    if (!mdb) {
      return;
    }
    retryPendingAccounting(mdb, parentConversationId);
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
  parentConversationId: string,
  newConversationId: string,
  slugs: string[],
  at: number,
): void {
  if (slugs.length === 0) {
    return;
  }
  try {
    const mdb = memoryDbOrNull("seedEverInjectedFromSlugs");
    if (!mdb) {
      return;
    }
    retryPendingAccounting(mdb, parentConversationId);
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
