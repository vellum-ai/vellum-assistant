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


