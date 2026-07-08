/**
 * CRUD operations for document comments.
 *
 * Follows the same raw-query pattern as document-store.ts — all SQL uses
 * snake_case columns, mapped to camelCase TypeScript interfaces via
 * `mapRowToComment()`.
 */
import { randomUUID } from "node:crypto";

import { rawAll, rawGet, rawRun } from "../persistence/raw-query.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("document-comments-store");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A comment record with camelCase fields mapped from snake_case DB columns. */
export interface CommentRecord {
  id: string;
  surfaceId: string;
  conversationId: string;
  author: string;
  content: string;
  anchorStart: number | null;
  anchorEnd: number | null;
  anchorText: string | null;
  parentCommentId: string | null;
  status: "open" | "resolved";
  resolvedBy: string | null;
  resolvedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface CommentRow {
  id: string;
  surface_id: string;
  conversation_id: string;
  author: string;
  content: string;
  anchor_start: number | null;
  anchor_end: number | null;
  anchor_text: string | null;
  parent_comment_id: string | null;
  status: string;
  resolved_by: string | null;
  resolved_at: number | null;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapRowToComment(row: CommentRow): CommentRecord {
  return {
    id: row.id,
    surfaceId: row.surface_id,
    conversationId: row.conversation_id,
    author: row.author,
    content: row.content,
    anchorStart: row.anchor_start,
    anchorEnd: row.anchor_end,
    anchorText: row.anchor_text,
    parentCommentId: row.parent_comment_id,
    status: row.status as CommentRecord["status"],
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function createComment(params: {
  surfaceId: string;
  conversationId: string;
  author: string;
  content: string;
  anchorStart?: number | null;
  anchorEnd?: number | null;
  anchorText?: string | null;
  parentCommentId?: string | null;
}): CommentRecord {
  const id = `comment-${randomUUID()}`;
  const now = Date.now();

  rawRun(
    "docComments:createComment",
    /*sql*/ `INSERT INTO document_comments
      (id, surface_id, conversation_id, author, content,
       anchor_start, anchor_end, anchor_text, parent_comment_id,
       status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    id,
    params.surfaceId,
    params.conversationId,
    params.author,
    params.content,
    params.anchorStart ?? null,
    params.anchorEnd ?? null,
    params.anchorText ?? null,
    params.parentCommentId ?? null,
    now,
    now,
  );

  log.info({ id, surfaceId: params.surfaceId }, "Created comment");

  return {
    id,
    surfaceId: params.surfaceId,
    conversationId: params.conversationId,
    author: params.author,
    content: params.content,
    anchorStart: params.anchorStart ?? null,
    anchorEnd: params.anchorEnd ?? null,
    anchorText: params.anchorText ?? null,
    parentCommentId: params.parentCommentId ?? null,
    status: "open",
    resolvedBy: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function getComment(id: string): CommentRecord | null {
  const row = rawGet<CommentRow>(
    "docComments:getComment",
    /*sql*/ `SELECT * FROM document_comments WHERE id = ?`,
    id,
  );
  return row ? mapRowToComment(row) : null;
}

export function listComments(
  surfaceId: string,
  opts?: {
    status?: "open" | "resolved" | "all";
    topLevelOnly?: boolean;
  },
): CommentRecord[] {
  const status = opts?.status ?? "all";
  const topLevelOnly = opts?.topLevelOnly ?? false;

  const conditions: string[] = ["surface_id = ?"];
  const params: (string | number | null)[] = [surfaceId];

  if (status !== "all") {
    conditions.push("status = ?");
    params.push(status);
  }

  if (topLevelOnly) {
    conditions.push("parent_comment_id IS NULL");
  }

  const where = conditions.join(" AND ");
  const rows = rawAll<CommentRow>(
    "docComments:listComments",
    /*sql*/ `SELECT * FROM document_comments WHERE ${where} ORDER BY created_at ASC`,
    ...params,
  );

  return rows.map(mapRowToComment);
}

export function resolveComment(id: string, resolvedBy: string): boolean {
  const now = Date.now();
  const changes = rawRun(
    "docComments:resolveComment",
    /*sql*/ `UPDATE document_comments
      SET status = 'resolved', resolved_by = ?, resolved_at = ?, updated_at = ?
      WHERE id = ?`,
    resolvedBy,
    now,
    now,
    id,
  );
  if (changes > 0) {
    log.info({ id, resolvedBy }, "Resolved comment");
  }
  return changes > 0;
}

export function reopenComment(id: string): boolean {
  const now = Date.now();
  const changes = rawRun(
    "docComments:reopenComment",
    /*sql*/ `UPDATE document_comments
      SET status = 'open', resolved_by = NULL, resolved_at = NULL, updated_at = ?
      WHERE id = ?`,
    now,
    id,
  );
  if (changes > 0) {
    log.info({ id }, "Reopened comment");
  }
  return changes > 0;
}

export function updateCommentContent(id: string, content: string): boolean {
  const now = Date.now();
  const changes = rawRun(
    "docComments:updateCommentContent",
    /*sql*/ `UPDATE document_comments SET content = ?, updated_at = ? WHERE id = ?`,
    content,
    now,
    id,
  );
  if (changes > 0) {
    log.info({ id }, "Updated comment content");
  }
  return changes > 0;
}

export function deleteComment(id: string): boolean {
  // Replies cascade-delete via the self-referential FK on parent_comment_id.
  const changes = rawRun(
    "docComments:deleteComment",
    /*sql*/ `DELETE FROM document_comments WHERE id = ?`,
    id,
  );
  if (changes > 0) {
    log.info({ id }, "Deleted comment and its replies");
  }
  return changes > 0;
}

export function getCommentCountForDocument(surfaceId: string): number {
  const row = rawGet<{ count: number }>(
    "docComments:getCommentCount",
    /*sql*/ `SELECT COUNT(*) AS count FROM document_comments
      WHERE surface_id = ? AND status = 'open'`,
    surfaceId,
  );
  return row?.count ?? 0;
}
