import { v4 as uuid } from "uuid";

import { getLogger } from "../util/logger.js";
import { getDb } from "./db.js";
import { enqueueMemoryJob, type MemoryJobType } from "./jobs-store.js";
import { memoryEpisodes } from "./schema.js";

const log = getLogger("memory-archive-store");

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

// ── Internal ────────────────────────────────────────────────────────

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
