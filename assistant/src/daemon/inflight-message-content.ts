/**
 * In-flight message content: the agent loop's write path for streaming
 * content, kept off the SQLite writer lock.
 *
 * While a message streams, its content lives in an append-only JSONL delta
 * file under the conversation directory
 * (`conversations/<dir>/inflight/<messageId>.jsonl`) and the row holds a
 * `{ ref }` pointer with `finalized = 0`. Each partial flush appends only
 * the blocks that changed since the last flush — no row rewrite, no WAL
 * churn. At the message seam, {@link finalizeInflightContent} writes the
 * folded content inline, sets `finalized = 1`, and deletes the file.
 *
 * Writers are created lazily: a message that never partial-flushes (fast
 * replies inside the debounce window) never touches the file — its single
 * finalize write is the only persistence, exactly as before.
 *
 * Reads of an in-flight row work transparently — the message row mapper
 * resolves `{ ref }` by folding the delta file — so content stays readable
 * mid-stream and after a crash. Batch readers (search, memory indexing)
 * filter `finalized = 1` and never consume in-flight content.
 */

import { rmSync } from "node:fs";

import type pino from "pino";

import {
  finalizeMessageContent,
  getConversation,
  getMessageById,
  markMessageContentInflight,
} from "../persistence/conversation-crud.js";
import { getConversationDirName } from "../persistence/conversation-directories.js";
import {
  appendContentDeltas,
  type ContentDeltaLine,
  resolveContentRefPath,
} from "../persistence/message-content-file.js";
import type { ContentBlock } from "../providers/types.js";
import { withSqliteRetry } from "../util/sqlite-retry.js";

export interface InflightContentWriter {
  messageId: string;
  conversationId: string;
  /** Workspace-relative delta-file path persisted in the row's `{ ref }`. */
  ref: string;
  /** Absolute delta-file path. */
  absPath: string;
  /** Monotonic per-writer sequence stamped on each appended delta line. */
  seq: number;
  /** Per-index serialized form of the last flushed snapshot (diff base). */
  lastSerialized: string[];
  /** Whether the row has been flipped to `{ ref }` / `finalized = 0`. */
  rowMarked: boolean;
}

/**
 * Create a writer for one message's in-flight content. Returns null when
 * the conversation row can't be resolved — callers fall back to direct
 * row writes, which is always correct, just not contention-free.
 */
export function createInflightContentWriter(
  conversationId: string,
  messageId: string,
): InflightContentWriter | null {
  const conv = getConversation(conversationId);
  if (!conv || !Number.isFinite(conv.createdAt)) {
    return null;
  }
  // POSIX join — the ref schema requires forward slashes.
  const ref = [
    "conversations",
    getConversationDirName(conversationId, conv.createdAt),
    "inflight",
    `${messageId}.jsonl`,
  ].join("/");
  const absPath = resolveContentRefPath(ref);
  if (!absPath) {
    return null;
  }
  return {
    messageId,
    conversationId,
    ref,
    absPath,
    seq: 0,
    lastSerialized: [],
    rowMarked: false,
  };
}

/**
 * Persist a full content snapshot by appending only the blocks that changed
 * since the last flush. The first append flips the row to `{ ref }` /
 * `finalized = 0` (one small fixed-size row write for the whole stream);
 * every subsequent flush touches only the delta file.
 *
 * Returns whether the snapshot is durably persisted, mirroring the old
 * row-write contract so callers can gate seq bookkeeping on it.
 */
export async function appendInflightSnapshot(
  writer: InflightContentWriter,
  blocks: ContentBlock[],
  rlog: pino.Logger,
): Promise<boolean> {
  try {
    if (!writer.rowMarked) {
      await withSqliteRetry(
        () => markMessageContentInflight(writer.messageId, writer.ref),
        {
          op: "mark_message_inflight",
          context: { messageId: writer.messageId },
        },
      );
      writer.rowMarked = true;
    }
    // The fold keeps the highest-seq line per index, so a shrinking snapshot
    // (fewer blocks than the diff base) cannot be expressed as an append.
    // Streaming content only grows within a row, so this is a never-path
    // guard: reset the diff base and re-append everything.
    if (blocks.length < writer.lastSerialized.length) {
      rlog.warn(
        {
          messageId: writer.messageId,
          from: writer.lastSerialized.length,
          to: blocks.length,
        },
        "In-flight snapshot shrank; rewriting delta base",
      );
      rmSync(writer.absPath, { force: true });
      writer.lastSerialized = [];
    }
    const deltas: ContentDeltaLine[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const serialized = JSON.stringify(blocks[i]);
      if (writer.lastSerialized[i] === serialized) {
        continue;
      }
      writer.seq += 1;
      deltas.push({ i, seq: writer.seq, block: blocks[i] });
      writer.lastSerialized[i] = serialized;
    }
    appendContentDeltas(writer.absPath, deltas);
    return true;
  } catch (err) {
    rlog.error(
      { err, messageId: writer.messageId },
      "in-flight content append failed; continuing without interrupting the turn",
    );
    return false;
  }
}

/**
 * Finalize a message's content at its terminal write seam: fold the
 * authoritative blocks inline into the row, set `finalized = 1`, and
 * delete the delta file. Safe for rows that never went in-flight (the
 * common fast-reply case) — it is then exactly the single content write
 * the seam always performed.
 */
export async function finalizeInflightContent(
  writer: InflightContentWriter | undefined,
  messageId: string,
  contentJson: string,
  rlog: pino.Logger,
  metadataUpdates?: Record<string, unknown>,
): Promise<boolean> {
  try {
    await withSqliteRetry(
      () => finalizeMessageContent(messageId, contentJson, metadataUpdates),
      { op: "finalize_message_content", context: { messageId } },
    );
  } catch (err) {
    rlog.error(
      { err, messageId },
      "message-content finalize failed after retries; continuing without interrupting the turn",
    );
    return false;
  }
  if (writer?.rowMarked) {
    try {
      rmSync(writer.absPath, { force: true });
    } catch (err) {
      rlog.warn(
        { err, messageId },
        "failed to remove in-flight delta file after finalize",
      );
    }
  }
  return true;
}

/**
 * Fold and finalize any writers a turn left behind — cancelled or aborted
 * turns exit without reaching a message's finalize seam. The row's current
 * resolved content (the folded delta file, or inline content if another
 * path already rewrote the row) becomes the finalized inline value. Runs
 * at the turn-finalize seam so `finalized = 0` rows cannot leak from a
 * live daemon; the startup recovery sweep covers crashes.
 */
export async function finalizeStrandedInflightContent(
  writers: Map<string, InflightContentWriter>,
  rlog: pino.Logger,
): Promise<void> {
  for (const writer of writers.values()) {
    if (!writer.rowMarked) {
      continue;
    }
    try {
      const row = getMessageById(writer.messageId, writer.conversationId);
      if (row) {
        await finalizeInflightContent(
          writer,
          writer.messageId,
          JSON.stringify(row.content),
          rlog,
        );
      }
    } catch (err) {
      rlog.warn(
        { err, messageId: writer.messageId },
        "failed to finalize stranded in-flight content",
      );
    }
  }
  writers.clear();
}
