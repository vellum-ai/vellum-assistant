// ---------------------------------------------------------------------------
// Memory Graph — Tool handlers for recall and remember
//
// recall: search the living graph or raw archive
// remember: save facts to the PKB (buffer.md + daily archive)
// ---------------------------------------------------------------------------

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { AssistantConfig } from "../../config/types.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { buildExcerpt, buildFtsMatchQuery } from "../conversation-queries.js";
import { embedWithRetry } from "../embed.js";
import { generateSparseEmbedding } from "../embedding-backend.js";
import { searchGraphNodes } from "./graph-search.js";
import { getNodesByIds } from "./store.js";

const log = getLogger("graph-tool-handlers");

// ---------------------------------------------------------------------------
// recall handler
// ---------------------------------------------------------------------------

export interface RecallInput {
  query: string;
  mode?: "memory" | "archive";
  num_results?: number;
  filters?: {
    types?: string[];
    after?: string;
    before?: string;
  };
}

export interface RecallResult {
  results: Array<{
    id: string;
    content: string;
    type: string;
    confidence: number;
    significance: number;
    score: number;
    created: number;
  }>;
  mode: "memory" | "archive";
  query: string;
}

export async function handleRecall(
  input: RecallInput,
  config: AssistantConfig,
  scopeId: string,
): Promise<RecallResult> {
  const mode = input.mode ?? "memory";

  if (mode === "archive") {
    return handleArchiveRecall(input, scopeId);
  }

  return handleMemoryRecall(input, config, scopeId);
}

async function handleMemoryRecall(
  input: RecallInput,
  config: AssistantConfig,
  scopeId: string,
): Promise<RecallResult> {
  // Embed the query
  let queryVector: number[] | null = null;
  try {
    const result = await embedWithRetry(config, [input.query]);
    queryVector = result.vectors[0] ?? null;
  } catch (err) {
    log.warn({ err }, "Failed to embed recall query");
    return { results: [], mode: "memory", query: input.query };
  }

  if (!queryVector) {
    return { results: [], mode: "memory", query: input.query };
  }

  // Generate sparse embedding for hybrid search (dense + sparse with RRF fusion)
  const sparseVector = generateSparseEmbedding(input.query);

  // Build date range filter for Qdrant-level filtering
  const dateRange: { afterMs?: number; beforeMs?: number } = {};
  if (input.filters?.after) {
    const afterMs = new Date(input.filters.after).getTime();
    if (!isNaN(afterMs)) dateRange.afterMs = afterMs;
  }
  if (input.filters?.before) {
    const beforeMs = new Date(input.filters.before).getTime();
    if (!isNaN(beforeMs)) dateRange.beforeMs = beforeMs;
  }

  // Search graph nodes
  const limit = Math.max(1, Math.min(input.num_results ?? 20, 50));
  const searchResults = await searchGraphNodes(
    queryVector,
    limit,
    [scopeId],
    sparseVector,
    dateRange.afterMs != null || dateRange.beforeMs != null
      ? dateRange
      : undefined,
  );
  if (searchResults.length === 0) {
    return { results: [], mode: "memory", query: input.query };
  }

  // Hydrate
  const nodes = getNodesByIds(searchResults.map((r) => r.nodeId));
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Apply filters
  const results = searchResults.flatMap((r) => {
    const node = nodeMap.get(r.nodeId);
    if (!node || node.fidelity === "gone") return [];

    // Type filter
    if (input.filters?.types && input.filters.types.length > 0) {
      if (!input.filters.types.includes(node.type)) return [];
    }

    return [
      {
        id: node.id,
        content: node.content,
        type: node.type,
        confidence: node.confidence,
        significance: node.significance,
        score: r.score,
        created: node.created,
      },
    ];
  });

  return { results, mode: "memory", query: input.query };
}

async function handleArchiveRecall(
  input: RecallInput,
  scopeId: string,
): Promise<RecallResult> {
  // Archive mode: search raw conversation transcripts via messages FTS
  // This is a simple text search — no embedding needed
  const { rawAll } = await import("../db.js");

  try {
    const limit = Math.max(1, Math.min(input.num_results ?? 20, 50));
    const ftsMatch = buildFtsMatchQuery(input.query.trim(), {
      allowFts5Syntax: true,
    });

    const afterMs = input.filters?.after
      ? new Date(input.filters.after).getTime()
      : NaN;
    const beforeMs = input.filters?.before
      ? new Date(input.filters.before).getTime()
      : NaN;
    const dateConditions: string[] = [];
    const dateParams: number[] = [];
    if (!isNaN(afterMs)) {
      dateConditions.push("m.created_at >= ?");
      dateParams.push(afterMs);
    }
    if (!isNaN(beforeMs)) {
      dateConditions.push("m.created_at <= ?");
      dateParams.push(beforeMs);
    }
    const dateClause =
      dateConditions.length > 0 ? " AND " + dateConditions.join(" AND ") : "";

    type ArchiveRow = {
      id: string;
      content: string;
      role: string;
      created_at: number;
      conversation_id: string;
    };

    let rows: ArchiveRow[];

    if (ftsMatch) {
      // Use SQLite FTS on messages table, scoped to the active memory scope
      rows = rawAll<ArchiveRow>(
        `SELECT m.id, m.content, m.role, m.created_at, c.id as conversation_id
         FROM messages_fts fts
         JOIN messages m ON m.id = fts.message_id
         JOIN conversations c ON c.id = m.conversation_id
         WHERE messages_fts MATCH ?
           AND c.memory_scope_id = ?${dateClause}
         ORDER BY rank
         LIMIT ?`,
        ftsMatch,
        scopeId,
        ...dateParams,
        limit,
      );
    } else if (!input.query.trim()) {
      // Empty or whitespace-only query — return nothing rather than matching
      // every message via a `%%` LIKE pattern.
      rows = [];
    } else {
      // All FTS tokens dropped (non-ASCII, single-char, etc.) — fall back to
      // LIKE-based search so queries like CJK characters still match.
      const likePattern = `%${input.query
        .replace(/\\/g, "\\\\")
        .replace(/%/g, "\\%")
        .replace(/_/g, "\\_")}%`;
      rows = rawAll<ArchiveRow>(
        `SELECT m.id, m.content, m.role, m.created_at, c.id as conversation_id
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE m.content LIKE ? ESCAPE '\\' AND c.memory_scope_id = ?${dateClause}
         ORDER BY m.created_at DESC
         LIMIT ?`,
        likePattern,
        scopeId,
        ...dateParams,
        limit,
      );
    }

    return {
      results: rows.map((r) => ({
        id: r.id,
        content: buildExcerpt(r.content, input.query),
        type: "archive",
        confidence: 0,
        significance: 0,
        score: 0,
        created: r.created_at,
      })),
      mode: "archive",
      query: input.query,
    };
  } catch (err) {
    log.warn({ err }, "Archive recall FTS failed");
    return { results: [], mode: "archive", query: input.query };
  }
}

// ---------------------------------------------------------------------------
// remember handler — writes to PKB buffer + daily archive
// ---------------------------------------------------------------------------

export interface RememberInput {
  content: string;
  finish_turn?: boolean;
}

export interface RememberResult {
  success: boolean;
  message: string;
}

export function handleRemember(
  input: RememberInput,
  _conversationId: string,
  _scopeId: string,
): RememberResult {
  if (!input.content || input.content.trim().length === 0) {
    return { success: false, message: "content is required" };
  }

  const workspaceDir = getWorkspaceDir();
  const pkbDir = join(workspaceDir, "pkb");
  const archiveDir = join(pkbDir, "archive");

  // Ensure directories exist
  mkdirSync(pkbDir, { recursive: true });
  mkdirSync(archiveDir, { recursive: true });

  // Build timestamped entry
  const now = new Date();
  const month = now.toLocaleString("en-US", { month: "short" });
  const day = now.getDate();
  const hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 || 12;
  const entry = `- [${month} ${day}, ${displayHour}:${minutes} ${ampm}] ${input.content.trim()}\n`;

  // Append to buffer.md
  const bufferPath = join(pkbDir, "buffer.md");
  appendFileSync(bufferPath, entry, "utf-8");

  // Append to daily archive
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const archivePath = join(archiveDir, `${yyyy}-${mm}-${dd}.md`);
  if (!existsSync(archivePath)) {
    appendFileSync(archivePath, `# ${month} ${day}, ${yyyy}\n\n`, "utf-8");
  }
  appendFileSync(archivePath, entry, "utf-8");

  return { success: true, message: "Saved to knowledge base." };
}
