import {
  extractTextFromStoredMessageContent,
  selectedBackendSupportsMultimodal,
} from "@vellumai/plugin-api";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";

import { isAssistantFeatureFlagEnabled } from "../../../config/assistant-feature-flags.js";
import { getConfig } from "../../../config/loader.js";
import type { MemoryConfig } from "../../../config/types.js";
import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../../../persistence/checkpoints.js";
import { getDb } from "../../../persistence/db-connection.js";
import {
  enqueueMemoryJob,
  isMemoryEnabled,
  upsertDebouncedJob,
} from "../../../persistence/jobs-store.js";
import { memorySegments } from "../../../persistence/schema/index.js";
import type { TrustClass } from "../../../runtime/actor-trust-resolver.js";
import { enqueueAutoAnalysisIfEnabled } from "../../../runtime/services/auto-analysis-enqueue.js";
import { isAutoAnalysisConversation } from "../../../runtime/services/auto-analysis-guard.js";
import { getLogger } from "../../../util/logger.js";
import { isMemoryRetrospectiveConversation } from "./memory-retrospective-enqueue.js";
import { maybeEnqueueRetrospective } from "./memory-retrospective-trigger-check.js";
import { extractMediaBlockMeta } from "./message-media.js";
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
  if (!config.enabled) {
    return { indexedSegments: 0, enqueuedJobs: 0 };
  }

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
    candidateMediaMeta.length > 0 && (await selectedBackendSupportsMultimodal())
      ? candidateMediaMeta
      : [];

  // Wrap all segment inserts in a single transaction so they either all
  // succeed or all roll back, preventing partial/orphaned state. The job
  // enqueues target the dedicated memory connection (`memory_jobs` lives in
  // its own file), so they can't share this main-DB transaction — collect them
  // here and flush them after the transaction commits.
  let skippedEmbedJobs = 0;
  let skippedShortSegments = 0;
  const pendingJobs: Array<{
    type: "embed_segment" | "embed_attachment";
    payload: Record<string, unknown>;
  }> = [];
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
      } else if (isMemoryEnabled()) {
        pendingJobs.push({ type: "embed_segment", payload: { segmentId } });
      }
    }

    // Enqueue embed_attachment jobs for image content blocks when the
    // embedding provider supports multimodal (Gemini only).
    if (isMemoryEnabled()) {
      for (const block of mediaBlocks) {
        pendingJobs.push({
          type: "embed_attachment",
          payload: { messageId: input.messageId, blockIndex: block.index },
        });
      }
    }
  });

  // Flush queued jobs onto the memory connection now the segment writes have
  // committed — enqueue only on success, mirroring the prior in-transaction
  // behavior without spanning the two connections.
  for (const job of pendingJobs) {
    enqueueMemoryJob(job.type, job.payload);
  }

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

    // Reading config here is best-effort: when it fails we treat v2 as
    // inactive (failing-open to v1) so a config error never silently
    // drops the extraction or summarization paths.
    let triggerConfig: ReturnType<typeof getConfig> | null = null;
    try {
      triggerConfig = getConfig();
    } catch (err) {
      log.debug(
        { err, conversationId: input.conversationId },
        "Skipping feature-gated extraction triggers: failed to load config",
      );
    }

    const v2Config =
      triggerConfig != null && triggerConfig.memory.v2.enabled
        ? triggerConfig
        : null;

    // Recursion guard: skip graph extraction + auto-analysis enqueues
    // when the source conversation is itself an auto-analysis
    // conversation. The analysis agent writes memory directly via tools,
    // so extracting from its reflective musings would double-count and
    // analyzing its own output would loop indefinitely.
    if (!isAutoAnalysisSource) {
      // ── Graph extraction (v1) ───────────────────────────────────────
      // Suppressed when v2 is active — v2 reads memory from buffer.md
      // and concept pages, so the v1 graph would be stale data nobody
      // consumes. Pending-count tracking is suppressed too; otherwise a
      // flag flip back to v1 would fire an immediate batch from counts
      // accumulated during the v2 window.
      let extractRunAfter: number;
      if (v2Config == null) {
        const graphPendingKey = `graph_extract:${input.conversationId}:pending_count`;
        const graphCurrentVal = getMemoryCheckpoint(graphPendingKey);
        const graphPendingCount =
          (graphCurrentVal ? parseInt(graphCurrentVal, 10) : 0) + 1;
        setMemoryCheckpoint(graphPendingKey, String(graphPendingCount));

        const graphBatchFired = graphPendingCount >= batchSize;
        if (graphBatchFired) {
          setMemoryCheckpoint(graphPendingKey, "0");
        }

        // Single pending `graph_extract` row per conversation. If the
        // batch threshold just fired, pull `runAfter` back to now so the
        // job runs immediately; otherwise debounce by the idle timeout.
        // Routing both paths through `upsertDebouncedJob` ensures the
        // row's `runAfter` reflects whichever trigger ran last, so a
        // batch crossing always takes effect immediately.
        extractRunAfter = graphBatchFired
          ? Date.now()
          : Date.now() + idleTimeoutMs;
        if (isMemoryEnabled()) {
          upsertDebouncedJob(
            "graph_extract",
            {
              conversationId: input.conversationId,
              scopeId: input.scopeId ?? "default",
            },
            extractRunAfter,
          );
        }
      } else {
        extractRunAfter = Date.now() + idleTimeoutMs;
      }

      // Memory v2 sweep: when v2 is on AND `sweep_enabled` is set, every
      // extraction trigger also enqueues a sweep. The sweep itself reads
      // recent messages globally, so the `conversationId` here is just
      // the dedup key — one pending row per active conversation.
      // `sweep_enabled` defaults to false because `remember()` is the
      // primary capture path; the sweep is opt-in.
      if (v2Config != null && v2Config.memory.v2.sweep_enabled) {
        upsertDebouncedJob(
          "memory_v2_sweep",
          { conversationId: input.conversationId },
          extractRunAfter,
        );
      }

      // ── Auto-analysis triggers ─────────────────────────────────────
      // Immediate triggers (batch, compaction) and debounced triggers
      // (idle, lifecycle) write to separate rows keyed by triggerGroup
      // via `upsertAutoAnalysisJob`. When an immediate trigger fires,
      // it cancels any pending debounced row for the same conversation
      // to avoid redundant analysis runs.
      enqueueAutoAnalysisIfEnabled({
        conversationId: input.conversationId,
        trigger: "idle",
      });

      // Auto-analysis cadence is tracked by its own pending-count
      // checkpoint so it fires at `analysis.batchSize` (default 30).
      // Gated behind the `auto-analyze` feature flag so the counter
      // does not accumulate stale counts while the flag is off — if it
      // did, flipping the flag on would trigger an immediate batch from
      // messages buffered during the disabled period.
      if (
        triggerConfig != null &&
        isAssistantFeatureFlagEnabled("auto-analyze", triggerConfig)
      ) {
        const analysisBatchSize = triggerConfig.analysis.batchSize;
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

      // ── Memory retrospective triggers ─────────────────────────────────
      // Independent of auto-analyze: the retrospective is a focused,
      // memory-only pass that re-reads messages since its last successful
      // run and saves what the in-conversation `remember` calls didn't
      // capture. Triggers (interval / message_count) are evaluated by
      // `maybeEnqueueRetrospective`, which also enforces the per-conversation
      // cooldown gate against retry storms. Recursion guard skips the
      // memory-retrospective background conversation itself.
      if (
        triggerConfig != null &&
        !isMemoryRetrospectiveConversation(input.conversationId)
      ) {
        maybeEnqueueRetrospective(input.conversationId, triggerConfig);
      }
    }

    // ── Conversation summarization (v1) ───────────────────────────────
    // Summaries feed the v1 graph retrieval pipeline (fetchRecentSummaries,
    // semantic search). Suppressed when v2 is active — v2 readers (concept
    // pages, activation pipeline) do not consume `memorySummaries`, so the
    // summarization LLM call would produce rows nothing reads. Stale rows
    // from before v2 was enabled are short-circuited at dispatch in
    // jobs-worker.ts. Debounced on the same idle timeout — no threshold
    // trigger needed since summaries compress the whole conversation, not
    // incremental batches.
    if (v2Config == null && isMemoryEnabled()) {
      upsertDebouncedJob(
        "build_conversation_summary",
        { conversationId: input.conversationId },
        Date.now() + idleTimeoutMs,
      );
    }
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
  if (!isMemoryEnabled()) {
    return "";
  }
  return enqueueMemoryJob("backfill", { force });
}

export function enqueueRebuildIndexJob(): string {
  if (!isMemoryEnabled()) {
    return "";
  }
  return enqueueMemoryJob("rebuild_index", {});
}

function buildSegmentId(messageId: string, segmentIndex: number): string {
  return `${messageId}:${segmentIndex}`;
}
