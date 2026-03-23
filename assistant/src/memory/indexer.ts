import { createHash } from "crypto";
import { desc, eq } from "drizzle-orm";

import { getConfig } from "../config/loader.js";
import type { MemoryConfig } from "../config/types.js";
import type { TrustClass } from "../runtime/actor-trust-resolver.js";
import { getLogger } from "../util/logger.js";
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

/** Delay before a conversation summary job becomes eligible to run.
 *  Each new message in the same conversation resets the timer, so the
 *  summary is only built once the conversation has been idle for this long. */
const SUMMARY_DEBOUNCE_MS = 3 * 60 * 1000; // 3 minutes

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
    upsertDebouncedJob(
      "build_conversation_summary",
      { conversationId: input.conversationId },
      Date.now() + SUMMARY_DEBOUNCE_MS,
    );
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

    if (shouldExtract && isTrustedActor && !input.automated) {
      enqueueMemoryJob(
        "extract_items",
        { messageId: input.messageId, scopeId: input.scopeId ?? "default" },
        Date.now(),
        tx,
      );
    }
  });

  // Debounced outside the transaction — each new message pushes the summary
  // job's runAfter forward so it only fires once the conversation is idle.
  upsertDebouncedJob(
    "build_conversation_summary",
    { conversationId: input.conversationId },
    Date.now() + SUMMARY_DEBOUNCE_MS,
  );

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

  const extractionGated = !isTrustedActor || !!input.automated;
  const enqueuedJobs =
    segments.length -
    skippedEmbedJobs +
    mediaBlocks.length +
    (shouldExtract && !extractionGated ? 2 : 1);
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

function buildSegmentId(messageId: string, segmentIndex: number): string {
  return `${messageId}:${segmentIndex}`;
}
