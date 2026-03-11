import { createHash } from "crypto";
import { desc, eq } from "drizzle-orm";

import { getConfig } from "../config/loader.js";
import type { MemoryConfig } from "../config/types.js";
import type { TrustClass } from "../runtime/actor-trust-resolver.js";
import { getLogger } from "../util/logger.js";
import { getMemoryCheckpoint, setMemoryCheckpoint } from "./checkpoints.js";
import { getDb } from "./db.js";
import { selectedBackendSupportsMultimodal } from "./embedding-backend.js";
import {
  enqueueMemoryJob,
  enqueueResolvePendingConflictsForMessageJob,
} from "./jobs-store.js";
import {
  extractMediaBlocks,
  extractTextFromStoredMessageContent,
} from "./message-content.js";
import { bumpMemoryVersion } from "./recall-cache.js";
import { memorySegments } from "./schema.js";
import { segmentText } from "./segmenter.js";

const log = getLogger("memory-indexer");
const SUMMARY_JOB_CHECKPOINT_KEY = "memory:summary_jobs:last_scheduled_at";
const SUMMARY_SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface IndexMessageInput {
  messageId: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: number;
  scopeId?: string;
  /**
   * Trust class of the actor who produced this message, captured at
   * persist time. When `'guardian'` or `undefined` (legacy), extraction
   * and conflict resolution jobs run. Otherwise, the message is segmented
   * and embedded but no profile mutations are triggered.
   */
  provenanceTrustClass?: TrustClass;
}

export interface IndexMessageResult {
  indexedSegments: number;
  enqueuedJobs: number;
}

export function indexMessageNow(
  input: IndexMessageInput,
  config: MemoryConfig,
): IndexMessageResult {
  if (!config.enabled) return { indexedSegments: 0, enqueuedJobs: 0 };

  // Provenance-based trust gating: only guardian and legacy (undefined) actors
  // are trusted for extraction and conflict resolution.
  const isTrustedActor =
    input.provenanceTrustClass === "guardian" ||
    input.provenanceTrustClass === undefined;

  const text = extractTextFromStoredMessageContent(input.content);
  if (text.length === 0) {
    enqueueMemoryJob("build_conversation_summary", {
      conversationId: input.conversationId,
    });
    return { indexedSegments: 0, enqueuedJobs: 1 };
  }

  const db = getDb();
  const now = Date.now();
  const segments = segmentText(
    text,
    config.segmentation.targetTokens,
    config.segmentation.overlapTokens,
  );
  const shouldExtract =
    input.role === "user" ||
    (input.role === "assistant" && config.extraction.extractFromAssistant);
  const shouldResolveConflicts =
    input.role === "user" && config.conflicts.enabled;

  // Check if the resolved embedding backend supports multimodal input.
  // Only enqueue embed_attachment jobs when it does (currently Gemini only).
  const supportsMultimodal = selectedBackendSupportsMultimodal(getConfig());
  const mediaBlocks = supportsMultimodal
    ? extractMediaBlocks(input.content).filter((b) => b.type === "image")
    : [];

  // Wrap all segment inserts and job enqueues in a single transaction so they
  // either all succeed or all roll back, preventing partial/orphaned state.
  let skippedEmbedJobs = 0;
  db.transaction((tx) => {
    for (const segment of segments) {
      const segmentId = buildSegmentId(input.messageId, segment.segmentIndex);
      const hash = createHash("sha256").update(segment.text).digest("hex");

      // Check if this segment already exists with the same content hash
      const existing = tx
        .select({ contentHash: memorySegments.contentHash })
        .from(memorySegments)
        .where(eq(memorySegments.id, segmentId))
        .get();

      tx.insert(memorySegments)
        .values({
          id: segmentId,
          messageId: input.messageId,
          conversationId: input.conversationId,
          role: input.role,
          segmentIndex: segment.segmentIndex,
          text: segment.text,
          tokenEstimate: segment.tokenEstimate,
          scopeId: input.scopeId ?? "default",
          contentHash: hash,
          createdAt: input.createdAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: memorySegments.id,
          set: {
            text: segment.text,
            tokenEstimate: segment.tokenEstimate,
            scopeId: input.scopeId ?? "default",
            contentHash: hash,
            updatedAt: now,
          },
        })
        .run();

      if (existing?.contentHash === hash) {
        skippedEmbedJobs++;
      } else {
        enqueueMemoryJob("embed_segment", { segmentId }, Date.now(), tx);
      }
    }

    // Enqueue embed_attachment jobs for image content blocks when the
    // embedding provider supports multimodal (Gemini only).
    for (const block of mediaBlocks) {
      enqueueMemoryJob(
        "embed_attachment",
        { messageId: input.messageId, blockIndex: block.index },
        Date.now(),
        tx,
      );
    }

    if (shouldExtract && isTrustedActor) {
      enqueueMemoryJob(
        "extract_items",
        { messageId: input.messageId, scopeId: input.scopeId ?? "default" },
        Date.now(),
        tx,
      );
    }
    if (shouldResolveConflicts && isTrustedActor) {
      enqueueResolvePendingConflictsForMessageJob(
        input.messageId,
        input.scopeId ?? "default",
        tx,
      );
    }
    enqueueMemoryJob(
      "build_conversation_summary",
      { conversationId: input.conversationId },
      Date.now(),
      tx,
    );
  });

  if (skippedEmbedJobs > 0) {
    log.debug(
      `Skipped ${skippedEmbedJobs}/${segments.length} embed_segment jobs (content unchanged)`,
    );
  }

  // Invalidate recall cache when synchronous segment writes changed content,
  // so lexical/recency retrieval doesn't serve stale results during worker lag.
  if (segments.length - skippedEmbedJobs > 0) {
    bumpMemoryVersion();
  }

  if (!isTrustedActor && (shouldExtract || shouldResolveConflicts)) {
    log.info(
      `Skipping extraction/conflict jobs for untrusted actor (trustClass=${input.provenanceTrustClass})`,
    );
  }

  enqueueSummaryRollupJobsIfDue();

  const extractionGated = !isTrustedActor;
  const enqueuedJobs =
    segments.length -
    skippedEmbedJobs +
    mediaBlocks.length +
    (shouldExtract && !extractionGated ? 2 : 1) +
    (shouldResolveConflicts && !extractionGated ? 1 : 0);
  return {
    indexedSegments: segments.length,
    enqueuedJobs,
  };
}

export function enqueueBackfillJob(force = false): string {
  return enqueueMemoryJob("backfill", { force });
}

export function enqueueRebuildIndexJob(): string {
  return enqueueMemoryJob("rebuild_index", {});
}

export function getRecentSegmentsForConversation(
  conversationId: string,
  limit: number,
): Array<typeof memorySegments.$inferSelect> {
  const db = getDb();
  return db
    .select()
    .from(memorySegments)
    .where(eq(memorySegments.conversationId, conversationId))
    .orderBy(desc(memorySegments.createdAt))
    .limit(limit)
    .all();
}

function enqueueSummaryRollupJobsIfDue(): void {
  const now = Date.now();
  const raw = getMemoryCheckpoint(SUMMARY_JOB_CHECKPOINT_KEY);
  const last = raw ? Number.parseInt(raw, 10) : 0;
  if (Number.isFinite(last) && now - last < SUMMARY_SCHEDULE_INTERVAL_MS)
    return;

  enqueueMemoryJob("refresh_weekly_summary", {});
  enqueueMemoryJob("refresh_monthly_summary", {});
  setMemoryCheckpoint(SUMMARY_JOB_CHECKPOINT_KEY, String(now));
  log.debug("Scheduled periodic global summary jobs");
}

function buildSegmentId(messageId: string, segmentIndex: number): string {
  return `${messageId}:${segmentIndex}`;
}
