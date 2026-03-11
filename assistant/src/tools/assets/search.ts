/**
 * asset_search — cross-thread attachment metadata search.
 *
 * Queries the attachments store for matching assets by MIME type,
 * filename, recency, or conversation scope. Returns metadata and
 * attachment IDs only — never base64 payloads. The IDs can be
 * passed to asset_materialize (PR 35) to retrieve actual content.
 */

import { and, desc, eq, gte, like } from "drizzle-orm";

import {
  type AttachmentContext,
  isAttachmentVisible,
} from "../../daemon/media-visibility-policy.js";
import type { StoredAttachment } from "../../memory/attachments-store.js";
import { getConversationThreadType } from "../../memory/conversation-crud.js";
import { getDb, rawAll } from "../../memory/db.js";
import {
  attachments,
  conversations,
  messageAttachments,
  messages,
} from "../../memory/schema.js";
import { escapeLikeWildcards } from "../../memory/search/lexical.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { registerTool } from "../registry.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

// ---------------------------------------------------------------------------
// Recency presets — map human-readable labels to epoch-ms cutoff offsets
// ---------------------------------------------------------------------------

const RECENCY_MS: Record<string, number> = {
  last_hour: 60 * 60 * 1000,
  last_24_hours: 24 * 60 * 60 * 1000,
  last_7_days: 7 * 24 * 60 * 60 * 1000,
  last_30_days: 30 * 24 * 60 * 60 * 1000,
  last_90_days: 90 * 24 * 60 * 60 * 1000,
};

const VALID_RECENCY_VALUES = Object.keys(RECENCY_MS);

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAttachment(a: StoredAttachment): string {
  const date = new Date(a.createdAt).toISOString();
  return [
    `- **${a.originalFilename}** (ID: ${a.id})`,
    `  Type: ${a.mimeType} | Kind: ${a.kind} | Size: ${formatBytes(a.sizeBytes)}`,
    `  Created: ${date}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Attachment source conversation lookup
// ---------------------------------------------------------------------------

/**
 * Look up which conversations an attachment belongs to, along with each
 * conversation's thread type. An attachment can be linked to multiple
 * messages across multiple conversations.
 */
export function getAttachmentSourceConversations(
  attachmentId: string,
): Array<{ conversationId: string; threadType: string }> {
  const db = getDb();
  return db
    .select({
      conversationId: messages.conversationId,
      threadType: conversations.threadType,
    })
    .from(messageAttachments)
    .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messageAttachments.attachmentId, attachmentId))
    .all();
}

/**
 * Check whether an attachment is visible from the given context.
 * Returns true if visible, false if hidden.
 *
 * - Orphan attachments (no message linkage) are universally visible.
 * - Attachments with any standard-thread source are universally visible.
 * - All-private attachments are visible only if the caller is in one of
 *   the source private threads.
 */
function isAttachmentVisibleFromContext(
  attachmentId: string,
  currentContext: AttachmentContext,
): boolean {
  const sources = getAttachmentSourceConversations(attachmentId);
  if (sources.length === 0) {
    return true;
  }

  const hasStandard = sources.some((s) => s.threadType !== "private");
  if (hasStandard) {
    return true;
  }

  // All sources are private — visible only if the caller is in one of those threads
  return sources.some((s) =>
    isAttachmentVisible(
      { conversationId: s.conversationId, isPrivate: true },
      currentContext,
    ),
  );
}

// ---------------------------------------------------------------------------
// Search logic
// ---------------------------------------------------------------------------

export interface AssetSearchParams {
  mime_type?: string;
  filename?: string;
  recency?: string;
  conversation_id?: string;
  limit?: number;
}

const MAX_RESULTS = 100;
const DEFAULT_LIMIT = 20;

export function searchAttachments(
  params: AssetSearchParams,
): StoredAttachment[] {
  const db = getDb();
  const conditions = [];

  // MIME type filter — supports wildcards like 'image/*' via LIKE
  if (params.mime_type) {
    const mimePattern = params.mime_type.replace(/\*/g, "%");
    conditions.push(like(attachments.mimeType, mimePattern));
  }

  // Filename filter — case-insensitive substring match (escape LIKE wildcards)
  if (params.filename) {
    conditions.push(
      like(
        attachments.originalFilename,
        `%${escapeLikeWildcards(params.filename)}%`,
      ),
    );
  }

  // Recency filter — computed cutoff timestamp
  if (params.recency) {
    const offsetMs = RECENCY_MS[params.recency];
    if (offsetMs) {
      const cutoff = Date.now() - offsetMs;
      conditions.push(gte(attachments.createdAt, cutoff));
    }
  }

  // Conversation scope — join through message_attachments + messages
  if (params.conversation_id) {
    const linkedIds = db
      .select({ attachmentId: messageAttachments.attachmentId })
      .from(messageAttachments)
      .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
      .where(eq(messages.conversationId, params.conversation_id))
      .all()
      .map((r) => r.attachmentId)
      .filter((id): id is string => id !== undefined);

    if (linkedIds.length === 0) {
      return [];
    }

    const placeholders = linkedIds.map(() => "?").join(", ");

    // Build WHERE clauses for raw query (FTS5 virtual table not involved,
    // but dynamic IN-list with optional filters is simpler in raw SQL)
    const whereParts: string[] = [`a.id IN (${placeholders})`];
    const bindValues: (string | number)[] = [...linkedIds];

    if (params.mime_type) {
      const mimePattern = params.mime_type.replace(/\*/g, "%");
      whereParts.push(`a.mime_type LIKE ?`);
      bindValues.push(mimePattern);
    }
    if (params.filename) {
      whereParts.push(`a.original_filename LIKE ?`);
      bindValues.push(`%${escapeLikeWildcards(params.filename)}%`);
    }
    if (params.recency) {
      const offsetMs = RECENCY_MS[params.recency];
      if (offsetMs) {
        whereParts.push(`a.created_at >= ?`);
        bindValues.push(Date.now() - offsetMs);
      }
    }
    const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_RESULTS);

    interface AttachmentRow {
      id: string;
      original_filename: string;
      mime_type: string;
      size_bytes: number;
      kind: string;
      thumbnail_base64: string | null;
      created_at: number;
    }

    const rows = rawAll<AttachmentRow>(
      `SELECT a.id, a.original_filename, a.mime_type, a.size_bytes, a.kind, a.thumbnail_base64, a.created_at
       FROM attachments a
       WHERE ${whereParts.join(" AND ")}
       ORDER BY a.created_at DESC
       LIMIT ?`,
      ...bindValues,
      limit,
    );

    return rows.map((r) => ({
      id: r.id,
      originalFilename: r.original_filename,
      mimeType: r.mime_type,
      sizeBytes: r.size_bytes,
      kind: r.kind,
      thumbnailBase64: r.thumbnail_base64,
      createdAt: r.created_at,
    }));
  }

  // No conversation constraint — query attachments table directly
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_RESULTS);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const query = db
    .select({
      id: attachments.id,
      originalFilename: attachments.originalFilename,
      mimeType: attachments.mimeType,
      sizeBytes: attachments.sizeBytes,
      kind: attachments.kind,
      thumbnailBase64: attachments.thumbnailBase64,
      createdAt: attachments.createdAt,
    })
    .from(attachments)
    .orderBy(desc(attachments.createdAt))
    .limit(limit);

  if (where) {
    return query.where(where).all();
  }
  return query.all();
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const definition: ToolDefinition = {
  name: "asset_search",
  description:
    "Search for previously uploaded media assets (images, documents, etc.) by metadata. " +
    "Returns attachment IDs and metadata — not file content. Use the returned IDs with " +
    "asset_materialize to retrieve actual file data.",
  input_schema: {
    type: "object",
    properties: {
      mime_type: {
        type: "string",
        description:
          'Filter by MIME type. Supports wildcards: "image/*" matches all images, ' +
          '"application/pdf" matches PDFs exactly.',
      },
      filename: {
        type: "string",
        description:
          "Search by original filename (case-insensitive substring match).",
      },
      recency: {
        type: "string",
        enum: VALID_RECENCY_VALUES,
        description:
          "Filter by recency. One of: last_hour, last_24_hours, last_7_days, last_30_days, last_90_days.",
      },
      conversation_id: {
        type: "string",
        description:
          "Constrain results to attachments linked to messages in a specific conversation.",
      },
      limit: {
        type: "number",
        description: `Maximum results to return (default ${DEFAULT_LIMIT}, max ${MAX_RESULTS}).`,
      },
    },
    required: [],
  },
};

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

class AssetSearchTool implements Tool {
  name = "asset_search";
  description = definition.description;
  category = "assets";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return definition;
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const mimeType = input.mime_type as string | undefined;
    const filename = input.filename as string | undefined;
    const recency = input.recency as string | undefined;
    const conversationId = input.conversation_id as string | undefined;
    const limit = input.limit as number | undefined;

    // Validate recency if provided
    if (recency && !RECENCY_MS[recency]) {
      return {
        content: `Error: Invalid recency value "${recency}". Valid values: ${VALID_RECENCY_VALUES.join(", ")}`,
        isError: true,
      };
    }

    // Validate limit if provided
    if (limit !== undefined && (typeof limit !== "number" || limit < 1)) {
      return {
        content: "Error: limit must be a positive number.",
        isError: true,
      };
    }

    try {
      // Over-fetch with MAX_RESULTS so visibility filtering doesn't
      // under-fill the caller's requested limit.
      const results = searchAttachments({
        mime_type: mimeType,
        filename,
        recency,
        conversation_id: conversationId,
        limit: MAX_RESULTS,
      });

      // Enforce private-thread visibility: filter out attachments that
      // belong exclusively to private threads the caller cannot access.
      const currentThreadType = getConversationThreadType(
        context.conversationId,
      );
      const currentContext: AttachmentContext = {
        conversationId: context.conversationId,
        isPrivate: currentThreadType === "private",
      };

      const effectiveLimit = Math.min(limit ?? DEFAULT_LIMIT, MAX_RESULTS);
      const visible = results
        .filter((attachment) =>
          isAttachmentVisibleFromContext(attachment.id, currentContext),
        )
        .slice(0, effectiveLimit);

      if (visible.length === 0) {
        return {
          content: "No assets found matching the search criteria.",
          isError: false,
        };
      }

      const lines = [`Found ${visible.length} asset(s):\n`];
      for (const attachment of visible) {
        lines.push(formatAttachment(attachment));
      }

      return { content: lines.join("\n"), isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error: ${msg}`, isError: true };
    }
  }
}

export const assetSearchTool = new AssetSearchTool();

registerTool(assetSearchTool);
