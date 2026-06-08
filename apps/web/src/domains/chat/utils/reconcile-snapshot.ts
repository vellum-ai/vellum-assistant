import { reconcileMessagesWithSeq } from "@/domains/chat/utils/reconcile-with-seq";
import { mapRuntimeToDisplayMessage } from "@/domains/chat/utils/map-runtime-message";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { ConversationMessage } from "@vellumai/assistant-api";

/**
 * Single entry point for merging a `/messages` snapshot into the local
 * transcript via the seq-aware monotonic merge.
 *
 * Fully pure (reads no module state): the caller passes the local seq
 * `L` — captured before advancing it — so the seq-aware merge can tell whether
 * this snapshot advanced the frontier. Advancing the frontier
 * (`recordLocalSeq`) is the caller's responsibility and must run outside the
 * updater.
 */
export interface ReconcileSnapshotOptions {
  /** Watermark `seq` the snapshot was persisted at (top-level `/messages` seq). */
  serverSeq: number | null;
  /** Local seq `L` as of before this snapshot is applied. */
  localSeq: number | null;
  oldestPageTimestamp?: number | null;
}

export function reconcileSnapshot(
  local: DisplayMessage[],
  server: ConversationMessage[],
  options: ReconcileSnapshotOptions,
): DisplayMessage[] {
  return reconcileMessagesWithSeq(local, server.map(mapRuntimeToDisplayMessage), {
    serverSeq: options.serverSeq,
    localSeq: options.localSeq,
    oldestPageTimestamp: options.oldestPageTimestamp,
  });
}

/**
 * Apply a freshly fetched latest page over a transcript restored from the
 * in-memory cache (the initial-load path).
 *
 * Routes through the single authoritative `reconcileMessagesWithSeq`, so
 * initial load uses the same monotonic merge as every other snapshot-apply
 * site: a stale page (`L > S`) keeps the live local rows, a fresh page
 * (`S >= L`) is authoritative. The latest page is already a projected
 * `DisplayMessage[]`, so it feeds the merge directly.
 */
export interface ReconcileLatestHistoryOptions {
  /** Watermark `seq` of the latest history page (`latestPage.seq`). */
  serverSeq: number | null;
  /** Local seq `L` as of before this page is applied. */
  localSeq: number | null;
}

export function reconcileLatestHistorySnapshot(
  current: DisplayMessage[],
  latestHistory: DisplayMessage[],
  options: ReconcileLatestHistoryOptions,
): DisplayMessage[] {
  return reconcileMessagesWithSeq(current, latestHistory, {
    serverSeq: options.serverSeq,
    localSeq: options.localSeq,
  });
}

