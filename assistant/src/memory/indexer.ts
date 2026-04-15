import { createHash } from "crypto";
import { desc, eq } from "drizzle-orm";

import { getConfig } from "../config/loader.js";
import type { MemoryConfig } from "../config/types.js";
import type { TrustClass } from "../runtime/actor-trust-resolver.js";
import { getLogger } from "../util/logger.js";
import { enqueueAutoAnalysisIfEnabled } from "./auto-analysis-enqueue.js";
import { isAutoAnalysisConversation } from "./auto-analysis-guard.js";
import { getMemoryCheckpoint, setMemoryCheckpoint } from "./checkpoints.js";
import { getDb } from "./db.js";
import { selectedBackendSupportsMultimodal } from "./embedding-backend.js";
import { enqueueMemoryJob, upsertDebouncedJob } from "./jobs-store.js";
import {
  extractMediaBlockMeta,
  extractTextFromStoredMessageContent,
} from "./message-content.js";
import { memorySegments } from "./schema.js";
import { segmentText } from "./segmenter.js";

const log = getLogger("memory-indexer");

/** Minimum character length for a segment to be worth storing and embedding (~12-15 tokens). */
export const MIN_SEGMENT_CHARS = 50;

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
   * jobs run. Otherwise, the message is segmented and embedded but no
   * profile mutations are triggered.
   */
  provenanceTrustClass?: TrustClass;
  /** When true, the message was auto-sent by the client (e.g. wake-up greeting) and should not trigger memory extraction. */
  automated?: boolean;
}

export interface IndexMessageResult {
  indexedSegments: number;
  enqueuedJobs: number;
}

export async function indexMessageNow(
  input: IndexMessageInput,
  config: MemoryConfig,
): Promise<IndexMessageResult> {
  if (!config.enabled) return { indexedSegments: 0, enqueuedJobs: 0 };

  // Provenance-based trust gating: only guardian and legacy (undefined) actors
  // are trusted for extraction.
  const isTrustedActor =
    input.provenanceTrustClass === "guardian" ||
    input.provenanceTrustClass === undefined;

  const text = extractTextFromStoredMessageContent(input.content);
  if (text.length === 0) {
    return { indexedSegments: 0, enqueuedJobs: 0 };
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
  // Check if the message has any image blocks before probing the backend.
  // extractMediaBlockMeta is synchronous and lightweight — it detects image
  // blocks without decoding base64 data into Buffers, avoiding CPU/memory
  // overhead for messages on non-multimodal backends.
  // selectedBackendSupportsMultimodal requires async key resolution, so we
  // skip it entirely for text-only messages.
  const candidateMediaMeta = extractMediaBlockMeta(input.content).filter(
    (b) => b.type === "image",
  );
  const mediaBlocks =
    candidateMediaMeta.length > 0 &&
    (await selectedBackendSupportsMultimodal(getConfig()))
      ? candidateMediaMeta
      : [];

  // Wrap all segment inserts and job enqueues in a single transaction so they
  // either all succeed or all roll back, preventing partial/orphaned state.
  let skippedEmbedJobs = 0;
  let skippedShortSegments = 0;
  db.transaction((tx) => {
    for (const segment of segments) {
      if (segment.text.length < MIN_SEGMENT_CHARS) {
        skippedShortSegments++;
        continue;
      }
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
  });

  // ── Batch extraction tracking ──────────────────────────────────────
  // Instead of per-message extraction, track pending unextracted messages
  // and trigger batch extraction when the threshold is reached or after idle.
  const isAutoAnalysisSource = isAutoAnalysisConversation(input.conversationId);
  if (
    shouldExtract &&
    isTrustedActor &&
    !input.automated &&
    config.extraction.useLLM
  ) {
    const batchSize = config.extraction.batchSize ?? 10;
    const idleTimeoutMs = config.extraction.idleTimeoutMs ?? 300_000;

    // Recursion guard: skip graph extraction + auto-analysis enqueues
    // when the source conversation is itself an auto-analysis
    // conversation. The analysis agent writes memory directly via tools,
    // so extracting from its reflective musings would double-count and
    // analyzing its own output would loop indefinitely.
    // Summaries still run — they feed the graph retrieval pipeline and
    // are not recursion-prone.
    if (!isAutoAnalysisSource) {
      // ── Graph extraction ────────────────────────────────────────────
      const graphPendingKey = `graph_extract:${input.conversationId}:pending_count`;
      const graphCurrentVal = getMemoryCheckpoint(graphPendingKey);
      const graphPendingCount =
        (graphCurrentVal ? parseInt(graphCurrentVal, 10) : 0) + 1;
      setMemoryCheckpoint(graphPendingKey, String(graphPendingCount));

      if (graphPendingCount >= batchSize) {
        enqueueMemoryJob("graph_extract", {
          conversationId: input.conversationId,
          scopeId: input.scopeId ?? "default",
        });
        setMemoryCheckpoint(graphPendingKey, "0");
      }

      upsertDebouncedJob(
        "graph_extract",
        { conversationId: input.conversationId },
        Date.now() + idleTimeoutMs,
      );

      // ── Auto-analysis triggers ─────────────────────────────────────
      // Both triggers route through `upsertDebouncedJob` in the helper,
      // so a single pending row is shared. Order matters: the idle
      // upsert runs first (pushing `runAfter` into the future); the
      // batch trigger runs last so a threshold crossing pulls
      // `runAfter` back to "now" and overrides the idle debounce.
      enqueueAutoAnalysisIfEnabled({
        conversationId: input.conversationId,
        trigger: "idle",
      });

      // Auto-analysis cadence is tracked by its own pending-count
      // checkpoint so it fires at `analysis.batchSize` (default 30)
      // rather than piggy-backing on the extraction batch size.
      // Reading config here is best-effort: if it fails we skip the
      // batch trigger (the idle-debounced enqueue above still runs).
      let analysisBatchSize: number | null = null;
      try {
        analysisBatchSize = getConfig().analysis.batchSize;
      } catch (err) {
        log.debug(
          { err, conversationId: input.conversationId },
          "Skipping auto-analysis batch trigger: failed to load config",
        );
      }
      if (analysisBatchSize != null) {
        const analysisPendingKey = `conversation_analyze:${input.conversationId}:pending_count`;
        const analysisCurrentVal = getMemoryCheckpoint(analysisPendingKey);
        const analysisPendingCount =
          (analysisCurrentVal ? parseInt(analysisCurrentVal, 10) : 0) + 1;
        setMemoryCheckpoint(analysisPendingKey, String(analysisPendingCount));

        if (analysisPendingCount >= analysisBatchSize) {
          setMemoryCheckpoint(analysisPendingKey, "0");
          enqueueAutoAnalysisIfEnabled({
            conversationId: input.conversationId,
            trigger: "batch",
          });
        }
      }
    }

    // ── Conversation summarization (independent of extraction) ────────
    // Summaries feed the graph retrieval pipeline via fetchRecentSummaries().
    // Debounced on the same idle timeout — no threshold trigger needed since
    // summaries compress the whole conversation, not incremental batches.
    upsertDebouncedJob(
      "build_conversation_summary",
      { conversationId: input.conversationId },
      Date.now() + idleTimeoutMs,
    );
  }

  if (skippedShortSegments > 0) {
    log.debug(
      `Skipped ${skippedShortSegments}/${segments.length} segments shorter than ${MIN_SEGMENT_CHARS} chars`,
    );
  }

  if (skippedEmbedJobs > 0) {
    log.debug(
      `Skipped ${skippedEmbedJobs}/${segments.length} embed_segment jobs (content unchanged)`,
    );
  }

  if (!isTrustedActor && shouldExtract) {
    log.info(
      `Skipping extraction jobs for untrusted actor (trustClass=${input.provenanceTrustClass})`,
    );
  }

  if (input.automated && shouldExtract) {
    log.info("Skipping extraction jobs for automated message");
  }

  if (
    !config.extraction.useLLM &&
    shouldExtract &&
    isTrustedActor &&
    !input.automated
  ) {
    log.info(
      "Skipping extraction job: LLM extraction is disabled (useLLM=false)",
    );
  }

  if (
    isAutoAnalysisSource &&
    shouldExtract &&
    isTrustedActor &&
    !input.automated &&
    config.extraction.useLLM
  ) {
    log.debug(
      "Skipping graph_extract + auto-analysis enqueues: source is an auto-analysis conversation",
    );
  }

  const storedSegments = segments.length - skippedShortSegments;
  const enqueuedJobs = storedSegments - skippedEmbedJobs + mediaBlocks.length;
  return {
    indexedSegments: storedSegments,
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

function buildSegmentId(messageId: string, segmentIndex: number): string {
  return `${messageId}:${segmentIndex}`;
}
