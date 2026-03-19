import { and, count, desc, eq, sql } from "drizzle-orm";

import { getLogger } from "../util/logger.js";
import type { ConversationRow } from "./conversation-crud.js";
import { parseConversation } from "./conversation-crud.js";
import { ensureDisplayOrderMigration } from "./conversation-display-order-migration.js";
import { getDb, rawAll } from "./db.js";
import { conversations, messages } from "./schema.js";

const log = getLogger("conversation-store");

/**
 * Build an FTS5 MATCH query string from natural text by extracting tokens.
 * Used for messages_fts full-text search over conversation content.
 */
function buildFtsMatchQuery(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  if (tokens.length === 0) return null;
  const unique = [...new Set(tokens)].slice(0, 24);
  return unique.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
}

export function listConversations(
  limit?: number,
  includeBackground = false,
  offset = 0,
): ConversationRow[] {
  ensureDisplayOrderMigration();
  const db = getDb();
  const where = includeBackground
    ? undefined
    : sql`${conversations.conversationType} NOT IN ('background', 'private')`;
  const query = db
    .select()
    .from(conversations)
    .where(where)
    .orderBy(desc(conversations.updatedAt))
    .limit(limit ?? 100)
    .offset(offset);
  return query.all().map(parseConversation);
}

export function countConversations(includeBackground = false): number {
  const db = getDb();
  const where = includeBackground
    ? undefined
    : sql`${conversations.conversationType} NOT IN ('background', 'private')`;
  const [{ total }] = db
    .select({ total: count() })
    .from(conversations)
    .where(where)
    .all();
  return total;
}

export function getLatestConversation(): ConversationRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(conversations)
    .where(
      sql`${conversations.conversationType} NOT IN ('background', 'private')`,
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(1)
    .get();
  return row ? parseConversation(row) : null;
}

/**
 * Check whether the last user message in a conversation is a tool_result-only
 * message (i.e., not a real user-typed message). This is used by undo() to
 * determine if additional exchanges need to be deleted from the DB.
 */
export function isLastUserMessageToolResult(conversationId: string): boolean {
  const db = getDb();
  const lastUserMsg = db
    .select({ content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.role, "user"),
      ),
    )
    .orderBy(sql`rowid DESC`)
    .limit(1)
    .get();

  if (!lastUserMsg) return false;

  try {
    const parsed = JSON.parse(lastUserMsg.content);
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every(
        (block: Record<string, unknown>) =>
          block.type === "tool_result" ||
          block.type === "web_search_tool_result" ||
          (block.type === "text" &&
            typeof block.text === "string" &&
            block.text.startsWith("<system_notice>") &&
            block.text.endsWith("</system_notice>")),
      )
    ) {
      return true;
    }
  } catch {
    // Not JSON — it's a plain text user message
  }
  return false;
}

export interface ConversationSearchResult {
  conversationId: string;
  conversationTitle: string | null;
  conversationUpdatedAt: number;
  matchingMessages: Array<{
    messageId: string;
    role: string;
    /** Plain-text excerpt around the match, truncated to ~200 chars. */
    excerpt: string;
    createdAt: number;
  }>;
}

/**
 * Full-text search across message content using FTS5.
 * Uses the messages_fts virtual table for fast tokenized matching on message
 * content, with a LIKE fallback on conversation titles. Returns matching
 * conversations with their relevant messages, ordered by most recently updated.
 */
export function searchConversations(
  query: string,
  opts?: { limit?: number; maxMessagesPerConversation?: number },
): ConversationSearchResult[] {
  if (!query.trim()) return [];

  const db = getDb();
  const limit = opts?.limit ?? 20;
  const maxMsgsPerConv = opts?.maxMessagesPerConversation ?? 3;

  const ftsMatch = buildFtsMatchQuery(query.trim());

  // LIKE pattern for title matching (FTS only covers message content).
  const titlePattern = `%${query
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_")}%`;

  interface ConvIdRow {
    conversation_id: string;
  }

  // Collect conversation IDs from FTS message matches and title LIKE matches,
  // then merge them to produce the final set of matching conversations.
  // Both paths LIMIT on distinct conversation_id to prevent a single
  // conversation with many matching messages from crowding out others.
  const ftsConvIds = new Set<string>();
  if (ftsMatch) {
    try {
      const ftsRows = rawAll<ConvIdRow>(
        `
        SELECT DISTINCT m.conversation_id
        FROM messages_fts f
        JOIN messages m ON m.id = f.message_id
        JOIN conversations c ON c.id = m.conversation_id
        WHERE messages_fts MATCH ? AND c.conversation_type NOT IN ('background', 'private')
        LIMIT 1000
      `,
        ftsMatch,
      );
      for (const row of ftsRows) ftsConvIds.add(row.conversation_id);
    } catch (err) {
      log.warn(
        { err, query: query.slice(0, 80) },
        "searchConversations: FTS query failed — falling through to title matches",
      );
    }
  } else if (query.trim()) {
    // FTS tokens were all dropped (non-ASCII, single-char, etc.) — fall back to
    // LIKE-based message content search so queries like "你", "é", or "C++" still
    // match message text.
    const likePattern = `%${query
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_")}%`;
    const likeRows = rawAll<ConvIdRow>(
      `
      SELECT DISTINCT m.conversation_id
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.content LIKE ? ESCAPE '\\' AND c.conversation_type NOT IN ('background', 'private')
      LIMIT 1000
    `,
      likePattern,
    );
    for (const row of likeRows) ftsConvIds.add(row.conversation_id);
  }

  // Title-only matches (FTS doesn't index conversation titles).
  const titleMatchConvs = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        sql`${conversations.conversationType} NOT IN ('background', 'private')`,
        sql`${conversations.title} LIKE ${titlePattern} ESCAPE '\\'`,
      ),
    )
    .all();
  for (const row of titleMatchConvs) ftsConvIds.add(row.id);

  if (ftsConvIds.size === 0) return [];

  // Fetch the matching conversation rows, ordered by updatedAt, capped at limit.
  const convIds = [...ftsConvIds];
  const placeholders = convIds.map(() => "?").join(",");
  interface ConvRow {
    id: string;
    title: string | null;
    updated_at: number;
  }
  const matchingConversations = rawAll<ConvRow>(
    `SELECT id, title, updated_at FROM conversations
     WHERE id IN (${placeholders})
     ORDER BY updated_at DESC
     LIMIT ?`,
    ...convIds,
    limit,
  );

  if (matchingConversations.length === 0) return [];

  const results: ConversationSearchResult[] = [];

  for (const conv of matchingConversations) {
    interface MsgRow {
      id: string;
      role: string;
      content: string;
      created_at: number;
    }
    let matchingMsgs: MsgRow[] = [];
    if (ftsMatch) {
      try {
        matchingMsgs = rawAll<MsgRow>(
          `
          SELECT m.id, m.role, m.content, m.created_at
          FROM messages_fts f
          JOIN messages m ON m.id = f.message_id
          WHERE messages_fts MATCH ? AND m.conversation_id = ?
          ORDER BY m.created_at ASC
          LIMIT ?
        `,
          ftsMatch,
          conv.id,
          maxMsgsPerConv,
        );
      } catch (err) {
        log.warn(
          { err, conversationId: conv.id },
          "searchConversations: FTS per-conversation query failed",
        );
      }
    } else if (query.trim()) {
      // LIKE fallback for non-ASCII / short-token queries.
      const msgLikePattern = `%${query
        .replace(/\\/g, "\\\\")
        .replace(/%/g, "\\%")
        .replace(/_/g, "\\_")}%`;
      matchingMsgs = rawAll<MsgRow>(
        `
        SELECT id, role, content, created_at
        FROM messages
        WHERE conversation_id = ? AND content LIKE ? ESCAPE '\\'
        ORDER BY created_at ASC
        LIMIT ?
      `,
        conv.id,
        msgLikePattern,
        maxMsgsPerConv,
      );
    }

    results.push({
      conversationId: conv.id,
      conversationTitle: conv.title,
      conversationUpdatedAt: conv.updated_at,
      matchingMessages: matchingMsgs.map((m) => ({
        messageId: m.id,
        role: m.role,
        excerpt: buildExcerpt(m.content, query),
        createdAt: m.created_at,
      })),
    });
  }

  return results;
}

/**
 * Build a short excerpt from raw message content centered around the first
 * occurrence of `query`. The content may be JSON (content blocks) or plain
 * text; we extract a readable snippet in either case.
 */
function buildExcerpt(rawContent: string, query: string): string {
  // Try to extract plain text from JSON content blocks first.
  let text = rawContent;
  try {
    const parsed = JSON.parse(rawContent);
    if (Array.isArray(parsed)) {
      const parts: string[] = [];
      for (const block of parsed) {
        if (typeof block === "object" && block != null) {
          if (block.type === "text" && typeof block.text === "string") {
            parts.push(block.text);
          } else if (
            block.type === "tool_result" ||
            block.type === "web_search_tool_result"
          ) {
            const inner = Array.isArray(block.content) ? block.content : [];
            for (const ib of inner) {
              if (ib?.type === "text" && typeof ib.text === "string")
                parts.push(ib.text);
            }
          }
        }
      }
      if (parts.length > 0) text = parts.join(" ");
    } else if (typeof parsed === "string") {
      text = parsed;
    }
  } catch {
    // Not JSON — use as-is
  }

  const WINDOW = 100;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) {
    // Query matched the raw JSON but not the extracted text — fall back to raw start
    return text
      .slice(0, WINDOW * 2)
      .replace(/\s+/g, " ")
      .trim();
  }
  const start = Math.max(0, idx - WINDOW);
  const end = Math.min(text.length, idx + query.length + WINDOW);
  const excerpt =
    (start > 0 ? "\u2026" : "") +
    text.slice(start, end).replace(/\s+/g, " ").trim() +
    (end < text.length ? "\u2026" : "");
  return excerpt;
}
