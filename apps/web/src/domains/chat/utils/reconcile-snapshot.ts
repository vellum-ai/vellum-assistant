import {
  dedupeDisplayMessages,
  reconcileDisplayMessagesWithLatestHistory,
  reconcileMessages,
} from "@/domains/chat/utils/reconcile";
import { reconcileMessagesWithSeq } from "@/domains/chat/utils/reconcile-with-seq";
import { isSeqGapDetectionEnabled } from "@/lib/feature-flags/seq-gap-detection-flag";
import { getAppliedSeq } from "@/lib/streaming/applied-seq";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { ConversationMessage } from "@vellumai/assistant-api";

/**
 * True when the live stream has carried this conversation past the snapshot's
 * watermark (`F > S`), meaning the snapshot is stale and applying it would
 * regress rows the stream already advanced. Both numbers must be known.
 */
function isStreamAheadOfSnapshot(
  conversationId: string,
  snapshotSeq: number | null,
): boolean {
  const appliedSeq = getAppliedSeq(conversationId);
  return (
    snapshotSeq != null && appliedSeq != null && snapshotSeq < appliedSeq
  );
}

/**
 * Single entry point for merging a `/messages` snapshot into the local
 * transcript, routing between the legacy heuristic reconcile and the seq-aware
 * monotonic merge based on `isSeqGapDetectionEnabled()`.
 *
 * Pure with respect to module state (it only reads the applied frontier), so
 * it is safe to call inside a React state updater. Advancing the frontier
 * (`recordAppliedSeq`) is the caller's responsibility and must run outside the
 * updater.
 */
export interface ReconcileSnapshotOptions {
  conversationId: string;
  /** Watermark `seq` the snapshot was persisted at (top-level `/messages` seq). */
  snapshotSeq: number | null;
  oldestPageTimestamp?: number | null;
}

export function reconcileSnapshot(
  local: DisplayMessage[],
  server: ConversationMessage[],
  options: ReconcileSnapshotOptions,
): DisplayMessage[] {
  if (!isSeqGapDetectionEnabled()) {
    return reconcileMessages(local, server, {
      oldestPageTimestamp: options.oldestPageTimestamp,
    });
  }

  return reconcileMessagesWithSeq(local, server, {
    snapshotSeq: options.snapshotSeq,
    appliedSeq: getAppliedSeq(options.conversationId),
    oldestPageTimestamp: options.oldestPageTimestamp,
  });
}

/**
 * Seq-aware variant of the latest-history merge used when a freshly fetched
 * latest page is applied over a transcript restored from the in-memory cache.
 *
 * The cache-merge can recover live-only SSE events the cache missed, but a
 * stale latest page (`F > S`) would instead regress rows the stream already
 * advanced past `S`. When the seq flag is on and the stream is ahead, the
 * local transcript is kept as-is; otherwise the merge runs unchanged. No
 * behavior change while the flag is off.
 */
export interface ReconcileLatestHistoryOptions {
  conversationId: string;
  /** Watermark `seq` of the latest history page (`latestPage.seq`). */
  snapshotSeq: number | null;
  isProcessing: boolean;
}

export function reconcileLatestHistorySnapshot(
  current: DisplayMessage[],
  latestHistory: DisplayMessage[],
  options: ReconcileLatestHistoryOptions,
): DisplayMessage[] {
  if (
    isSeqGapDetectionEnabled() &&
    isStreamAheadOfSnapshot(options.conversationId, options.snapshotSeq)
  ) {
    return dedupeDisplayMessages(current);
  }

  return reconcileDisplayMessagesWithLatestHistory(
    current,
    latestHistory,
    options.isProcessing,
  );
}

