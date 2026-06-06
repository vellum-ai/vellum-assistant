import {
  reconcileDisplayMessagesWithLatestHistory,
  reconcileMessages,
} from "@/domains/chat/utils/reconcile";
import { reconcileMessagesWithSeq } from "@/domains/chat/utils/reconcile-with-seq";
import { mapRuntimeToDisplayMessage } from "@/domains/chat/utils/map-runtime-message";
import { isSeqGapDetectionEnabled } from "@/lib/feature-flags/seq-gap-detection-flag";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { ConversationMessage } from "@vellumai/assistant-api";

/**
 * Single entry point for merging a `/messages` snapshot into the local
 * transcript, routing between the legacy heuristic reconcile and the seq-aware
 * monotonic merge based on `isSeqGapDetectionEnabled()`.
 *
 * Fully pure (reads no module state): the caller passes the applied frontier
 * `F` — captured before advancing it — so the seq-aware merge can tell whether
 * this snapshot advanced the frontier. Advancing the frontier
 * (`recordAppliedSeq`) is the caller's responsibility and must run outside the
 * updater.
 */
export interface ReconcileSnapshotOptions {
  /** Watermark `seq` the snapshot was persisted at (top-level `/messages` seq). */
  snapshotSeq: number | null;
  /** Applied frontier `F` as of before this snapshot is applied. */
  appliedSeq: number | null;
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

  return reconcileMessagesWithSeq(local, server.map(mapRuntimeToDisplayMessage), {
    snapshotSeq: options.snapshotSeq,
    appliedSeq: options.appliedSeq,
    oldestPageTimestamp: options.oldestPageTimestamp,
  });
}

/**
 * Apply a freshly fetched latest page over a transcript restored from the
 * in-memory cache (the initial-load path).
 *
 * When the seq flag is on this routes through the single authoritative
 * `reconcileMessagesWithSeq`, so initial load uses the same monotonic merge as
 * every other snapshot-apply site: a stale page (`F > S`) keeps the live local
 * rows, a fresh page (`S >= F`) is authoritative. The latest page is already a
 * projected `DisplayMessage[]`, so it feeds the merge directly. While the flag
 * is off, the legacy cache-merge runs unchanged.
 */
export interface ReconcileLatestHistoryOptions {
  /** Watermark `seq` of the latest history page (`latestPage.seq`). */
  snapshotSeq: number | null;
  /** Applied frontier `F` as of before this page is applied. */
  appliedSeq: number | null;
  isProcessing: boolean;
}

export function reconcileLatestHistorySnapshot(
  current: DisplayMessage[],
  latestHistory: DisplayMessage[],
  options: ReconcileLatestHistoryOptions,
): DisplayMessage[] {
  if (isSeqGapDetectionEnabled()) {
    return reconcileMessagesWithSeq(current, latestHistory, {
      snapshotSeq: options.snapshotSeq,
      appliedSeq: options.appliedSeq,
    });
  }

  return reconcileDisplayMessagesWithLatestHistory(
    current,
    latestHistory,
    options.isProcessing,
  );
}

