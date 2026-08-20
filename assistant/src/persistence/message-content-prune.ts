/**
 * Administrative recovery for a conversation holding a message the providers
 * refuse to accept.
 *
 * A single stored message over the provider per-string limit is not a failure
 * of one turn: the whole history is resent every turn, so the conversation
 * answers every later message with the same rejection and cannot be used
 * again. {@link capPersistedMessageContent} keeps new writes under the cap,
 * and this module recovers rows written before that guard existed, or written
 * around it by a direct SQL edit.
 *
 * Pruning keeps the row and the conversation: it trims the oversized content
 * in place, which preserves the `tool_use` / `tool_result` pairing and the
 * turn structure that deleting a row would break.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { and, count, eq, gt, sql } from "drizzle-orm";

import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { updateMessageContent } from "./conversation-crud.js";
import { rebuildConversationDiskViewFromDbState } from "./conversation-disk-view.js";
import { getDb } from "./db-connection.js";
import { enqueueLexicalIndexForMessage } from "./job-handlers/message-lexical.js";
import {
  capPersistedMessageContent,
  MAX_PERSISTED_MESSAGE_BYTES,
  messageContentBytes,
} from "./message-content-cap.js";
import { messages } from "./schema/index.js";

const log = getLogger("message-content-prune");

/** Workspace-relative directory holding exported pre-prune content. */
export const PRUNED_MESSAGE_EXPORT_DIR = "pruned-messages";

export interface PrunedMessage {
  messageId: string;
  originalBytes: number;
  prunedBytes: number;
  /** Workspace-relative path of the exported original, when exported. */
  exportPath?: string;
}

export interface PruneOversizedResult {
  conversationId: string;
  /** Messages inspected: rows the conversation owns. */
  scanned: number;
  pruned: PrunedMessage[];
}

export interface PruneOversizedOptions {
  /**
   * Write each oversized body to a workspace file before trimming it. The
   * destination is always workspace-relative, so an administrative prune
   * cannot be pointed at an arbitrary path on the host.
   */
  export?: boolean;
}

/**
 * Trim every message in `conversationId` whose stored content exceeds
 * {@link MAX_PERSISTED_MESSAGE_BYTES}, optionally exporting each original
 * first.
 *
 * Sizing reads the stored bytes, so a streaming row still holding a `{ ref }`
 * pointer counts as the pointer it is: an in-flight message has no oversized
 * body on the row to trim, and it passes through the cap when its content
 * folds inline at finalize.
 */
export function pruneOversizedMessages(
  conversationId: string,
  options: PruneOversizedOptions = {},
): PruneOversizedResult {
  const db = getDb();
  // `length()` counts characters on TEXT, so the cast measures the UTF-8
  // bytes the cap is expressed in.
  const rows = db
    .select({ id: messages.id, content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        gt(
          sql<number>`length(CAST(${messages.content} AS BLOB))`,
          MAX_PERSISTED_MESSAGE_BYTES,
        ),
      ),
    )
    .all();
  const scanned =
    db
      .select({ c: count() })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .get()?.c ?? 0;

  const pruned: PrunedMessage[] = [];
  for (const row of rows) {
    const originalBytes = messageContentBytes(row.content);
    const exportPath =
      options.export === false
        ? undefined
        : exportOriginal(conversationId, row.id, row.content);
    const capped = capPersistedMessageContent(row.content, {
      source: "prune",
      conversationId,
      messageId: row.id,
    });
    updateMessageContent(row.id, capped);
    // `updateMessageContent` is a CRUD primitive that leaves search state
    // alone, so the trimmed row's lexical point would keep serving the body
    // this command reports as gone.
    enqueueLexicalIndexForMessage(row.id);
    pruned.push({
      messageId: row.id,
      originalBytes,
      prunedBytes: messageContentBytes(capped),
      ...(exportPath ? { exportPath } : {}),
    });
  }
  if (pruned.length > 0) {
    // The append-only disk view still holds the untrimmed body, and workspace
    // recovery reads that view back into the database, so replay it from the
    // pruned state.
    rebuildConversationDiskViewFromDbState(conversationId);
  }
  log.info(
    { conversationId, scanned, prunedCount: pruned.length },
    "Pruned oversized messages",
  );
  return { conversationId, scanned, pruned };
}

/**
 * Write `content` under the workspace export directory, returning the
 * workspace-relative path. Export is best effort: losing the copy is not a
 * reason to leave the conversation unusable, so a filesystem failure is
 * logged and the prune continues.
 */
function exportOriginal(
  conversationId: string,
  messageId: string,
  content: string,
): string | undefined {
  const relative = join(
    PRUNED_MESSAGE_EXPORT_DIR,
    conversationId,
    `${messageId}.txt`,
  );
  const absolute = join(getWorkspaceDir(), relative);
  try {
    mkdirSync(
      join(getWorkspaceDir(), PRUNED_MESSAGE_EXPORT_DIR, conversationId),
      { recursive: true },
    );
    writeFileSync(absolute, content);
    return relative;
  } catch (err) {
    log.warn(
      { err, conversationId, messageId },
      "Could not export oversized message content before pruning",
    );
    return undefined;
  }
}
