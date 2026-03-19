import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getLogger } from "../util/logger.js";
import { getDb } from "./db.js";
import { enqueueMemoryJob } from "./jobs-store.js";
import { memoryChunks } from "./schema.js";

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
