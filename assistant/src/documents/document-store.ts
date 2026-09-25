/**
 * Shared document persistence service.
 *
 * Extracted from documents-routes.ts so that both HTTP route handlers and
 * background jobs (e.g. proactive artifact generation) can persist documents
 * without going through the HTTP layer.
 */
import { randomUUID } from "node:crypto";

import { getSqlite } from "../persistence/db-connection.js";
import { rawAll, rawGet, rawRun } from "../persistence/raw-query.js";
import { getLogger } from "../util/logger.js";
import {
  type DocumentRevisionAuthor,
  type DocumentSnapshotSource,
  getDocumentRevision,
  recordDocumentSnapshot,
  shouldSnapshotBeforeUserSave,
} from "./document-revisions-store.js";

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
  /** Bumped by one on every write. */
  revision: number;
}

/**
 * The listing projection: everything but the body, which the list and search
 * queries deliberately leave out of their SELECTs.
 */
export type DocumentSummary = Omit<DocumentRecord, "content">;

/** Words in a markdown body, the count the `word_count` column stores. */
function countWords(content: string): number {
  return content.split(/\s+/).filter((word) => word.length > 0).length;
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
    "documents:addDocumentConversation",
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
  revision: number;
}

type DocumentListRow = Omit<DocumentRow, "content">;

/** How many times a read-modify-write retries after losing a revision race. */
const MAX_WRITE_ATTEMPTS = 5;

function escapeSqlLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function mapRowToSummary(row: DocumentListRow): DocumentSummary {
  return {
    surfaceId: row.surface_id,
    conversationId: row.conversation_id,
    title: row.title,
    wordCount: row.word_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function mapRowToRecord(row: DocumentRow): DocumentRecord {
  return { ...mapRowToSummary(row), content: row.content };
}

/** Look up a single document by surface ID. Returns `null` when not found. */
export function getDocumentById(surfaceId: string): DocumentRecord | null {
  try {
    const row = rawGet<DocumentRow>(
      "documents:getDocumentById",
      /*sql*/ `SELECT surface_id, conversation_id, title, content, word_count, created_at, updated_at, revision
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
      "documents:isAssociatedWithConversation",
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
): DocumentSummary[] {
  try {
    const rows = rawAll<DocumentListRow>(
      "documents:getDocumentsForConversation",
      /*sql*/ `
      SELECT d.surface_id, dc.conversation_id AS conversation_id,
             d.title, d.word_count, d.created_at, d.updated_at, d.revision
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
    return rows.map(mapRowToSummary);
  } catch (error) {
    log.error({ err: error, conversationId }, "List error");
    return [];
  }
}

/**
 * List every document, most recently updated first.
 * Returns an empty array on error.
 */
export function listAllDocuments(): DocumentSummary[] {
  try {
    const rows = rawAll<DocumentListRow>(
      "documents:listAllDocuments",
      /*sql*/ `
      SELECT surface_id, conversation_id, title, word_count, created_at, updated_at, revision
      FROM documents
      ORDER BY updated_at DESC
      `,
    );

    log.info({ count: rows.length }, "Listed documents");
    return rows.map(mapRowToSummary);
  } catch (error) {
    log.error({ err: error }, "List error");
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
): DocumentSummary[] {
  try {
    const pattern = `%${escapeSqlLikePattern(query)}%`;
    const rows = options.conversationId
      ? rawAll<DocumentListRow>(
          "documents:searchByTitle:scoped",
          /*sql*/ `
          SELECT d.surface_id, dc.conversation_id AS conversation_id,
                 d.title, d.word_count, d.created_at, d.updated_at, d.revision
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
          "documents:searchByTitle:all",
          /*sql*/ `
          SELECT surface_id, conversation_id, title, word_count, created_at, updated_at, revision
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
    return rows.map(mapRowToSummary);
  } catch (error) {
    log.error({ err: error, query }, "Search error");
    return [];
  }
}

/**
 * Return the most recent empty document in the given conversation with the
 * supplied title, created within the last `withinMs` milliseconds.
 *
 * Used to dedupe a duplicate create-then-create flow after a failed update —
 * when the model can't recover a malformed update and retries by creating a
 * second same-title document, we reuse the first (still-empty) draft instead
 * of producing a duplicate row. Returns `null` when no candidate exists.
 */
export function findRecentEmptyDocumentByTitle(
  conversationId: string,
  title: string,
  withinMs: number,
): { surfaceId: string } | null {
  try {
    const threshold = Date.now() - withinMs;
    const row = rawGet<{ surface_id: string }>(
      "documents:findRecentEmptyByTitle",
      /*sql*/ `SELECT surface_id FROM documents
       WHERE conversation_id = ?
         AND title = ?
         AND content = ''
         AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT 1`,
      conversationId,
      title,
      threshold,
    );
    return row ? { surfaceId: row.surface_id } : null;
  } catch (error) {
    log.error(
      { err: error, conversationId, title },
      "Find-recent-empty-document error",
    );
    return null;
  }
}

/**
 * Delete a document and its conversation associations.
 * Returns `true` if the document existed and was deleted, `false` otherwise.
 */
export function deleteDocument(surfaceId: string): boolean {
  try {
    const changes = rawRun(
      "documents:deleteDocument:doc",
      /*sql*/ `DELETE FROM documents WHERE surface_id = ?`,
      surfaceId,
    );
    rawRun(
      "documents:deleteDocument:associations",
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
// In-document search (grep)
// ---------------------------------------------------------------------------

export interface FindMatch {
  lineNumber: number;
  lineContent: string;
  matchStart: number;
  matchEnd: number;
  matchText: string;
}

export interface FindResult {
  surfaceId: string;
  totalMatches: number;
  matches: FindMatch[];
}

const MAX_FIND_MATCHES = 50;

/**
 * Search for text or a regex pattern within a document's content.
 * Returns matching lines with line numbers and match positions.
 * Results are capped at {@link MAX_FIND_MATCHES} to avoid oversized responses.
 */
export function findInDocument(
  surfaceId: string,
  query: string,
  options: { regex?: boolean; caseSensitive?: boolean } = {},
): FindResult | null {
  try {
    const row = rawGet<{ content: string }>(
      "documents:findInDocument:getContent",
      /*sql*/ `SELECT content FROM documents WHERE surface_id = ?`,
      surfaceId,
    );
    if (!row) {
      return null;
    }

    const lines = row.content.split("\n");
    const matches: FindMatch[] = [];
    let uncappedTotal = 0;

    if (options.regex) {
      const flags = options.caseSensitive ? "g" : "gi";
      const re = new RegExp(query, flags);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          uncappedTotal++;
          if (matches.length < MAX_FIND_MATCHES) {
            matches.push({
              lineNumber: i + 1,
              lineContent: line,
              matchStart: m.index,
              matchEnd: m.index + m[0].length,
              matchText: m[0],
            });
          }
          if (m[0].length === 0) {
            re.lastIndex++;
          }
        }
      }
    } else {
      const needle = options.caseSensitive ? query : query.toLowerCase();
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const haystack = options.caseSensitive ? line : line.toLowerCase();
        let startPos = 0;
        while (startPos <= haystack.length) {
          const idx = haystack.indexOf(needle, startPos);
          if (idx === -1) {
            break;
          }
          uncappedTotal++;
          if (matches.length < MAX_FIND_MATCHES) {
            matches.push({
              lineNumber: i + 1,
              lineContent: line,
              matchStart: idx,
              matchEnd: idx + needle.length,
              matchText: line.slice(idx, idx + needle.length),
            });
          }
          startPos = idx + Math.max(needle.length, 1);
        }
      }
    }

    return { surfaceId, totalMatches: uncappedTotal, matches };
  } catch (error) {
    log.error({ err: error, surfaceId }, "Find-in-document error");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Document persistence
// ---------------------------------------------------------------------------

/** The document state a conditional save lost to. */
export interface DocumentRevisionConflict {
  revision: number;
  title: string;
  content: string;
}

export type SaveDocumentResult =
  | { success: true; surfaceId: string; revision: number }
  | { success: false; error: string; conflict?: DocumentRevisionConflict };

function readDocumentState(surfaceId: string): DocumentSnapshotSource | null {
  const row = rawGet<{
    revision: number;
    title: string;
    content: string;
    word_count: number;
  }>(
    "documents:readDocumentState",
    /*sql*/ `SELECT revision, title, content, word_count FROM documents WHERE surface_id = ?`,
    surfaceId,
  );
  return row
    ? {
        surfaceId,
        revision: row.revision,
        title: row.title,
        content: row.content,
        wordCount: row.word_count,
      }
    : null;
}

/**
 * Snapshot the state a user save is about to replace, when the save will land
 * and changes something and {@link shouldSnapshotBeforeUserSave} allows it.
 * Runs inside the save's transaction.
 */
function snapshotBeforeUserSave(params: {
  surfaceId: string;
  title: string;
  content: string;
  baseRevision?: number;
}): void {
  const current = readDocumentState(params.surfaceId);
  if (
    !current ||
    (params.baseRevision !== undefined &&
      current.revision !== params.baseRevision) ||
    (current.title === params.title && current.content === params.content)
  ) {
    return;
  }
  if (shouldSnapshotBeforeUserSave(params.surfaceId)) {
    recordDocumentSnapshot(current, "user");
  }
}

/**
 * Write a document's title and body, creating the row when it does not exist.
 *
 * Without `baseRevision` the write is unconditional. With it, an existing row
 * is only overwritten when its revision still equals `baseRevision`; otherwise
 * nothing is written and the result carries the row's current state. A row
 * that does not exist yet is created either way.
 */
function writeDocument(params: {
  surfaceId: string;
  conversationId: string;
  title: string;
  content: string;
  wordCount: number;
  baseRevision?: number;
}): { revision: number } | { conflict: DocumentRevisionConflict } {
  const now = Date.now();
  if (params.baseRevision === undefined) {
    const row = rawGet<{ revision: number }>(
      "documents:saveDocument",
      /*sql*/ `INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(surface_id) DO UPDATE SET
         title = excluded.title,
         content = excluded.content,
         word_count = excluded.word_count,
         updated_at = excluded.updated_at,
         revision = documents.revision + 1
       RETURNING revision`,
      params.surfaceId,
      params.conversationId,
      params.title,
      params.content,
      params.wordCount,
      now,
      now,
    );
    return { revision: row!.revision };
  }

  const updated = rawGet<{ revision: number }>(
    "documents:saveDocument:conditional",
    /*sql*/ `UPDATE documents
     SET title = ?, content = ?, word_count = ?, updated_at = ?, revision = revision + 1
     WHERE surface_id = ? AND revision = ?
     RETURNING revision`,
    params.title,
    params.content,
    params.wordCount,
    now,
    params.surfaceId,
    params.baseRevision,
  );
  if (updated) {
    return updated;
  }
  const inserted = rawGet<{ revision: number }>(
    "documents:saveDocument:insertIfMissing",
    /*sql*/ `INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(surface_id) DO NOTHING
     RETURNING revision`,
    params.surfaceId,
    params.conversationId,
    params.title,
    params.content,
    params.wordCount,
    now,
    now,
  );
  if (inserted) {
    return inserted;
  }
  const current = readDocumentState(params.surfaceId);
  if (!current) {
    throw new Error("Document disappeared during a conditional save");
  }
  return {
    conflict: {
      revision: current.revision,
      title: current.title,
      content: current.content,
    },
  };
}

/**
 * Create a document, or overwrite one as a user save from the editor. An
 * overwrite may first snapshot the replaced state into the document's history
 * (see {@link snapshotBeforeUserSave}).
 */
export function saveDocument(params: {
  surfaceId: string;
  conversationId: string;
  title: string;
  content: string;
  wordCount: number;
  baseRevision?: number;
}): SaveDocumentResult {
  try {
    const written = getSqlite()
      .transaction(() => {
        snapshotBeforeUserSave(params);
        return writeDocument(params);
      })
      .immediate();
    if ("conflict" in written) {
      log.info(
        {
          surfaceId: params.surfaceId,
          baseRevision: params.baseRevision,
          currentRevision: written.conflict.revision,
        },
        "Rejected document save against a stale revision",
      );
      return {
        success: false,
        error: "Document changed since the base revision",
        conflict: written.conflict,
      };
    }
    log.info(
      {
        surfaceId: params.surfaceId,
        title: params.title,
        revision: written.revision,
      },
      "Saved document",
    );

    // Best-effort: associate the document with the conversation.
    // Failures (e.g. migration not yet applied, table missing) must not
    // cause the save response to report failure: the document itself is
    // already persisted at this point.
    try {
      addDocumentConversation(params.surfaceId, params.conversationId);
    } catch (err) {
      log.warn(
        { err, surfaceId: params.surfaceId },
        "Failed to record document–conversation association",
      );
    }

    return {
      success: true,
      surfaceId: params.surfaceId,
      revision: written.revision,
    };
  } catch (error) {
    log.error({ err: error, surfaceId: params.surfaceId }, "Save error");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/** What a {@link mutateDocumentContent} callback decides for one attempt. */
export type ContentMutation<T> =
  | { content: string; value: T }
  | { value: T; content?: undefined };

/** Thrown inside a write transaction to roll it back after losing a race. */
class LostRevisionRace extends Error {}

/**
 * Read-modify-write a document's body without losing a concurrent write.
 *
 * `mutate` receives the current body and returns the new one, or no `content`
 * to leave the row untouched; a body equal to the current one is not written
 * either. The state being replaced is snapshotted into the document's history
 * as `author`'s edit, in the same transaction as the write. The write is a
 * compare-and-swap on `revision`: when another write lands between the read
 * and the write, the transaction rolls back and `mutate` runs again against
 * the fresh body, up to {@link MAX_WRITE_ATTEMPTS} times.
 *
 * Returns `null` when the document does not exist, otherwise the callback's
 * value, the body now stored, and the revision after the call.
 */
export function mutateDocumentContent<T>(
  surfaceId: string,
  author: DocumentRevisionAuthor,
  mutate: (current: {
    content: string;
    revision: number;
  }) => ContentMutation<T>,
): { value: T; content: string; revision: number } | null {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const current = readDocumentState(surfaceId);
    if (!current) {
      return null;
    }
    const mutation = mutate(current);
    if (
      mutation.content === undefined ||
      mutation.content === current.content
    ) {
      return {
        value: mutation.value,
        content: current.content,
        revision: current.revision,
      };
    }
    const newContent = mutation.content;
    try {
      const written = getSqlite()
        .transaction(() => {
          recordDocumentSnapshot(current, author);
          const row = rawGet<{ revision: number }>(
            "documents:mutateDocumentContent:update",
            /*sql*/ `UPDATE documents
             SET content = ?, word_count = ?, updated_at = ?, revision = revision + 1
             WHERE surface_id = ? AND revision = ?
             RETURNING revision`,
            newContent,
            countWords(newContent),
            Date.now(),
            surfaceId,
            current.revision,
          );
          if (!row) {
            throw new LostRevisionRace();
          }
          return row;
        })
        .immediate();
      return {
        value: mutation.value,
        content: newContent,
        revision: written.revision,
      };
    } catch (error) {
      if (!(error instanceof LostRevisionRace)) {
        throw error;
      }
    }
    log.info(
      { surfaceId, attempt, baseRevision: current.revision },
      "Document changed during a read-modify-write; retrying",
    );
  }
  throw new Error("Document kept changing during the write; try again");
}

/** Outcome of {@link restoreDocumentRevision}. */
export type RestoreDocumentRevisionResult =
  | { success: true; revision: number; title: string; content: string }
  | { success: false; notFound: "document" | "revision" };

/**
 * Put a snapshot's title and body back as a new revision of the document.
 * The current state is snapshotted first, so the restore is itself undoable.
 */
export function restoreDocumentRevision(
  surfaceId: string,
  revision: number,
): RestoreDocumentRevisionResult {
  return getSqlite()
    .transaction((): RestoreDocumentRevisionResult => {
      const current = readDocumentState(surfaceId);
      if (!current) {
        return { success: false, notFound: "document" };
      }
      const target = getDocumentRevision(surfaceId, revision);
      if (!target) {
        return { success: false, notFound: "revision" };
      }
      recordDocumentSnapshot(current, "user");
      const row = rawGet<{ revision: number }>(
        "documents:restoreDocumentRevision",
        /*sql*/ `UPDATE documents
         SET title = ?, content = ?, word_count = ?, updated_at = ?, revision = revision + 1
         WHERE surface_id = ?
         RETURNING revision`,
        target.title,
        target.content,
        target.wordCount,
        Date.now(),
        surfaceId,
      );
      log.info(
        { surfaceId, restoredRevision: revision, revision: row!.revision },
        "Restored document revision",
      );
      return {
        success: true,
        revision: row!.revision,
        title: target.title,
        content: target.content,
      };
    })
    .immediate();
}

export const DEFAULT_DOCUMENT_TITLE = "Untitled Document";

/**
 * Create a new document owned by `conversationId` under a freshly minted
 * surface ID. A missing or empty title falls back to `DEFAULT_DOCUMENT_TITLE`.
 */
export function createDocument(params: {
  conversationId: string;
  title?: string;
  content?: string;
}): SaveDocumentResult {
  const content = params.content ?? "";
  return saveDocument({
    surfaceId: `doc-${randomUUID()}`,
    conversationId: params.conversationId,
    title: params.title || DEFAULT_DOCUMENT_TITLE,
    content,
    wordCount: countWords(content),
  });
}

// ---------------------------------------------------------------------------
// Find-and-replace
// ---------------------------------------------------------------------------

export interface ReplaceInDocumentOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  maxReplacements?: number;
}

export type ReplaceInDocumentResult =
  | {
      success: true;
      replacements_made: number;
      content_changed: boolean;
      /** The body now stored. */
      content: string;
      /** The revision after the call. */
      revision: number;
    }
  | { success: false; error: string };

/**
 * Apply a find-and-replace to `content`. Returns the unchanged input and a
 * zero count when nothing matches or `maxReplacements` is not positive.
 */
function replaceText(
  content: string,
  find: string,
  replace: string,
  options: ReplaceInDocumentOptions,
): { content: string; replacementsMade: number } {
  const flags = "g" + (options.caseSensitive === true ? "" : "i");
  const pattern = options.regex
    ? new RegExp(find, flags)
    : new RegExp(RegExp.escape(find), flags);

  const totalMatches = [...content.matchAll(pattern)].length;
  if (
    totalMatches === 0 ||
    (options.maxReplacements != null && options.maxReplacements <= 0)
  ) {
    return { content, replacementsMade: 0 };
  }

  if (
    options.maxReplacements == null ||
    options.maxReplacements >= totalMatches
  ) {
    return {
      content: content.replace(pattern, replace),
      replacementsMade: totalMatches,
    };
  }

  // Iterative replacement up to maxReplacements using manual exec loop
  // so backreferences in the replacement string work correctly.
  const limit = options.maxReplacements;
  let count = 0;
  let result = "";
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    if (count >= limit) {
      break;
    }
    result += content.slice(lastIndex, m.index);
    const singleMatchPattern = new RegExp(
      pattern.source,
      pattern.flags.replace("g", ""),
    );
    result += m[0].replace(singleMatchPattern, replace);
    lastIndex = m.index + m[0].length;
    count++;
    if (m[0].length === 0) {
      pattern.lastIndex++;
    }
  }
  result += content.slice(lastIndex);
  return { content: result, replacementsMade: count };
}

/**
 * Find and replace text within a document, like sed, as an assistant edit.
 * Supports literal text and regex patterns with optional backreferences.
 */
export function replaceInDocument(
  surfaceId: string,
  find: string,
  replace: string,
  options: ReplaceInDocumentOptions = {},
): ReplaceInDocumentResult {
  try {
    const outcome = mutateDocumentContent(surfaceId, "assistant", (current) => {
      const replaced = replaceText(current.content, find, replace, options);
      return replaced.replacementsMade === 0
        ? { value: 0 }
        : { content: replaced.content, value: replaced.replacementsMade };
    });
    if (!outcome) {
      return { success: false, error: "Document not found" };
    }
    if (outcome.value > 0) {
      log.info(
        { surfaceId, replacementsMade: outcome.value },
        "Replaced text in document",
      );
    }
    return {
      success: true,
      replacements_made: outcome.value,
      content_changed: outcome.value > 0,
      content: outcome.content,
      revision: outcome.revision,
    };
  } catch (error) {
    log.error({ err: error, surfaceId }, "Replace-in-document error");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// ---------------------------------------------------------------------------
// Append idempotency
// ---------------------------------------------------------------------------

/** A blank-line-delimited block of markdown, located in its source string. */
interface MarkdownBlock {
  /** Whitespace-trimmed block text, the unit duplicate detection compares. */
  text: string;
  /** Offset of the block's first character in the source string. */
  start: number;
}

/**
 * Split markdown into blank-line-delimited blocks, dropping empty ones but
 * keeping each surviving block's offset so a suffix of the source can be
 * recovered verbatim.
 */
function splitIntoBlocks(content: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const separator = /\n[^\S\n]*\n/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  const push = (start: number, end: number): void => {
    const text = content.slice(start, end).trim();
    if (text.length > 0) {
      blocks.push({ text, start });
    }
  };
  while ((match = separator.exec(content)) !== null) {
    push(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  push(cursor, content.length);
  return blocks;
}

/**
 * An append has to repeat at least this many characters of the document's tail
 * before the repetition is treated as an accident.
 *
 * The floor is what keeps legitimate repetition intact. A document can honestly
 * repeat a heading, a refrain, a table row, or a bare "TODO" back to back, and
 * those are all short. Only a substantial restatement (an opening paragraph
 * passed to both `document_create` and the first append) clears the bar.
 */
const MIN_DUPLICATE_APPEND_CHARS = 40;

/**
 * Drop a leading run of blocks from `markdown` that exactly repeats the tail of
 * `existing`, so an append that restates content already committed does not
 * write it a second time.
 *
 * The guard is deliberately narrow: the repeated run must be an exact,
 * block-aligned match, it must sit at the very start of the append and the very
 * end of the document, and it must be at least
 * {@link MIN_DUPLICATE_APPEND_CHARS} long. Anything else, including the same
 * text reappearing further down the append, is passed through untouched.
 */
function stripDuplicateLeadingBlocks(
  existing: string,
  markdown: string,
): string {
  const existingBlocks = splitIntoBlocks(existing);
  const incomingBlocks = splitIntoBlocks(markdown);
  const maxOverlap = Math.min(existingBlocks.length, incomingBlocks.length);

  let overlap = 0;
  for (let candidate = maxOverlap; candidate >= 1; candidate--) {
    const offset = existingBlocks.length - candidate;
    let matches = true;
    for (let i = 0; i < candidate; i++) {
      if (existingBlocks[offset + i].text !== incomingBlocks[i].text) {
        matches = false;
        break;
      }
    }
    if (matches) {
      overlap = candidate;
      break;
    }
  }
  if (overlap === 0) {
    return markdown;
  }

  const duplicatedChars = incomingBlocks
    .slice(0, overlap)
    .reduce((total, block) => total + block.text.length, 0);
  if (duplicatedChars < MIN_DUPLICATE_APPEND_CHARS) {
    return markdown;
  }

  if (overlap === incomingBlocks.length) {
    return "";
  }
  return markdown
    .slice(incomingBlocks[overlap].start)
    .replace(/^(?:[^\S\n]*\n)+/, "");
}

/** Outcome of a successful {@link updateDocumentContent} call. */
export interface DocumentContentUpdated {
  success: true;
  /**
   * The markdown that actually landed. Equals the submitted markdown except
   * when an append's leading blocks duplicated the document's tail, in which
   * case it is the remainder. Clients render this so their view matches the row.
   */
  appliedMarkdown: string;
  /** True when a duplicated leading run was dropped from an append. */
  duplicateLeadingContentSkipped: boolean;
  /** The revision after the write. */
  revision: number;
}

/** Update persisted document content (append or replace) as an assistant edit. */
export function updateDocumentContent(
  surfaceId: string,
  markdown: string,
  mode: string,
): DocumentContentUpdated | { success: false; error: string } {
  try {
    const appending = mode === "append";
    const outcome = mutateDocumentContent(surfaceId, "assistant", (current) => {
      const appliedMarkdown = appending
        ? stripDuplicateLeadingBlocks(current.content, markdown)
        : markdown;
      const sep =
        appending && current.content.length > 0 && appliedMarkdown.length > 0
          ? "\n\n"
          : "";
      return {
        content: appending
          ? current.content + sep + appliedMarkdown
          : appliedMarkdown,
        value: appliedMarkdown,
      };
    });
    if (!outcome) {
      log.info({ surfaceId }, "No persisted document to update");
      return { success: false, error: "Document not found" };
    }
    const appliedMarkdown = outcome.value;
    const duplicateLeadingContentSkipped =
      appending && appliedMarkdown !== markdown;
    if (duplicateLeadingContentSkipped) {
      log.info(
        { surfaceId, skippedChars: markdown.length - appliedMarkdown.length },
        "Skipped append content duplicating the document tail",
      );
    }
    log.info(
      { surfaceId, mode, revision: outcome.revision },
      "Updated document content",
    );
    return {
      success: true,
      appliedMarkdown,
      duplicateLeadingContentSkipped,
      revision: outcome.revision,
    };
  } catch (error) {
    log.error({ err: error, surfaceId }, "Document content update error");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
