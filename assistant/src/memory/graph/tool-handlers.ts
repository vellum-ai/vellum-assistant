// ---------------------------------------------------------------------------
// Memory Graph — Tool handlers for recall and remember
//
// These are the implementations behind the recall/remember tool definitions.
// recall: search the living graph or raw archive
// remember: immediate CRUD on graph nodes (replaces NOW.md)
// ---------------------------------------------------------------------------

import type { AssistantConfig } from "../../config/types.js";
import { getLogger } from "../../util/logger.js";
import { embedWithRetry } from "../embed.js";
import { generateSparseEmbedding } from "../embedding-backend.js";
import { enqueueGraphNodeEmbed, searchGraphNodes } from "./graph-search.js";
import {
  createNode,
  deleteNode,
  getNode,
  getNodesByIds,
  updateNode,
} from "./store.js";
import type {
  DecayCurve,
  EmotionalCharge,
  Fidelity,
  MemoryType,
  NewNode,
  SourceType,
} from "./types.js";

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

  // Search graph nodes
  const limit = Math.min(input.num_results ?? 20, 50);
  const searchResults = await searchGraphNodes(
    queryVector,
    limit,
    [scopeId],
    sparseVector,
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

    // Date filters
    if (input.filters?.after) {
      const afterMs = new Date(input.filters.after).getTime();
      if (!isNaN(afterMs) && node.created < afterMs) return [];
    }
    if (input.filters?.before) {
      const beforeMs = new Date(input.filters.before).getTime();
      if (!isNaN(beforeMs) && node.created > beforeMs) return [];
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
    // Use SQLite FTS on messages table, scoped to the active memory scope
    const limit = Math.min(input.num_results ?? 20, 50);
    const rows = rawAll(
      `SELECT m.id, m.content, m.role, m.created_at, c.id as conversation_id
       FROM messages_fts fts
       JOIN messages m ON m.rowid = fts.rowid
       JOIN conversations c ON c.id = m.conversation_id
       WHERE messages_fts MATCH ?
         AND c.memory_scope_id = ?
       ORDER BY rank
       LIMIT ?`,
      input.query,
      scopeId,
      limit,
    ) as Array<{
      id: string;
      content: string;
      role: string;
      created_at: number;
      conversation_id: string;
    }>;

    return {
      results: rows.map((r) => ({
        id: r.id,
        content:
          typeof r.content === "string"
            ? r.content.slice(0, 500)
            : String(r.content).slice(0, 500),
        type: "archive",
        confidence: 1.0,
        significance: 0,
        score: 1.0,
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
// remember handler
// ---------------------------------------------------------------------------

export interface RememberInput {
  op: "save" | "update" | "delete";
  memory_id?: string;
  content?: string;
  type?: string;
  significance?: number;
  emotional_charge?: {
    valence?: number;
    intensity?: number;
  };
}

export interface RememberResult {
  success: boolean;
  op: string;
  memory_id?: string;
  message: string;
}

const VALID_TYPES = new Set<MemoryType>([
  "episodic",
  "semantic",
  "procedural",
  "emotional",
  "prospective",
  "behavioral",
  "narrative",
  "shared",
]);

export function handleRemember(
  input: RememberInput,
  conversationId: string,
  scopeId: string,
): RememberResult {
  switch (input.op) {
    case "save":
      return handleSave(input, conversationId, scopeId);
    case "update":
      return handleUpdate(input);
    case "delete":
      return handleDelete(input);
    default:
      return {
        success: false,
        op: input.op,
        message: `Unknown operation: ${input.op}`,
      };
  }
}

function handleSave(
  input: RememberInput,
  conversationId: string,
  scopeId: string,
): RememberResult {
  if (!input.content) {
    return {
      success: false,
      op: "save",
      message: "content is required for save",
    };
  }
  if (!input.type || !VALID_TYPES.has(input.type as MemoryType)) {
    return {
      success: false,
      op: "save",
      message: `type is required and must be one of: ${[...VALID_TYPES].join(", ")}`,
    };
  }

  const now = Date.now();
  const emotionalCharge: EmotionalCharge = {
    valence: clamp(input.emotional_charge?.valence ?? 0, -1, 1),
    intensity: clamp(input.emotional_charge?.intensity ?? 0, 0, 1),
    decayCurve: "linear" as DecayCurve,
    decayRate: 0.05,
    originalIntensity: clamp(input.emotional_charge?.intensity ?? 0, 0, 1),
  };

  const node: NewNode = {
    content: input.content,
    type: input.type as MemoryType,
    created: now,
    lastAccessed: now,
    lastConsolidated: now,
    eventDate: null,
    emotionalCharge,
    fidelity: "vivid" as Fidelity,
    confidence: 0.95, // Explicitly saved = high confidence
    significance: clamp(input.significance ?? 0.5, 0, 1),
    stability: 14,
    reinforcementCount: 0,
    lastReinforced: now,
    sourceConversations: [conversationId],
    sourceType: "direct" as SourceType,
    narrativeRole: null,
    partOfStory: null,
    imageRefs: null,
    scopeId,
  };

  const created = createNode(node);

  // Enqueue embedding job immediately
  enqueueGraphNodeEmbed(created.id);

  return {
    success: true,
    op: "save",
    memory_id: created.id,
    message: "Memory saved.",
  };
}

function handleUpdate(input: RememberInput): RememberResult {
  if (!input.memory_id) {
    return {
      success: false,
      op: "update",
      message: "memory_id is required for update",
    };
  }

  const existing = getNode(input.memory_id);
  if (!existing) {
    return {
      success: false,
      op: "update",
      memory_id: input.memory_id,
      message: "Memory not found",
    };
  }

  const changes: Record<string, unknown> = {};
  if (input.content) changes.content = input.content;
  if (input.significance != null)
    changes.significance = clamp(input.significance, 0, 1);
  if (input.type && VALID_TYPES.has(input.type as MemoryType))
    changes.type = input.type;

  if (Object.keys(changes).length > 0) {
    updateNode(input.memory_id, changes);
    // Re-embed if content changed
    if (input.content) {
      enqueueGraphNodeEmbed(input.memory_id);
    }
  }

  return {
    success: true,
    op: "update",
    memory_id: input.memory_id,
    message: "Memory updated.",
  };
}

function handleDelete(input: RememberInput): RememberResult {
  if (!input.memory_id) {
    return {
      success: false,
      op: "delete",
      message: "memory_id is required for delete",
    };
  }

  const existing = getNode(input.memory_id);
  if (!existing) {
    return {
      success: false,
      op: "delete",
      memory_id: input.memory_id,
      message: "Memory not found",
    };
  }

  deleteNode(input.memory_id);

  return {
    success: true,
    op: "delete",
    memory_id: input.memory_id,
    message: "Memory deleted.",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
