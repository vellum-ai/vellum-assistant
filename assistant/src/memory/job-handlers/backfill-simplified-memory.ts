/**
 * Backfill job handler: migrates legacy memory rows into the simplified memory
 * system without deleting the old tables.
 *
 * Migration mapping:
 *   - `memory_segments` -> `memory_chunks` (via `memory_observations`)
 *   - `memory_summaries` -> `memory_episodes`
 *   - Active/high-confidence `memory_items` -> `memory_observations`,
 *     plus `time_contexts` or `open_loops` when the mapping is unambiguous.
 *
 * The handler is idempotent: content-hash deduplication on chunks and
 * checkpoint tracking prevent double-writes on re-runs.
 */

import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { estimateTextTokens } from "../../context/token-estimator.js";
import { getLogger } from "../../util/logger.js";
import {
  computeChunkContentHash,
  insertObservation,
} from "../archive-store.js";
import { getMemoryCheckpoint, setMemoryCheckpoint } from "../checkpoints.js";
import { getDb, rawAll } from "../db.js";
import type { MemoryJob } from "../jobs-store.js";
import { enqueueMemoryJob } from "../jobs-store.js";
import {
  conversations,
  memoryChunks,
  memoryEpisodes,
  memoryObservations,
  openLoops,
  timeContexts,
} from "../schema.js";

const log = getLogger("backfill-simplified-memory");

/** Checkpoint keys for tracking backfill progress. */
const CHECKPOINT_SEGMENTS = "simplified_backfill:segments:last_id";
const CHECKPOINT_SUMMARIES = "simplified_backfill:summaries:last_id";
const CHECKPOINT_ITEMS = "simplified_backfill:items:last_id";
const CHECKPOINT_COMPLETE = "simplified_backfill:complete";

/** Batch size for each migration pass. */
const BATCH_SIZE = 200;

// ── Legacy row types ──────────────────────────────────────────────────

interface LegacySegment {
  id: string;
  message_id: string;
  conversation_id: string;
  role: string;
  text: string;
  token_estimate: number;
  scope_id: string;
  content_hash: string | null;
  created_at: number;
}

interface LegacySummary {
  id: string;
  scope: string;
  scope_key: string;
  summary: string;
  token_estimate: number;
  scope_id: string;
  start_at: number;
  end_at: number;
  created_at: number;
}

interface LegacyItem {
  id: string;
  kind: string;
  subject: string;
  statement: string;
  status: string;
  confidence: number;
  scope_id: string;
  first_seen_at: number;
  last_seen_at: number;
  valid_from: number | null;
  invalid_at: number | null;
}

// ── Entry point ───────────────────────────────────────────────────────

export async function backfillSimplifiedMemoryJob(
  job: MemoryJob,
): Promise<void> {
  const force = job.payload.force === true;

  if (!force) {
    const complete = getMemoryCheckpoint(CHECKPOINT_COMPLETE);
    if (complete === "true") {
      log.debug("Simplified memory backfill already complete, skipping");
      return;
    }
  }

  if (force) {
    // Reset all checkpoints so the backfill restarts from scratch
    setMemoryCheckpoint(CHECKPOINT_SEGMENTS, "");
    setMemoryCheckpoint(CHECKPOINT_SUMMARIES, "");
    setMemoryCheckpoint(CHECKPOINT_ITEMS, "");
    setMemoryCheckpoint(CHECKPOINT_COMPLETE, "false");
  }

  let hasMore = false;

  // ── Phase 1: memory_segments -> memory_observations + memory_chunks
  hasMore = migrateSegments();
  if (hasMore) {
    enqueueMemoryJob("backfill_simplified_memory", {});
    return;
  }

  // ── Phase 2: memory_summaries -> memory_episodes
  hasMore = migrateSummaries();
  if (hasMore) {
    enqueueMemoryJob("backfill_simplified_memory", {});
    return;
  }

  // ── Phase 3: active memory_items -> memory_observations (+ brief-state)
  hasMore = migrateItems();
  if (hasMore) {
    enqueueMemoryJob("backfill_simplified_memory", {});
    return;
  }

  // All phases complete
  setMemoryCheckpoint(CHECKPOINT_COMPLETE, "true");
  log.info("Simplified memory backfill completed");
}

// ── Phase 1: Segments ─────────────────────────────────────────────────

function migrateSegments(): boolean {
  const lastId = getMemoryCheckpoint(CHECKPOINT_SEGMENTS) ?? "";

  const segments = rawAll<LegacySegment>(
    `SELECT id, message_id, conversation_id, role, text, token_estimate,
            scope_id, content_hash, created_at
     FROM memory_segments
     WHERE id > ?
     ORDER BY id ASC
     LIMIT ?`,
    lastId,
    BATCH_SIZE,
  );

  if (segments.length === 0) return false;

  for (const seg of segments) {
    try {
      // Insert as an observation — insertObservation handles chunk dedup
      insertObservation({
        conversationId: seg.conversation_id,
        messageId: seg.message_id,
        role: seg.role,
        content: seg.text,
        scopeId: seg.scope_id,
        modality: "text",
        source: "backfill:segment",
      });
    } catch (err) {
      // Log and continue — individual failures should not block the batch
      log.warn(
        { err, segmentId: seg.id },
        "Failed to migrate segment, skipping",
      );
    }
  }

  const lastSegment = segments[segments.length - 1];
  setMemoryCheckpoint(CHECKPOINT_SEGMENTS, lastSegment.id);

  log.debug(
    { migrated: segments.length, lastId: lastSegment.id },
    "Migrated segment batch",
  );

  return segments.length === BATCH_SIZE;
}

// ── Phase 2: Summaries ────────────────────────────────────────────────

function migrateSummaries(): boolean {
  const lastId = getMemoryCheckpoint(CHECKPOINT_SUMMARIES) ?? "";

  const summaries = rawAll<LegacySummary>(
    `SELECT id, scope, scope_key, summary, token_estimate, scope_id,
            start_at, end_at, created_at
     FROM memory_summaries
     WHERE id > ?
     ORDER BY id ASC
     LIMIT ?`,
    lastId,
    BATCH_SIZE,
  );

  if (summaries.length === 0) return false;

  const db = getDb();
  const now = Date.now();

  for (const sum of summaries) {
    try {
      // Derive a conversation ID from the scope_key if it looks like a conversation summary.
      // scope_key format: "conversation:<conversationId>" or "<scope>:<key>"
      const conversationId = extractConversationId(sum.scope, sum.scope_key);
      if (!conversationId) {
        log.debug(
          { summaryId: sum.id, scope: sum.scope, scopeKey: sum.scope_key },
          "Skipping non-conversation summary",
        );
        continue;
      }

      const episodeId = uuid();
      const title = buildEpisodeTitle(sum.scope, sum.scope_key);

      db.insert(memoryEpisodes)
        .values({
          id: episodeId,
          scopeId: sum.scope_id,
          conversationId,
          title,
          summary: sum.summary,
          tokenEstimate: sum.token_estimate,
          source: "backfill:summary",
          startAt: sum.start_at,
          endAt: sum.end_at,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();

      // Enqueue embedding for the new episode
      enqueueMemoryJob("embed_episode", { episodeId });
    } catch (err) {
      log.warn(
        { err, summaryId: sum.id },
        "Failed to migrate summary, skipping",
      );
    }
  }

  const lastSummary = summaries[summaries.length - 1];
  setMemoryCheckpoint(CHECKPOINT_SUMMARIES, lastSummary.id);

  log.debug(
    { migrated: summaries.length, lastId: lastSummary.id },
    "Migrated summary batch",
  );

  return summaries.length === BATCH_SIZE;
}

// ── Phase 3: Items ────────────────────────────────────────────────────

/** Sentinel conversation ID for legacy items that have no conversation linkage. */
const LEGACY_SENTINEL_CONVERSATION_ID = "__legacy_backfill__";

/**
 * Ensure the legacy sentinel conversation row exists. This is needed because
 * memory_observations has a FK constraint on conversation_id.
 */
function ensureLegacySentinelConversation(): void {
  const db = getDb();
  const existing = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, LEGACY_SENTINEL_CONVERSATION_ID))
    .get();
  if (existing) return;

  const now = Date.now();
  db.insert(conversations)
    .values({
      id: LEGACY_SENTINEL_CONVERSATION_ID,
      title: "[Legacy Memory Backfill]",
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function migrateItems(): boolean {
  const lastId = getMemoryCheckpoint(CHECKPOINT_ITEMS) ?? "";

  const items = rawAll<LegacyItem>(
    `SELECT id, kind, subject, statement, status, confidence, scope_id,
            first_seen_at, last_seen_at, valid_from, invalid_at
     FROM memory_items
     WHERE id > ?
       AND status = 'active'
       AND confidence >= 0.5
       AND invalid_at IS NULL
     ORDER BY id ASC
     LIMIT ?`,
    lastId,
    BATCH_SIZE,
  );

  if (items.length === 0) return false;

  // Ensure the sentinel conversation exists for items without conversation linkage
  ensureLegacySentinelConversation();

  const db = getDb();
  const now = Date.now();

  for (const item of items) {
    try {
      // Every active item becomes an observation
      const observationId = uuid();
      const observationContent = `[${item.kind}] ${item.subject}: ${item.statement}`;

      db.insert(memoryObservations)
        .values({
          id: observationId,
          scopeId: item.scope_id,
          conversationId: LEGACY_SENTINEL_CONVERSATION_ID,
          role: "user",
          content: observationContent,
          modality: "text",
          source: "backfill:item",
          createdAt: now,
        })
        .run();

      // Create a chunk for the observation (with dedup)
      const contentHash = computeChunkContentHash(
        item.scope_id,
        observationContent,
      );
      const chunkId = uuid();
      const tokenEstimate = estimateTextTokens(observationContent);

      db.insert(memoryChunks)
        .values({
          id: chunkId,
          scopeId: item.scope_id,
          observationId,
          content: observationContent,
          tokenEstimate,
          contentHash,
          createdAt: now,
        })
        .onConflictDoNothing({
          target: [memoryChunks.scopeId, memoryChunks.contentHash],
        })
        .run();

      // Enqueue embedding for the observation's chunk
      enqueueMemoryJob("embed_chunk", { chunkId, scopeId: item.scope_id });

      // ── Brief-state: map unambiguous items to time_contexts or open_loops
      mapItemToBriefState(item, now);
    } catch (err) {
      log.warn({ err, itemId: item.id }, "Failed to migrate item, skipping");
    }
  }

  const lastItem = items[items.length - 1];
  setMemoryCheckpoint(CHECKPOINT_ITEMS, lastItem.id);

  log.debug(
    { migrated: items.length, lastId: lastItem.id },
    "Migrated item batch",
  );

  return items.length === BATCH_SIZE;
}

// ── Brief-state mapping ───────────────────────────────────────────────

/**
 * Map a legacy memory item to `time_contexts` or `open_loops` when the
 * mapping is unambiguous.
 *
 * - Items with `valid_from` and a future `invalid_at` -> time_context
 * - `event` kind items with future timestamps -> open_loop
 */
function mapItemToBriefState(item: LegacyItem, now: number): void {
  const db = getDb();

  // Time-bounded items -> time_contexts
  if (
    item.valid_from != null &&
    item.invalid_at != null &&
    item.invalid_at > now
  ) {
    db.insert(timeContexts)
      .values({
        id: uuid(),
        scopeId: item.scope_id,
        summary: `${item.subject}: ${item.statement}`,
        source: "backfill:item",
        activeFrom: item.valid_from,
        activeUntil: item.invalid_at,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return;
  }

  // Event items with future last_seen_at -> open_loops
  if (item.kind === "event" && item.last_seen_at > now) {
    db.insert(openLoops)
      .values({
        id: uuid(),
        scopeId: item.scope_id,
        summary: `${item.subject}: ${item.statement}`,
        source: "backfill:item",
        status: "open",
        dueAt: item.last_seen_at,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Extract a conversation ID from the summary's scope and scope_key.
 * Returns null for non-conversation summaries.
 */
function extractConversationId(scope: string, scopeKey: string): string | null {
  // Conversation summaries use scope "conversation" with scope_key as the ID
  if (scope === "conversation") return scopeKey;

  // Some summaries use "conversation:<id>" as scope_key
  const match = scopeKey.match(/^conversation:(.+)$/);
  if (match) return match[1];

  return null;
}

/**
 * Build a human-readable episode title from the summary's scope metadata.
 */
function buildEpisodeTitle(scope: string, scopeKey: string): string {
  if (scope === "conversation") {
    return `Conversation summary`;
  }
  if (scope === "weekly") {
    return `Weekly summary (${scopeKey})`;
  }
  if (scope === "monthly") {
    return `Monthly summary (${scopeKey})`;
  }
  return `${scope} summary`;
}
