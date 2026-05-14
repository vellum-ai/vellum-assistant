/**
 * Shared document persistence service.
 *
 * Extracted from documents-routes.ts so that both HTTP route handlers and
 * background jobs (e.g. proactive artifact generation) can persist documents
 * without going through the HTTP layer.
 */
import { rawAll, rawGet, rawRun } from "../memory/raw-query.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("document-store");

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** A document record with camelCase field names, mapped from the SQLite row. */
export interface DocumentRecord {
  surfaceId: string;
  conversationId: string;
  title: string;
  content: string;
  wordCount: number;
  createdAt: number;
  updatedAt: number;
}

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
// Shared query helpers
// ---------------------------------------------------------------------------

interface DocumentRow {
  surface_id: string;
  conversation_id: string;
  title: string;
  content: string;
  word_count: number;
  created_at: number;
  updated_at: number;
}

type DocumentListRow = Omit<DocumentRow, "content">;

function escapeSqlLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function mapRowToRecord(row: DocumentRow): DocumentRecord {
  return {
    surfaceId: row.surface_id,
    conversationId: row.conversation_id,
    title: row.title,
    content: row.content,
    wordCount: row.word_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Look up a single document by surface ID. Returns `null` when not found. */
export function getDocumentById(surfaceId: string): DocumentRecord | null {
  try {
    const row = rawGet<DocumentRow>(
      /*sql*/ `SELECT surface_id, conversation_id, title, content, word_count, created_at, updated_at
       FROM documents
       WHERE surface_id = ?`,
      surfaceId,
    );

    if (!row) {
      log.info({ surfaceId }, "Document not found");
      return null;
    }

    log.info({ surfaceId }, "Loaded document");
    return mapRowToRecord(row);
  } catch (error) {
    log.error({ err: error, surfaceId }, "Load error");
    return null;
  }
}

/** Return true when a document is associated with a conversation. */
export function isDocumentAssociatedWithConversation(
  surfaceId: string,
  conversationId: string,
): boolean {
  try {
    const row = rawGet<{ found: number }>(
      /*sql*/ `
      SELECT 1 AS found
      FROM document_conversations
      WHERE surface_id = ? AND conversation_id = ?
      LIMIT 1
      `,
      surfaceId,
      conversationId,
    );
    return row != null;
  } catch (error) {
    log.error(
      { err: error, surfaceId, conversationId },
      "Document association check error",
    );
    return false;
  }
}

/**
 * List documents for a given conversation (via the junction table).
 * Returns an empty array when the conversation has no documents or on error.
 */
export function getDocumentsForConversation(
  conversationId: string,
): Omit<DocumentRecord, "content">[] {
  try {
    const rows = rawAll<DocumentListRow>(
      /*sql*/ `
      SELECT d.surface_id, dc.conversation_id AS conversation_id,
             d.title, d.word_count, d.created_at, d.updated_at
      FROM documents d
      INNER JOIN document_conversations dc ON d.surface_id = dc.surface_id
      WHERE dc.conversation_id = ?
      ORDER BY d.updated_at DESC
      `,
      conversationId,
    );

    log.info(
      { conversationId, count: rows.length },
      "Listed documents for conversation",
    );
    return rows.map((row) => ({
      surfaceId: row.surface_id,
      conversationId: row.conversation_id,
      title: row.title,
      wordCount: row.word_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  } catch (error) {
    log.error({ err: error, conversationId }, "List error");
    return [];
  }
}

/**
 * Search documents by title substring (case-insensitive).
 * When `conversationId` is supplied, only documents associated with that
 * conversation are returned.
 * Returns documents ordered by most recently updated.
 */
export function searchDocumentsByTitle(
  query: string,
  options: { conversationId?: string } = {},
): Omit<DocumentRecord, "content">[] {
  try {
    const pattern = `%${escapeSqlLikePattern(query)}%`;
    const rows = options.conversationId
      ? rawAll<DocumentListRow>(
          /*sql*/ `
          SELECT d.surface_id, dc.conversation_id AS conversation_id,
                 d.title, d.word_count, d.created_at, d.updated_at
          FROM documents d
          INNER JOIN document_conversations dc ON d.surface_id = dc.surface_id
          WHERE dc.conversation_id = ?
            AND d.title COLLATE NOCASE LIKE ? ESCAPE '\\'
          ORDER BY d.updated_at DESC
          LIMIT 20
          `,
          options.conversationId,
          pattern,
        )
      : rawAll<DocumentListRow>(
          /*sql*/ `
          SELECT surface_id, conversation_id, title, word_count, created_at, updated_at
          FROM documents
          WHERE title COLLATE NOCASE LIKE ? ESCAPE '\\'
          ORDER BY updated_at DESC
          LIMIT 20
          `,
          pattern,
        );

    log.info(
      { query, conversationId: options.conversationId, count: rows.length },
      "Searched documents by title",
    );
    return rows.map((row) => ({
      surfaceId: row.surface_id,
      conversationId: row.conversation_id,
      title: row.title,
      wordCount: row.word_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  } catch (error) {
    log.error({ err: error, query }, "Search error");
    return [];
  }
}

/**
 * Delete a document and its conversation associations.
 * Returns `true` if the document existed and was deleted, `false` otherwise.
 */
export function deleteDocument(surfaceId: string): boolean {
  try {
    const changes = rawRun(
      /*sql*/ `DELETE FROM documents WHERE surface_id = ?`,
      surfaceId,
    );
    rawRun(
      /*sql*/ `DELETE FROM document_conversations WHERE surface_id = ?`,
      surfaceId,
    );
    const existed = changes > 0;
    log.info({ surfaceId, existed }, "Deleted document");
    return existed;
  } catch (error) {
    log.error({ err: error, surfaceId }, "Delete error");
    return false;
  }
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
): { success: true } | { success: false; error: string } {
  try {
    const existing = rawGet<{ content: string }>(
      /*sql*/ `SELECT content FROM documents WHERE surface_id = ?`,
      surfaceId,
    );
    if (!existing) {
      log.info({ surfaceId }, "No persisted document to update");
      return { success: false, error: "Document not found" };
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
    return { success: true };
  } catch (error) {
    log.error({ err: error, surfaceId }, "Document content update error");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
