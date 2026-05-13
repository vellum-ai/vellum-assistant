/**
 * Shared document persistence service.
 *
 * Extracted from documents-routes.ts so that both HTTP route handlers and
 * background jobs (e.g. proactive artifact generation) can persist documents
 * without going through the HTTP layer.
 */
import { rawGet, rawRun } from "../memory/raw-query.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("document-store");

// ---------------------------------------------------------------------------
// Junction table helper
// ---------------------------------------------------------------------------

/** Insert a document–conversation association (idempotent via INSERT OR IGNORE). */
export function addDocumentConversation(
  surfaceId: string,
  conversationId: string,
): void {
  rawRun(
    /*sql*/ `INSERT OR IGNORE INTO document_conversations (surface_id, conversation_id, created_at) VALUES (?, ?, ?)`,
    surfaceId,
    conversationId,
    Date.now(),
  );
}

// ---------------------------------------------------------------------------
// Document persistence
// ---------------------------------------------------------------------------

export function saveDocument(params: {
  surfaceId: string;
  conversationId: string;
  title: string;
  content: string;
  wordCount: number;
}): { success: true; surfaceId: string } | { success: false; error: string } {
  try {
    const now = Date.now();
    rawRun(
      `INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(surface_id) DO UPDATE SET
         title = excluded.title,
         content = excluded.content,
         word_count = excluded.word_count,
         updated_at = excluded.updated_at`,
      params.surfaceId,
      params.conversationId,
      params.title,
      params.content,
      params.wordCount,
      now,
      now,
    );
    log.info(
      { surfaceId: params.surfaceId, title: params.title },
      "Saved document",
    );

    // Best-effort: associate the document with the conversation.
    // Failures (e.g. migration not yet applied, table missing) must not
    // cause the save response to report failure — the document itself is
    // already persisted at this point.
    try {
      addDocumentConversation(params.surfaceId, params.conversationId);
    } catch (err) {
      log.warn(
        { err, surfaceId: params.surfaceId },
        "Failed to record document–conversation association",
      );
    }

    return { success: true, surfaceId: params.surfaceId };
  } catch (error) {
    log.error({ err: error, surfaceId: params.surfaceId }, "Save error");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/** Update persisted document content (append or replace). */
export function updateDocumentContent(
  surfaceId: string,
  markdown: string,
  mode: string,
): void {
  try {
    const existing = rawGet<{ content: string }>(
      /*sql*/ `SELECT content FROM documents WHERE surface_id = ?`,
      surfaceId,
    );
    if (!existing) {
      log.info({ surfaceId }, "No persisted document to update");
      return;
    }
    const sep = mode === "append" && existing.content.length > 0 ? "\n\n" : "";
    const newContent =
      mode === "append" ? existing.content + sep + markdown : markdown;
    const wordCount = newContent
      .split(/\s+/)
      .filter((w) => w.length > 0).length;
    rawRun(
      /*sql*/ `UPDATE documents SET content = ?, word_count = ?, updated_at = ? WHERE surface_id = ?`,
      newContent,
      wordCount,
      Date.now(),
      surfaceId,
    );
    log.info({ surfaceId, mode }, "Updated document content");
  } catch (error) {
    log.error({ err: error, surfaceId }, "Document content update error");
  }
}
