import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { estimateTextTokens } from "../context/token-estimator.js";
import { getLogger } from "../util/logger.js";
import { getDb, rawChanges } from "./db.js";
import { enqueueMemoryJob, type MemoryJobType } from "./jobs-store.js";
import {
  memoryChunks,
  memoryEpisodes,
  memoryObservations,
} from "./schema.js";

const log = getLogger("memory-archive-store");

// ── Content hashing ─────────────────────────────────────────────────

/**
 * Compute a SHA-256 content hash for a chunk's content, scoped by scopeId.
 * Used for idempotent upserts — if the hash already exists within the same
 * scope, the chunk is skipped.
 */
export function computeChunkContentHash(
  scopeId: string,
  content: string,
): string {
  return createHash("sha256").update(`${scopeId}|${content}`).digest("hex");
}

/**
 * Compute a SHA-256 hash of the observation content, scoped by scopeId.
 * Used for idempotent chunk deduplication.
 */
export function computeObservationContentHash(
  scopeId: string,
  content: string,
): string {
  return createHash("sha256").update(`${scopeId}|${content}`).digest("hex");
}

// ── Token estimation ────────────────────────────────────────────────

/**
 * Rough token count estimate based on character length.
 * Uses the common ~4 chars/token heuristic for English text.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

// ── Chunk upsert ────────────────────────────────────────────────────

export interface UpsertChunkInput {
  /** Scope for memory isolation. Defaults to "default". */
  scopeId?: string;
  /** FK to the parent observation. */
  observationId: string;
  /** The chunk text to embed and recall. */
  content: string;
  /** Optional pre-computed token estimate. If omitted, estimated from content length. */
  tokenEstimate?: number;
}

export interface UpsertChunkResult {
  chunkId: string;
  /** True if a new row was inserted; false if an existing row matched the content hash. */
  inserted: boolean;
}

/**
 * Idempotently upsert a chunk into the archive. If a chunk with the same
 * (scopeId, contentHash) already exists, the insert is skipped and the
 * existing row's id is returned. Otherwise a new row is inserted and an
 * `embed_chunk` job is enqueued.
 */
export function upsertChunk(input: UpsertChunkInput): UpsertChunkResult {
  const scopeId = input.scopeId ?? "default";
  const contentHash = computeChunkContentHash(scopeId, input.content);
  const tokenEstimate = input.tokenEstimate ?? estimateTokens(input.content);
  const db = getDb();

  // Check for an existing chunk with the same content hash in this scope
  const existing = db
    .select({ id: memoryChunks.id })
    .from(memoryChunks)
    .where(eq(memoryChunks.contentHash, contentHash))
    .get();

  if (existing) {
    log.debug(
      { scopeId, contentHash, existingId: existing.id },
      "Chunk already exists, skipping insert",
    );
    return { chunkId: existing.id, inserted: false };
  }

  const chunkId = uuid();
  const now = Date.now();

  db.insert(memoryChunks)
    .values({
      id: chunkId,
      scopeId,
      observationId: input.observationId,
      content: input.content,
      tokenEstimate,
      contentHash,
      createdAt: now,
    })
    .run();

  // Enqueue an embedding job for the new chunk
  enqueueMemoryJob("embed_chunk", {
    chunkId,
    scopeId,
  });

  log.debug(
    { chunkId, scopeId, contentHash },
    "Inserted new chunk and enqueued embed_chunk job",
  );

  return { chunkId, inserted: true };
}

/**
 * Upsert multiple chunks for a single observation. Returns results for
 * each input in the same order.
 */
export function upsertChunks(inputs: UpsertChunkInput[]): UpsertChunkResult[] {
  return inputs.map((input) => upsertChunk(input));
}

// ── Chunk queries ───────────────────────────────────────────────────

/**
 * Get a chunk by its ID.
 */
export function getChunkById(
  chunkId: string,
): typeof memoryChunks.$inferSelect | undefined {
  const db = getDb();
  return db
    .select()
    .from(memoryChunks)
    .where(eq(memoryChunks.id, chunkId))
    .get();
}

/**
 * Get all chunks for a given observation.
 */
export function getChunksByObservationId(
  observationId: string,
): Array<typeof memoryChunks.$inferSelect> {
  const db = getDb();
  return db
    .select()
    .from(memoryChunks)
    .where(eq(memoryChunks.observationId, observationId))
    .all();
}

// ── Episode insertion helpers ───────────────────────────────────────

export interface InsertEpisodeParams {
  scopeId?: string;
  conversationId: string;
  title: string;
  summary: string;
  tokenEstimate: number;
  source?: string;
  startAt: number;
  endAt: number;
}

/**
 * Insert an episode row produced by conversation compaction.
 * Compaction episodes summarize a contiguous block of turns that was
 * compressed to free context-window space.
 *
 * An `embed_episode` job is enqueued automatically so the episode
 * becomes searchable via vector recall.
 */
export function insertCompactionEpisode(params: InsertEpisodeParams): {
  episodeId: string;
  jobId: string;
} {
  return insertEpisodeAndEnqueue(params);
}

/**
 * Insert an episode row produced by resolution (end-of-conversation)
 * summarization. Resolution episodes capture the full narrative arc
 * of a completed conversation.
 *
 * An `embed_episode` job is enqueued automatically so the episode
 * becomes searchable via vector recall.
 */
export function insertResolutionEpisode(params: InsertEpisodeParams): {
  episodeId: string;
  jobId: string;
} {
  return insertEpisodeAndEnqueue(params);
}

// ── Internal (episode) ──────────────────────────────────────────────

function insertEpisodeAndEnqueue(params: InsertEpisodeParams): {
  episodeId: string;
  jobId: string;
} {
  const db = getDb();
  const episodeId = uuid();
  const now = Date.now();

  db.insert(memoryEpisodes)
    .values({
      id: episodeId,
      scopeId: params.scopeId ?? "default",
      conversationId: params.conversationId,
      title: params.title,
      summary: params.summary,
      tokenEstimate: params.tokenEstimate,
      source: params.source ?? null,
      startAt: params.startAt,
      endAt: params.endAt,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const jobId = enqueueMemoryJob("embed_episode" satisfies MemoryJobType, {
    episodeId,
  });

  log.debug(
    { episodeId, jobId, conversationId: params.conversationId },
    "Inserted episode and enqueued embed job",
  );

  return { episodeId, jobId };
}

// ── Observation types ───────────────────────────────────────────────

export interface InsertObservationParams {
  conversationId: string;
  messageId?: string | null;
  role: string;
  content: string;
  scopeId?: string;
  modality?: string;
  source?: string | null;
}

export interface InsertedObservation {
  observationId: string;
  chunkId: string | null;
  contentHash: string;
  embeddingJobId: string | null;
}

// ── Observation insert helpers ──────────────────────────────────────

/**
 * Insert a raw observation row and its associated chunk. If a chunk with the
 * same content hash already exists in the scope, the chunk insert is skipped
 * (idempotent dual-write safety). An `embed_observation` job is enqueued when
 * a new chunk is created.
 *
 * Returns the observation ID, chunk ID (null if deduplicated), content hash,
 * and embedding job ID (null if no new chunk was created).
 */
export function insertObservation(
  params: InsertObservationParams,
): InsertedObservation {
  const db = getDb();
  const now = Date.now();
  const scopeId = params.scopeId ?? "default";
  const modality = params.modality ?? "text";

  const observationId = uuid();
  const contentHash = computeObservationContentHash(scopeId, params.content);

  // Insert the observation row
  db.insert(memoryObservations)
    .values({
      id: observationId,
      scopeId,
      conversationId: params.conversationId,
      messageId: params.messageId ?? null,
      role: params.role,
      content: params.content,
      modality,
      source: params.source ?? null,
      createdAt: now,
    })
    .run();

  // Attempt to insert the chunk — the unique index on (scope_id, content_hash)
  // will cause a conflict if this content was already chunked. We use
  // onConflictDoNothing to silently skip the duplicate.
  const chunkId = uuid();
  const tokenEstimate = estimateTextTokens(params.content);

  db.insert(memoryChunks)
    .values({
      id: chunkId,
      scopeId,
      observationId,
      content: params.content,
      tokenEstimate,
      contentHash,
      createdAt: now,
    })
    .onConflictDoNothing({
      target: [memoryChunks.scopeId, memoryChunks.contentHash],
    })
    .run();

  // Drizzle bun:sqlite .run() returns void; use rawChanges() to detect no-ops
  const chunkInserted = rawChanges() > 0;

  let embeddingJobId: string | null = null;
  if (chunkInserted) {
    embeddingJobId = enqueueMemoryJob("embed_observation", {
      observationId,
      chunkId,
    });
    log.debug(
      { observationId, chunkId, contentHash, embeddingJobId },
      "Inserted observation with new chunk, enqueued embed job",
    );
  } else {
    log.debug(
      { observationId, contentHash },
      "Inserted observation, chunk deduplicated by content hash",
    );
  }

  return {
    observationId,
    chunkId: chunkInserted ? chunkId : null,
    contentHash,
    embeddingJobId,
  };
}

/**
 * Insert multiple observations in a single transaction.
 * Returns the results for each insertion.
 */
export function insertObservations(
  observations: InsertObservationParams[],
): InsertedObservation[] {
  const db = getDb();
  const results: InsertedObservation[] = [];
  db.transaction((tx) => {
    // We don't use `tx` directly for individual inserts because
    // insertObservation uses getDb() internally. Instead, the transaction
    // wrapper ensures atomicity at the SQLite level.
    void tx;
    for (const obs of observations) {
      results.push(insertObservation(obs));
    }
  });
  return results;
}

/**
 * Look up an observation by ID.
 */
export function getObservation(
  observationId: string,
): typeof memoryObservations.$inferSelect | undefined {
  const db = getDb();
  return db
    .select()
    .from(memoryObservations)
    .where(eq(memoryObservations.id, observationId))
    .get();
}

/**
 * Look up a chunk by observation ID. Returns the first chunk linked to the
 * given observation, or undefined if none exists.
 */
export function getChunkByObservationId(
  observationId: string,
): typeof memoryChunks.$inferSelect | undefined {
  const db = getDb();
  return db
    .select()
    .from(memoryChunks)
    .where(eq(memoryChunks.observationId, observationId))
    .get();
}
