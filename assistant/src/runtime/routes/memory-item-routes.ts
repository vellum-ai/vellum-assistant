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
import { getDb } from "../../memory/db.js";
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
import { conversations, memoryGraphNodes } from "../../memory/schema.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteContext, RouteDefinition } from "../http-router.js";

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

/**
 * Resolve a `scopeLabel` for a memory item based on its `scopeId`.
 */
function resolveScopeLabel(
  scopeId: string,
  titleMap: Map<string, string | null>,
): string | null {
  if (scopeId === "default") return null;
  if (scopeId.startsWith("private:")) {
    const conversationId = scopeId.slice("private:".length);
    const title = titleMap.get(conversationId);
    return title ? `Private · ${title}` : "Private";
  }
  return null;
}

/**
 * Batch-fetch conversation titles for a set of private-scoped memory items.
 */
function buildConversationTitleMap(
  db: ReturnType<typeof getDb>,
  scopeIds: string[],
): Map<string, string | null> {
  const conversationIds = scopeIds
    .filter((s) => s.startsWith("private:"))
    .map((s) => s.slice("private:".length));

  const uniqueIds = [...new Set(conversationIds)];
  if (uniqueIds.length === 0) return new Map();

  const rows = db
    .select({ id: conversations.id, title: conversations.title })
    .from(conversations)
    .where(inArray(conversations.id, uniqueIds))
    .all();

  const map = new Map<string, string | null>();
  for (const row of rows) {
    map.set(row.id, row.title);
  }
  return map;
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
// GET /v1/memory-items
// ---------------------------------------------------------------------------

export async function handleListMemoryItems(url: URL): Promise<Response> {
  const kindParam = url.searchParams.get("kind");
  const statusParam = url.searchParams.get("status") ?? "active";
  const searchParam = url.searchParams.get("search");
  const sortParam = url.searchParams.get("sort") ?? "lastSeenAt";
  const orderParam = url.searchParams.get("order") ?? "desc";
  const limitParam = Number(url.searchParams.get("limit") ?? 100);
  const offsetParam = Number(url.searchParams.get("offset") ?? 0);

  if (kindParam && !isValidType(kindParam)) {
    return httpError(
      "BAD_REQUEST",
      `Invalid kind "${kindParam}". Must be one of: ${VALID_TYPES.join(", ")}`,
      400,
    );
  }

  if (!isValidSortField(sortParam)) {
    return httpError(
      "BAD_REQUEST",
      `Invalid sort "${sortParam}". Must be one of: ${VALID_SORT_FIELDS.join(", ")}`,
      400,
    );
  }

  if (orderParam !== "asc" && orderParam !== "desc") {
    return httpError(
      "BAD_REQUEST",
      `Invalid order "${orderParam}". Must be "asc" or "desc"`,
      400,
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
        return Response.json({
          items: [],
          total,
          kindCounts: semanticKindCounts,
        });
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

      const titleMap = buildConversationTitleMap(
        db,
        rows.map((r) => r.scopeId),
      );
      const items = rows.map((row) => {
        const node = rowToNode(row);
        return nodeToPayload(node, resolveScopeLabel(node.scopeId, titleMap));
      });

      return Response.json({ items, total, kindCounts: semanticKindCounts });
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

  const titleMap = buildConversationTitleMap(
    db,
    rows.map((r) => r.scopeId),
  );
  const items = rows.map((row) => {
    const node = rowToNode(row);
    return nodeToPayload(node, resolveScopeLabel(node.scopeId, titleMap));
  });

  return Response.json({ items, total, kindCounts });
}

// ---------------------------------------------------------------------------
// GET /v1/memory-items/:id
// ---------------------------------------------------------------------------

export function handleGetMemoryItem(ctx: RouteContext): Response {
  const { id } = ctx.params;

  const node = getNode(id);
  if (!node) {
    return httpError("NOT_FOUND", "Memory item not found", 404);
  }

  const db = getDb();
  const titleMap = buildConversationTitleMap(db, [node.scopeId]);
  const scopeLabel = resolveScopeLabel(node.scopeId, titleMap);

  return Response.json({ item: nodeToPayload(node, scopeLabel) });
}

// ---------------------------------------------------------------------------
// POST /v1/memory-items
// ---------------------------------------------------------------------------

export async function handleCreateMemoryItem(
  ctx: RouteContext,
): Promise<Response> {
  const body = (await ctx.req.json()) as {
    kind?: string;
    subject?: string;
    statement?: string;
    importance?: number;
  };

  const { kind, subject, statement, importance } = body;

  if (typeof kind !== "string" || !isValidType(kind)) {
    return httpError(
      "BAD_REQUEST",
      `kind is required and must be one of: ${VALID_TYPES.join(", ")}`,
      400,
    );
  }

  if (typeof statement !== "string" || statement.trim().length === 0) {
    return httpError(
      "BAD_REQUEST",
      "statement is required and must be a non-empty string",
      400,
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
    return httpError(
      "CONFLICT",
      "A memory with this content already exists",
      409,
    );
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

  const titleMap = buildConversationTitleMap(db, [created.scopeId]);
  const scopeLabel = resolveScopeLabel(created.scopeId, titleMap);

  return Response.json(
    { item: nodeToPayload(created, scopeLabel) },
    { status: 201 },
  );
}

// ---------------------------------------------------------------------------
// PATCH /v1/memory-items/:id
// ---------------------------------------------------------------------------

export async function handleUpdateMemoryItem(
  ctx: RouteContext,
): Promise<Response> {
  const { id } = ctx.params;

  const existing = getNode(id);
  if (!existing) {
    return httpError("NOT_FOUND", "Memory item not found", 404);
  }

  const body = (await ctx.req.json()) as {
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
    body.subject !== undefined ? body.subject.trim() : existingSubject;
  const newStatement =
    body.statement !== undefined ? body.statement.trim() : existingStatement;

  let contentChanged = false;
  if (body.subject !== undefined || body.statement !== undefined) {
    const newContent = newSubject
      ? `${newSubject}\n${newStatement}`
      : newStatement;
    if (newContent !== existing.content) {
      changes.content = newContent;
      contentChanged = true;
    }
  }

  if (body.kind !== undefined) {
    if (!isValidType(body.kind)) {
      return httpError(
        "BAD_REQUEST",
        `Invalid kind "${body.kind}". Must be one of: ${VALID_TYPES.join(", ")}`,
        400,
      );
    }
    changes.type = body.kind as MemoryType;
  }

  if (body.status !== undefined) {
    // Map client status to fidelity
    if (body.status === "superseded" || body.status === "inactive") {
      changes.fidelity = "gone";
    } else if (body.status === "active") {
      changes.fidelity = "vivid";
    }
  }

  if (body.importance !== undefined) {
    changes.significance = body.importance;
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
      return httpError(
        "CONFLICT",
        "Another memory item with this content already exists",
        409,
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
    return httpError("NOT_FOUND", "Memory item not found after update", 404);
  }

  const db = getDb();
  const titleMap = buildConversationTitleMap(db, [updated.scopeId]);
  const scopeLabel = resolveScopeLabel(updated.scopeId, titleMap);

  return Response.json({ item: nodeToPayload(updated, scopeLabel) });
}

// ---------------------------------------------------------------------------
// DELETE /v1/memory-items/:id
// ---------------------------------------------------------------------------

export async function handleDeleteMemoryItem(
  ctx: RouteContext,
): Promise<Response> {
  const { id } = ctx.params;

  const existing = getNode(id);
  if (!existing) {
    return httpError("NOT_FOUND", "Memory item not found", 404);
  }

  // Soft-delete the node (deleteNode sets fidelity='gone' and enqueues Qdrant cleanup)
  deleteNode(id);

  return new Response(null, { status: 204 });
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
    narrativeRole: row.narrativeRole,
    partOfStory: row.partOfStory,
    imageRefs: row.imageRefs ? (JSON.parse(row.imageRefs) as ImageRef[]) : null,
    scopeId: row.scopeId,
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function memoryItemRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "memory-items",
      method: "GET",
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
      handler: (ctx) => handleListMemoryItems(ctx.url),
    },
    {
      endpoint: "memory-items/:id",
      method: "GET",
      policyKey: "memory-items",
      summary: "Get a memory item",
      description: "Return a single memory item by ID with graph metadata.",
      tags: ["memory"],
      responseBody: z.object({
        item: z
          .object({})
          .passthrough()
          .describe("Memory item with scopeLabel and graph metadata"),
      }),
      handler: (ctx) => handleGetMemoryItem(ctx),
    },
    {
      endpoint: "memory-items",
      method: "POST",
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
      responseBody: z.object({
        item: z.object({}).passthrough().describe("Created memory item"),
      }),
      handler: (ctx) => handleCreateMemoryItem(ctx),
    },
    {
      endpoint: "memory-items/:id",
      method: "PATCH",
      policyKey: "memory-items",
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
      responseBody: z.object({
        item: z.object({}).passthrough().describe("Updated memory item"),
      }),
      handler: (ctx) => handleUpdateMemoryItem(ctx),
    },
    {
      endpoint: "memory-items/:id",
      method: "DELETE",
      policyKey: "memory-items",
      summary: "Delete a memory item",
      description: "Delete a memory graph node and its embeddings.",
      tags: ["memory"],
      responseBody: z.object({
        ok: z.boolean(),
      }),
      handler: (ctx) => handleDeleteMemoryItem(ctx),
    },
  ];
}
