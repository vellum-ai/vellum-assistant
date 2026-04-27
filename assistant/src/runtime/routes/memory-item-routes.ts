/**
 * Route handlers for memory item CRUD endpoints.
 *
 * Queries memory_graph_nodes and maps results to the client's
 * MemoryItemPayload shape for backwards compatibility.
 *
 * GET    /v1/memory-items        — list memory items (with filtering, search, sort, pagination)
 * GET    /v1/memory-items/:id    — get a single memory item
 * POST   /v1/memory-items        — create a new memory item
 * PATCH  /v1/memory-items/:id    — update an existing memory item
 * DELETE /v1/memory-items/:id    — delete a memory item and its embeddings
 */

import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  like,
  ne,
  notInArray,
} from "drizzle-orm";
import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import { getDb } from "../../memory/db-connection.js";
import {
  embedWithBackend,
  generateSparseEmbedding,
  getMemoryBackendStatus,
} from "../../memory/embedding-backend.js";
import {
  createNode,
  deleteNode,
  getNode,
  updateNode,
} from "../../memory/graph/store.js";
import type {
  Fidelity,
  ImageRef,
  MemoryNode,
  MemoryType,
  NewNode,
} from "../../memory/graph/types.js";
import { enqueueMemoryJob } from "../../memory/jobs-store.js";
import { withQdrantBreaker } from "../../memory/qdrant-circuit-breaker.js";
import { getQdrantClient } from "../../memory/qdrant-client.js";
import { memoryGraphNodes } from "../../memory/schema.js";
import { getLogger } from "../../util/logger.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "./errors.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("memory-item-routes");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_TYPES: MemoryType[] = [
  "episodic",
  "semantic",
  "procedural",
  "emotional",
  "prospective",
  "behavioral",
  "narrative",
  "shared",
];

const VALID_SORT_FIELDS = [
  "lastSeenAt",
  "importance",
  "kind",
  "firstSeenAt",
] as const;

type SortField = (typeof VALID_SORT_FIELDS)[number];

const SORT_COLUMN_MAP = {
  lastSeenAt: memoryGraphNodes.lastAccessed,
  importance: memoryGraphNodes.significance,
  kind: memoryGraphNodes.type,
  firstSeenAt: memoryGraphNodes.created,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidType(value: string): value is MemoryType {
  return (VALID_TYPES as string[]).includes(value);
}

function isValidSortField(value: string): value is SortField {
  return (VALID_SORT_FIELDS as readonly string[]).includes(value);
}

/**
 * Split graph node content into subject (first line) and statement (rest).
 * Playbooks store JSON in statement; other nodes use plain prose.
 */
function splitContent(content: string): { subject: string; statement: string } {
  const newlineIdx = content.indexOf("\n");
  if (newlineIdx === -1) {
    return { subject: content, statement: content };
  }
  return {
    subject: content.slice(0, newlineIdx).trim(),
    statement: content.slice(newlineIdx + 1).trim(),
  };
}

/**
 * Map a graph node to the client's MemoryItemPayload shape.
 */
function nodeToPayload(
  node: MemoryNode,
  scopeLabel: string | null = null,
): Record<string, unknown> {
  const { subject, statement } = splitContent(node.content);
  return {
    id: node.id,
    kind: node.type,
    subject,
    statement,
    status: node.fidelity === "gone" ? "superseded" : "active",
    confidence: node.confidence,
    importance: node.significance,
    eventDate: node.eventDate,
    firstSeenAt: node.created,
    lastSeenAt: node.lastAccessed,

    // Graph-specific fields
    fidelity: node.fidelity,
    sourceType: node.sourceType,
    narrativeRole: node.narrativeRole,
    partOfStory: node.partOfStory,
    reinforcementCount: node.reinforcementCount,
    stability: node.stability,
    emotionalCharge: node.emotionalCharge,

    scopeId: node.scopeId,
    scopeLabel,

    // Legacy fields — not applicable to graph nodes
    accessCount: null,
    verificationState: null,
    lastUsedAt: null,
    supersedes: null,
    supersededBy: null,
  };
}

// ---------------------------------------------------------------------------
// Semantic search constants
// ---------------------------------------------------------------------------

const SEMANTIC_SEARCH_FETCH_CEILING = 10_000;

// ---------------------------------------------------------------------------
// Semantic search helper
// ---------------------------------------------------------------------------

/**
 * Hybrid semantic search for graph nodes via Qdrant.
 * Returns ordered node IDs + total count on success, or `null` when
 * the embedding backend / Qdrant is unavailable (caller falls back to SQL).
 */
async function searchNodesSemantic(
  query: string,
  fetchLimit: number,
  kindFilter: string | null,
): Promise<{ ids: string[]; total: number } | null> {
  try {
    const config = getConfig();
    const backendStatus = await getMemoryBackendStatus(config);
    if (!backendStatus.provider) return null;

    const embedded = await embedWithBackend(config, [query]);
    const queryVector = embedded.vectors[0];
    if (!queryVector) return null;

    const sparse = generateSparseEmbedding(query);
    const sparseVector = { indices: sparse.indices, values: sparse.values };

    // Filter to graph_node target_type, exclude gone nodes
    const mustConditions: Array<Record<string, unknown>> = [
      { key: "target_type", match: { value: "graph_node" } },
    ];
    if (kindFilter) {
      mustConditions.push({ key: "kind", match: { value: kindFilter } });
    }

    const filter = {
      must: mustConditions,
      must_not: [{ key: "_meta", match: { value: true } }],
    };

    const qdrant = getQdrantClient();
    const results = await withQdrantBreaker(() =>
      qdrant.hybridSearch({
        denseVector: queryVector,
        sparseVector,
        filter,
        limit: fetchLimit,
        prefetchLimit: fetchLimit,
      }),
    );

    const ids = results.map((r) => r.payload.target_id);
    return { ids, total: ids.length };
  } catch (err) {
    log.warn({ err }, "Semantic memory search failed, falling back to SQL");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Row → MemoryNode helper (inline version of store's rowToNode)
// ---------------------------------------------------------------------------

function rowToNode(row: typeof memoryGraphNodes.$inferSelect): MemoryNode {
  return {
    id: row.id,
    content: row.content,
    type: row.type as MemoryType,
    created: row.created,
    lastAccessed: row.lastAccessed,
    lastConsolidated: row.lastConsolidated,
    eventDate: row.eventDate ?? null,
    emotionalCharge: JSON.parse(row.emotionalCharge),
    fidelity: row.fidelity as Fidelity,
    confidence: row.confidence,
    significance: row.significance,
    stability: row.stability,
    reinforcementCount: row.reinforcementCount,
    lastReinforced: row.lastReinforced,
    sourceConversations: JSON.parse(row.sourceConversations) as string[],
    sourceType: row.sourceType as
      | "direct"
      | "inferred"
      | "observed"
      | "told-by-other",
    narrativeRole: row.narrativeRole as MemoryNode["narrativeRole"],
    partOfStory: row.partOfStory,
    imageRefs: row.imageRefs
      ? (JSON.parse(row.imageRefs) as ImageRef[])
      : null,
    scopeId: row.scopeId ?? "default",
  };
}

// ---------------------------------------------------------------------------
// Handler implementations
// ---------------------------------------------------------------------------

async function handleListMemoryItems(queryParams: Record<string, string>) {
  const kindParam = queryParams.kind ?? undefined;
  const statusParam = queryParams.status ?? "active";
  const searchParam = queryParams.search ?? undefined;
  const sortParam = queryParams.sort ?? "lastSeenAt";
  const orderParam = queryParams.order ?? "desc";
  const limitParam = Number(queryParams.limit ?? 100);
  const offsetParam = Number(queryParams.offset ?? 0);

  if (kindParam && !isValidType(kindParam)) {
    throw new BadRequestError(
      `Invalid kind "${kindParam}". Must be one of: ${VALID_TYPES.join(", ")}`,
    );
  }

  if (!isValidSortField(sortParam)) {
    throw new BadRequestError(
      `Invalid sort "${sortParam}". Must be one of: ${VALID_SORT_FIELDS.join(", ")}`,
    );
  }

  if (orderParam !== "asc" && orderParam !== "desc") {
    throw new BadRequestError(
      `Invalid order "${orderParam}". Must be "asc" or "desc"`,
    );
  }

  const db = getDb();

  // Build fidelity filter based on status param
  const fidelityFilter =
    statusParam === "all"
      ? undefined
      : statusParam === "inactive"
        ? eq(memoryGraphNodes.fidelity, "gone")
        : notInArray(memoryGraphNodes.fidelity, ["gone"]);

  // ── Semantic search path ────────────────────────────────────────────
  if (searchParam) {
    const semanticResult = await searchNodesSemantic(
      searchParam,
      SEMANTIC_SEARCH_FETCH_CEILING,
      null,
    );

    if (semanticResult && semanticResult.ids.length > 0) {
      // Compute kindCounts from all semantic matches
      const kindCountConditions = [
        inArray(memoryGraphNodes.id, semanticResult.ids),
      ];
      if (fidelityFilter) kindCountConditions.push(fidelityFilter);

      const kindCountRows = db
        .select({ kind: memoryGraphNodes.type, count: count() })
        .from(memoryGraphNodes)
        .where(and(...kindCountConditions))
        .groupBy(memoryGraphNodes.type)
        .all();
      const semanticKindCounts: Record<string, number> = {};
      for (const row of kindCountRows) {
        semanticKindCounts[row.kind] = row.count;
      }

      // Apply kind + fidelity filter while preserving semantic relevance ordering
      let filteredIds = semanticResult.ids;
      {
        const filterConditions = [
          inArray(memoryGraphNodes.id, semanticResult.ids),
        ];
        if (kindParam) {
          filterConditions.push(eq(memoryGraphNodes.type, kindParam));
        }
        if (fidelityFilter) filterConditions.push(fidelityFilter);

        if (filterConditions.length > 1) {
          const validIdSet = new Set(
            db
              .select({ id: memoryGraphNodes.id })
              .from(memoryGraphNodes)
              .where(and(...filterConditions))
              .all()
              .map((r) => r.id),
          );
          filteredIds = semanticResult.ids.filter((id) => validIdSet.has(id));
        }
      }

      const total = filteredIds.length;
      const pageIds = filteredIds.slice(offsetParam, offsetParam + limitParam);

      if (pageIds.length === 0) {
        return {
          items: [],
          total,
          kindCounts: semanticKindCounts,
        };
      }

      // Hydrate nodes from DB
      const hydrationConditions = [inArray(memoryGraphNodes.id, pageIds)];
      if (fidelityFilter) hydrationConditions.push(fidelityFilter);
      if (kindParam)
        hydrationConditions.push(eq(memoryGraphNodes.type, kindParam));

      const rows = db
        .select()
        .from(memoryGraphNodes)
        .where(and(...hydrationConditions))
        .all();

      // Preserve Qdrant relevance ordering
      const idOrder = new Map(pageIds.map((id, i) => [id, i]));
      rows.sort((a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0));

      const items = rows.map((row) => {
        const node = rowToNode(row);
        return nodeToPayload(node);
      });

      return { items, total, kindCounts: semanticKindCounts };
    }
    // Fall through to SQL path
  }

  // ── Kind counts for SQL path ───────────────────────────────────────
  const kindCountConditions = [];
  if (fidelityFilter) kindCountConditions.push(fidelityFilter);
  if (searchParam) {
    kindCountConditions.push(
      like(memoryGraphNodes.content, `%${searchParam}%`),
    );
  }
  const kindCountWhere =
    kindCountConditions.length > 0 ? and(...kindCountConditions) : undefined;

  const sqlKindCountRows = db
    .select({ kind: memoryGraphNodes.type, count: count() })
    .from(memoryGraphNodes)
    .where(kindCountWhere)
    .groupBy(memoryGraphNodes.type)
    .all();
  const kindCounts: Record<string, number> = {};
  for (const row of sqlKindCountRows) {
    kindCounts[row.kind] = row.count;
  }

  // ── SQL path (default or fallback) ──────────────────────────────────
  const conditions = [];
  if (fidelityFilter) conditions.push(fidelityFilter);
  if (kindParam) conditions.push(eq(memoryGraphNodes.type, kindParam));
  if (searchParam) {
    conditions.push(like(memoryGraphNodes.content, `%${searchParam}%`));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Count query
  const countResult = db
    .select({ count: count() })
    .from(memoryGraphNodes)
    .where(whereClause)
    .get();
  const total = countResult?.count ?? 0;

  // Data query
  const sortColumn = SORT_COLUMN_MAP[sortParam];
  const orderFn = orderParam === "asc" ? asc : desc;

  const rows = db
    .select()
    .from(memoryGraphNodes)
    .where(whereClause)
    .orderBy(orderFn(sortColumn))
    .limit(limitParam)
    .offset(offsetParam)
    .all();

  const items = rows.map((row) => {
    const node = rowToNode(row);
    return nodeToPayload(node);
  });

  return { items, total, kindCounts };
}

function handleGetMemoryItem(id: string) {
  const node = getNode(id);
  if (!node) {
    throw new NotFoundError("Memory item not found");
  }
  return { item: nodeToPayload(node) };
}

async function handleCreateMemoryItem(body: Record<string, unknown>) {
  const { kind, subject, statement, importance } = body as {
    kind?: string;
    subject?: string;
    statement?: string;
    importance?: number;
  };

  if (typeof kind !== "string" || !isValidType(kind)) {
    throw new BadRequestError(
      `kind is required and must be one of: ${VALID_TYPES.join(", ")}`,
    );
  }

  if (typeof statement !== "string" || statement.trim().length === 0) {
    throw new BadRequestError(
      "statement is required and must be a non-empty string",
    );
  }

  const trimmedSubject = typeof subject === "string" ? subject.trim() : "";
  const trimmedStatement = statement.trim();
  const content = trimmedSubject
    ? `${trimmedSubject}\n${trimmedStatement}`
    : trimmedStatement;

  // Check for duplicate content
  const db = getDb();
  const existing = db
    .select({ id: memoryGraphNodes.id })
    .from(memoryGraphNodes)
    .where(
      and(
        eq(memoryGraphNodes.content, content),
        ne(memoryGraphNodes.fidelity, "gone"),
      ),
    )
    .get();

  if (existing) {
    throw new ConflictError("A memory with this content already exists");
  }

  const now = Date.now();
  const newNode: NewNode = {
    content,
    type: kind as MemoryType,
    created: now,
    lastAccessed: now,
    lastConsolidated: now,
    eventDate: null,
    emotionalCharge: {
      valence: 0,
      intensity: 0.1,
      decayCurve: "linear",
      decayRate: 0.05,
      originalIntensity: 0.1,
    },
    fidelity: "vivid",
    confidence: 0.95,
    significance: importance ?? 0.8,
    stability: 14,
    reinforcementCount: 0,
    lastReinforced: now,
    sourceConversations: [],
    sourceType: "direct",
    narrativeRole: null,
    partOfStory: null,
    imageRefs: null,
    scopeId: "default",
  };

  const created = createNode(newNode);
  enqueueMemoryJob("embed_graph_node", { nodeId: created.id });

  return { item: nodeToPayload(created) };
}

async function handleUpdateMemoryItem(
  id: string,
  body: Record<string, unknown>,
) {
  const existing = getNode(id);
  if (!existing) {
    throw new NotFoundError("Memory item not found");
  }

  const { subject, statement, kind, status, importance } = body as {
    subject?: string;
    statement?: string;
    kind?: string;
    status?: string;
    importance?: number;
  };

  const changes: Partial<Omit<MemoryNode, "id">> = {
    lastAccessed: Date.now(),
  };

  // Rebuild content if subject or statement changed
  const { subject: existingSubject, statement: existingStatement } =
    splitContent(existing.content);
  const newSubject =
    subject !== undefined ? subject.trim() : existingSubject;
  const newStatement =
    statement !== undefined ? statement.trim() : existingStatement;

  let contentChanged = false;
  if (subject !== undefined || statement !== undefined) {
    const newContent = newSubject
      ? `${newSubject}\n${newStatement}`
      : newStatement;
    if (newContent !== existing.content) {
      changes.content = newContent;
      contentChanged = true;
    }
  }

  if (kind !== undefined) {
    if (!isValidType(kind)) {
      throw new BadRequestError(
        `Invalid kind "${kind}". Must be one of: ${VALID_TYPES.join(", ")}`,
      );
    }
    changes.type = kind as MemoryType;
  }

  if (status !== undefined) {
    // Map client status to fidelity
    if (status === "superseded" || status === "inactive") {
      changes.fidelity = "gone";
    } else if (status === "active") {
      changes.fidelity = "vivid";
    }
  }

  if (importance !== undefined) {
    changes.significance = importance;
  }

  // Check for content collision when content changed OR when reactivating a
  // gone item (which could duplicate an existing active item's content).
  const reactivating =
    changes.fidelity === "vivid" && existing.fidelity === "gone";
  if (contentChanged || reactivating) {
    const contentToCheck = changes.content ?? existing.content;
    const db = getDb();
    const collision = db
      .select({ id: memoryGraphNodes.id })
      .from(memoryGraphNodes)
      .where(
        and(
          eq(memoryGraphNodes.content, contentToCheck),
          ne(memoryGraphNodes.id, id),
          ne(memoryGraphNodes.fidelity, "gone"),
        ),
      )
      .get();

    if (collision) {
      throw new ConflictError(
        "Another memory item with this content already exists",
      );
    }
  }

  updateNode(id, changes);

  if (contentChanged) {
    enqueueMemoryJob("embed_graph_node", { nodeId: id });
  }

  // Fetch updated node
  const updated = getNode(id);
  if (!updated) {
    throw new NotFoundError("Memory item not found after update");
  }

  return { item: nodeToPayload(updated) };
}

function handleDeleteMemoryItem(id: string) {
  const existing = getNode(id);
  if (!existing) {
    throw new NotFoundError("Memory item not found");
  }

  // Soft-delete the node (deleteNode sets fidelity='gone' and enqueues Qdrant cleanup)
  deleteNode(id);

  return null;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listMemoryItems",
    endpoint: "memory-items",
    method: "GET",
    policyKey: "memory-items",
    requirePolicyEnforcement: true,
    summary: "List memory items",
    description:
      "Return memory items with filtering, search, sorting, and pagination.",
    tags: ["memory"],
    queryParams: [
      {
        name: "kind",
        schema: { type: "string" },
        description: "Filter by kind",
      },
      {
        name: "status",
        schema: { type: "string" },
        description: "Filter by status (default active)",
      },
      {
        name: "search",
        schema: { type: "string" },
        description: "Full-text search query",
      },
      {
        name: "sort",
        schema: { type: "string" },
        description: "Sort field (default lastSeenAt)",
      },
      {
        name: "order",
        schema: { type: "string" },
        description: "asc or desc (default desc)",
      },
      {
        name: "limit",
        schema: { type: "integer" },
        description: "Max results (default 100)",
      },
      {
        name: "offset",
        schema: { type: "integer" },
        description: "Pagination offset",
      },
    ],
    responseBody: z.object({
      items: z.array(z.unknown()).describe("Memory item objects"),
      total: z.number(),
    }),
    handler: ({ queryParams }) =>
      handleListMemoryItems(queryParams ?? {}),
  },

  {
    operationId: "getMemoryItem",
    endpoint: "memory-items/:id",
    method: "GET",
    policyKey: "memory-items",
    requirePolicyEnforcement: true,
    summary: "Get a memory item",
    description: "Return a single memory item by ID with graph metadata.",
    tags: ["memory"],
    responseBody: z.object({
      item: z
        .object({})
        .passthrough()
        .describe("Memory item with scopeLabel and graph metadata"),
    }),
    handler: ({ pathParams }) => handleGetMemoryItem(pathParams!.id),
  },

  {
    operationId: "createMemoryItem",
    endpoint: "memory-items",
    method: "POST",
    policyKey: "memory-items",
    requirePolicyEnforcement: true,
    responseStatus: "201",
    summary: "Create a memory item",
    description: "Create a new memory graph node and enqueue embedding.",
    tags: ["memory"],
    requestBody: z.object({
      kind: z
        .string()
        .describe("Memory type (episodic, semantic, procedural, etc.)"),
      subject: z
        .string()
        .describe("Subject line (first line of content)")
        .optional(),
      statement: z.string().describe("Statement content"),
      importance: z
        .number()
        .describe("Importance score (default 0.8)")
        .optional(),
    }),
    additionalResponses: {
      409: {
        description: "A memory with this content already exists",
      },
    },
    responseBody: z.object({
      item: z.object({}).passthrough().describe("Created memory item"),
    }),
    handler: ({ body }) => handleCreateMemoryItem(body ?? {}),
  },

  {
    operationId: "updateMemoryItem",
    endpoint: "memory-items/:id",
    method: "PATCH",
    policyKey: "memory-items",
    requirePolicyEnforcement: true,
    summary: "Update a memory item",
    description: "Partially update fields on an existing memory graph node.",
    tags: ["memory"],
    requestBody: z.object({
      subject: z.string().optional(),
      statement: z.string().optional(),
      kind: z.string().optional(),
      status: z.string().optional(),
      importance: z.number().optional(),
    }),
    additionalResponses: {
      409: {
        description: "Another memory item with this content already exists",
      },
    },
    responseBody: z.object({
      item: z.object({}).passthrough().describe("Updated memory item"),
    }),
    handler: ({ pathParams, body }) =>
      handleUpdateMemoryItem(pathParams!.id, body ?? {}),
  },

  {
    operationId: "deleteMemoryItem",
    endpoint: "memory-items/:id",
    method: "DELETE",
    policyKey: "memory-items",
    requirePolicyEnforcement: true,
    responseStatus: "204",
    summary: "Delete a memory item",
    description: "Delete a memory graph node and its embeddings.",
    tags: ["memory"],
    handler: ({ pathParams }) => handleDeleteMemoryItem(pathParams!.id),
  },
];
