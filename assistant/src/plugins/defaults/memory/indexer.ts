import {
  type ContentBlock,
  extractTextFromStoredMessageContent,
  selectedBackendSupportsMultimodal,
} from "@vellumai/plugin-api";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";

import { getConfig } from "../../../config/loader.js";
import {
  isMemoryV1Active,
  usesConceptPageMemory,
} from "../../../config/memory-v3-gate.js";
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
import { memorySegments, messages } from "../../../persistence/schema/index.js";
import type { TrustClass } from "../../../runtime/actor-trust-resolver.js";
import { isAutoAnalysisConversation } from "../../../runtime/services/auto-analysis-guard.js";
import { getLogger } from "./logging.js";
import { memoryDbOrNull } from "./memory-db.js";
import { isMemoryRetrospectiveConversation } from "./memory-retrospective-enqueue.js";
import { maybeEnqueueRetrospective } from "./memory-retrospective-trigger-check.js";
import { extractMediaBlockMeta } from "./message-media.js";
import { segmentText } from "./segmenter.js";
// SUBSTRATE (v2+v3) — the only tier-owned import here; the v1 triggers reach
// their work through job-type strings alone.
import { resolveSubstrateTuning } from "./substrate/tuning.js";

const log = getLogger("memory-indexer");

/** Minimum character length for a segment to be worth storing and embedding (~12-15 tokens). */
export const MIN_SEGMENT_CHARS = 50;

export interface IndexMessageInput {
  messageId: string;
  conversationId: string;
  role: string;
  content: string | ContentBlock[];
  createdAt: number;
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

  const mem = memoryDbOrNull("indexMessageNow");
  if (!mem) {
    return { indexedSegments: 0, enqueuedJobs: 0 };
  }
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

  // memory_segments has no cross-file FK to messages, so this call must not
  // leave pieces for a message with no row. Skip early when the source
  // row is already gone, the common case of a backfill job running after the
  // message was deleted. Any-state existence check, deliberately: a
  // streaming row exists, and orphan prevention is about deletion, not
  // completeness. A post-write re-check below closes the narrower window
  // where the delete lands mid-transaction.
  const sourceMessage = getDb()
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.id, input.messageId))
    .get();
  if (!sourceMessage) {
    return { indexedSegments: 0, enqueuedJobs: 0 };
  }

  mem.transaction((tx) => {
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
          contentHash: hash,
          createdAt: input.createdAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: memorySegments.id,
          set: {
            text: segment.text,
            tokenEstimate: segment.tokenEstimate,
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

  // Re-check the source message after committing: the preflight leaves a window
  // where a delete lands between it and this write. If the message is gone now,
  // drop the pieces this call just wrote and skip the embedding jobs, so a
  // delete racing a backfill leaves nothing searchable behind. No embeddings
  // exist yet. The skipped jobs are what would have created them.
  const stillExists = getDb()
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.id, input.messageId))
    .get();
  if (!stillExists) {
    mem
      .delete(memorySegments)
      .where(eq(memorySegments.messageId, input.messageId))
      .run();
    return { indexedSegments: 0, enqueuedJobs: 0 };
  }

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

    // Reading config here is best-effort: when it fails we treat
    // concept-page memory as inactive (failing-open to v1) so a config
    // error never silently drops the extraction or summarization paths.
    let triggerConfig: ReturnType<typeof getConfig> | null = null;
    try {
      triggerConfig = getConfig();
    } catch (err) {
      log.debug(
        { err, conversationId: input.conversationId },
        "Skipping feature-gated extraction triggers: failed to load config",
      );
    }

    const conceptConfig =
      triggerConfig != null && usesConceptPageMemory(triggerConfig.memory)
        ? triggerConfig
        : null;

    // Per-tier trigger dispatch, three-way. Memory off enqueues nothing: no
    // tier is live, and the pending counts the v1 arm would accumulate
    // meanwhile fire an immediate batch on a later switch back to v1. The v1
    // extraction/summarization triggers run when the legacy graph engine is
    // the live tier, and the substrate sweep trigger runs under a concept-page
    // consumer. `isAutoAnalysisSource` is the recursion guard threaded into
    // both live arms: the analysis agent writes memory directly via tools, so
    // extracting from its reflective musings would double-count and analyzing
    // its own output would loop indefinitely.
    if (conceptConfig == null) {
      // A null `conceptConfig` covers two states — v1 live and memory off — so
      // the v1 arm asks the named predicate rather than assuming v1. A failed
      // config load leaves `triggerConfig` null and fails open to v1: a
      // transient read error must not silently drop indexing.
      if (triggerConfig == null || isMemoryV1Active(triggerConfig)) {
        // V1 — delete with v1. Dropping only the banner-marked function body
        // below would leave this call dangling: collapse the branch to the
        // substrate arm.
        enqueueV1IndexTriggers(
          input.conversationId,
          isAutoAnalysisSource,
          batchSize,
          idleTimeoutMs,
        );
      }
    } else {
      enqueueSubstrateIndexTriggers(
        input.conversationId,
        conceptConfig,
        isAutoAnalysisSource,
        idleTimeoutMs,
      );
    }

    // ── Memory retrospective triggers (all tiers) ─────────────────────
    // The retrospective is a focused,
    // memory-only pass that re-reads messages since its last successful
    // run and saves what the in-conversation `remember` calls didn't
    // capture. Triggers (interval / message_count) are evaluated by
    // `maybeEnqueueRetrospective`, which also enforces the per-conversation
    // cooldown gate against retry storms. Recursion guards skip auto-analysis
    // conversations and the memory-retrospective background conversation
    // itself.
    if (
      !isAutoAnalysisSource &&
      triggerConfig != null &&
      !isMemoryRetrospectiveConversation(input.conversationId)
    ) {
      maybeEnqueueRetrospective(input.conversationId, triggerConfig);
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

// ── V1 index-time triggers — delete with v1 ───────────────────────

/**
 * V1 extraction/summarization triggers; run only when the legacy graph engine
 * is the live tier (`isMemoryV1Active` — under the substrate, and with memory
 * off, the v1 graph and `memorySummaries` would be stale data nobody consumes,
 * and pending-count tracking is suppressed too so a later switch back to v1
 * does not fire an immediate batch from counts accumulated in the meantime).
 *
 * Tracks the per-conversation pending-message count to debounce the
 * `graph_extract` batch job, and debounces the conversation-summary build
 * that feeds the v1 graph retrieval pipeline (fetchRecentSummaries, semantic
 * search).
 *
 * `isAutoAnalysisSource` suppresses only the graph-extraction arm — summaries
 * compress the whole conversation and build for auto-analysis conversations
 * too.
 */
function enqueueV1IndexTriggers(
  conversationId: string,
  isAutoAnalysisSource: boolean,
  batchSize: number,
  idleTimeoutMs: number,
): void {
  if (!isAutoAnalysisSource) {
    const graphPendingKey = `graph_extract:${conversationId}:pending_count`;
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
    const extractRunAfter = graphBatchFired
      ? Date.now()
      : Date.now() + idleTimeoutMs;
    if (isMemoryEnabled()) {
      upsertDebouncedJob("graph_extract", { conversationId }, extractRunAfter);
    }
  }

  // Conversation summarization. Stale v1 rows are short-circuited at
  // dispatch in jobs-worker.ts. Debounced on the same idle timeout — no
  // threshold trigger needed since summaries compress the whole
  // conversation, not incremental batches.
  if (isMemoryEnabled()) {
    upsertDebouncedJob(
      "build_conversation_summary",
      { conversationId },
      Date.now() + idleTimeoutMs,
    );
  }
}

// ── SUBSTRATE (v2+v3) index-time triggers ─────────────────────────

/**
 * Substrate index-time trigger; runs while concept-page memory is active.
 * When `sweep_enabled` is set, every extraction trigger debounces a
 * `memory_v2_sweep`. The sweep itself reads recent messages globally, so the
 * `conversationId` here is just the dedup key — one pending row per active
 * conversation. `sweep_enabled` defaults to false because `remember()` is
 * the primary capture path; the sweep is opt-in.
 *
 * `isAutoAnalysisSource` is the same recursion guard the v1 arm applies: the
 * analysis agent writes memory directly, so its output is never swept.
 */
function enqueueSubstrateIndexTriggers(
  conversationId: string,
  conceptConfig: ReturnType<typeof getConfig>,
  isAutoAnalysisSource: boolean,
  idleTimeoutMs: number,
): void {
  if (isAutoAnalysisSource) {
    return;
  }
  if (resolveSubstrateTuning(conceptConfig.memory).sweep_enabled) {
    upsertDebouncedJob(
      "memory_v2_sweep",
      { conversationId },
      Date.now() + idleTimeoutMs,
    );
  }
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
