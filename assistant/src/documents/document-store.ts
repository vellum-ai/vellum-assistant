/**
 * Shared document persistence service.
 *
 * Extracted from documents-routes.ts so that both HTTP route handlers and
 * background jobs (e.g. proactive artifact generation) can persist documents
 * without going through the HTTP layer.
 */
import { rawAll, rawGet, rawRun } from "../persistence/raw-query.js";
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
      "documents:getDocumentById",
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
): DocumentSummary[] {
  try {
    const pattern = `%${escapeSqlLikePattern(query)}%`;
    const rows = options.conversationId
      ? rawAll<DocumentListRow>(
          "documents:searchByTitle:scoped",
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
          "documents:searchByTitle:all",
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
      "documents:saveDocument",
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

// ---------------------------------------------------------------------------
// Find-and-replace
// ---------------------------------------------------------------------------

export interface ReplaceInDocumentOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  maxReplacements?: number;
}

export type ReplaceInDocumentResult =
  | { success: true; replacements_made: number; content_changed: boolean }
  | { success: false; error: string };

function escapeRegExpChars(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find and replace text within a document — like sed.
 * Supports literal text and regex patterns with optional backreferences.
 */
export function replaceInDocument(
  surfaceId: string,
  find: string,
  replace: string,
  options: ReplaceInDocumentOptions = {},
): ReplaceInDocumentResult {
  try {
    const row = rawGet<{ content: string }>(
      "documents:replaceInDocument:getContent",
      /*sql*/ `SELECT content FROM documents WHERE surface_id = ?`,
      surfaceId,
    );
    if (!row) {
      return { success: false, error: "Document not found" };
    }

    const flags = "g" + (options.caseSensitive === true ? "" : "i");
    const pattern = options.regex
      ? new RegExp(find, flags)
      : new RegExp(escapeRegExpChars(find), flags);

    const totalMatches = [...row.content.matchAll(pattern)].length;
    if (
      totalMatches === 0 ||
      (options.maxReplacements != null && options.maxReplacements <= 0)
    ) {
      return { success: true, replacements_made: 0, content_changed: false };
    }

    let newContent: string;
    let replacementsMade: number;

    if (
      options.maxReplacements != null &&
      options.maxReplacements < totalMatches
    ) {
      // Iterative replacement up to maxReplacements using manual exec loop
      // so backreferences in the replacement string work correctly.
      const limit = options.maxReplacements;
      let count = 0;
      let result = "";
      let lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(row.content)) !== null) {
        if (count >= limit) {
          break;
        }
        result += row.content.slice(lastIndex, m.index);
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
      result += row.content.slice(lastIndex);
      newContent = result;
      replacementsMade = count;
    } else {
      newContent = row.content.replace(pattern, replace);
      replacementsMade = totalMatches;
    }

    const wordCount = countWords(newContent);
    rawRun(
      "documents:replaceInDocument:update",
      /*sql*/ `UPDATE documents SET content = ?, word_count = ?, updated_at = ? WHERE surface_id = ?`,
      newContent,
      wordCount,
      Date.now(),
      surfaceId,
    );
    log.info({ surfaceId, replacementsMade }, "Replaced text in document");
    return {
      success: true,
      replacements_made: replacementsMade,
      content_changed: true,
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
}

/** Update persisted document content (append or replace). */
export function updateDocumentContent(
  surfaceId: string,
  markdown: string,
  mode: string,
): DocumentContentUpdated | { success: false; error: string } {
  try {
    const existing = rawGet<{ content: string }>(
      "documents:updateDocumentContent:get",
      /*sql*/ `SELECT content FROM documents WHERE surface_id = ?`,
      surfaceId,
    );
    if (!existing) {
      log.info({ surfaceId }, "No persisted document to update");
      return { success: false, error: "Document not found" };
    }
    const appending = mode === "append";
    const appliedMarkdown = appending
      ? stripDuplicateLeadingBlocks(existing.content, markdown)
      : markdown;
    const duplicateLeadingContentSkipped =
      appending && appliedMarkdown !== markdown;
    const sep =
      appending && existing.content.length > 0 && appliedMarkdown.length > 0
        ? "\n\n"
        : "";
    const newContent = appending
      ? existing.content + sep + appliedMarkdown
      : appliedMarkdown;
    const wordCount = countWords(newContent);
    rawRun(
      "documents:updateDocumentContent:update",
      /*sql*/ `UPDATE documents SET content = ?, word_count = ?, updated_at = ? WHERE surface_id = ?`,
      newContent,
      wordCount,
      Date.now(),
      surfaceId,
    );
    if (duplicateLeadingContentSkipped) {
      log.info(
        { surfaceId, skippedChars: markdown.length - appliedMarkdown.length },
        "Skipped append content duplicating the document tail",
      );
    }
    log.info({ surfaceId, mode }, "Updated document content");
    return {
      success: true,
      appliedMarkdown,
      duplicateLeadingContentSkipped,
    };
  } catch (error) {
    log.error({ err: error, surfaceId }, "Document content update error");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
