/**
 * In-flight message content: the agent loop's write path for streaming
 * content, kept off the SQLite writer lock.
 *
 * Rows are BORN streaming: the reserve seam creates the row with `content`
 * already holding the `{ ref }` pointer at an in-flight JSONL delta file
 * under the conversation directory (`conversations/<dir>/inflight/…`) and
 * `finalized = 0`. Each partial flush appends only the blocks that changed
 * since the last flush — a pure file append, no SQLite write at all. At the
 * message seam, {@link finalizeInflightContent} writes the folded content
 * inline, sets `finalized = 1`, and deletes the file.
 *
 * A message that never partial-flushes (fast replies inside the debounce
 * window) never creates the file — its single finalize write is the only
 * content persistence, exactly as before.
 *
 * Reads of an in-flight row work transparently — the message row mapper
 * resolves `{ ref }` by folding the delta file — so content stays readable
 * mid-stream and after a crash. Batch readers (search, memory indexing)
 * filter `finalized = 1` and never consume in-flight content.
 */

import { rmSync } from "node:fs";

import type pino from "pino";
import { v4 as uuid } from "uuid";

import {
  finalizeMessageContent,
  getConversation,
  getMessageById,
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
  /** Row id — assigned by the reserve seam once the reservation resolves. */
  messageId: string;
  conversationId: string;
  /** Workspace-relative delta-file path persisted in the row's `{ ref }`. */
  ref: string;
  /** Absolute delta-file path. */
  absPath: string;
  /**
   * Highest stream-event `seq` stamped on an appended delta line. Flushes
   * stamp the triggering event's seq so file lines correlate 1:1 with the
   * event stream; this tracks the high-water mark for monotonicity.
   */
  lastSeq: number;
  /** Per-index serialized form of the last flushed snapshot (diff base). */
  lastSerialized: string[];
}

/**
 * Create a writer for one message's in-flight content, ahead of the row's
 * reservation — the returned `ref` is what the reserve seam persists into
 * the newborn row's `{ ref }` content. The delta file is named by a fresh
 * uuid (the row id does not exist yet); callers stamp `messageId` once the
 * reservation resolves. Returns null when the conversation row can't be
 * resolved — callers then reserve a plain inline row and fall back to
 * direct row writes, which is always correct, just not contention-free.
 */
export function createInflightContentWriter(
  conversationId: string,
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
    `${uuid()}.jsonl`,
  ].join("/");
  const absPath = resolveContentRefPath(ref);
  if (!absPath) {
    return null;
  }
  return {
    messageId: "",
    conversationId,
    ref,
    absPath,
    lastSeq: 0,
    lastSerialized: [],
  };
}

/**
 * Persist a full content snapshot by appending only the blocks that changed
 * since the last flush — a pure file append, no SQLite write.
 *
 * `eventSeq` is the stream-event seq that triggered this flush; every delta
 * line of the flush is stamped with it so file lines correlate 1:1 with the
 * event stream. Flushes without a stream seq (e.g. content synthesized
 * outside the delta stream) advance the writer's high-water mark by one.
 * The stamp is clamped monotonic so the fold's highest-seq-wins rule holds
 * even across mixed sources.
 *
 * Returns whether the snapshot is durably persisted, mirroring the old
 * row-write contract so callers can gate seq bookkeeping on it.
 */
export function appendInflightSnapshot(
  writer: InflightContentWriter,
  blocks: ContentBlock[],
  eventSeq: number | undefined,
  rlog: pino.Logger,
): boolean {
  try {
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
    const stamp = Math.max(eventSeq ?? writer.lastSeq + 1, writer.lastSeq + 1);
    const deltas: ContentDeltaLine[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const serialized = JSON.stringify(blocks[i]);
      if (writer.lastSerialized[i] === serialized) {
        continue;
      }
      deltas.push({ i, seq: stamp, block: blocks[i] });
      writer.lastSerialized[i] = serialized;
    }
    if (deltas.length > 0) {
      writer.lastSeq = stamp;
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
  if (writer) {
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
    try {
      const row = getMessageById(writer.messageId, writer.conversationId);
      if (row && row.finalized === 0) {
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
