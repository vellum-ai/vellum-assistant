/**
 * Route handlers for memory item CRUD endpoints.
 *
 * GET    /v1/memory-items        — list memory items (with filtering, search, sort, pagination)
 * GET    /v1/memory-items/:id    — get a single memory item
 * POST   /v1/memory-items        — create a new memory item
 * PATCH  /v1/memory-items/:id    — update an existing memory item
 * DELETE /v1/memory-items/:id    — delete a memory item and its embeddings
 */

import { and, asc, count, desc, eq, inArray, like, ne, or } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import { getDb } from "../../memory/db.js";
import {
  embedWithBackend,
  generateSparseEmbedding,
  getMemoryBackendStatus,
} from "../../memory/embedding-backend.js";
import { computeMemoryFingerprint } from "../../memory/fingerprint.js";
import { enqueueMemoryJob } from "../../memory/jobs-store.js";
import { withQdrantBreaker } from "../../memory/qdrant-circuit-breaker.js";
import { getQdrantClient } from "../../memory/qdrant-client.js";
import {
  conversations,
  memoryEmbeddings,
  memoryItems,
} from "../../memory/schema.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteContext, RouteDefinition } from "../http-router.js";

const log = getLogger("memory-item-routes");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_KINDS = [
  "identity",
  "preference",
  "project",
  "decision",
  "constraint",
  "event",
  "capability",
  "journal",
] as const;

type MemoryItemKind = (typeof VALID_KINDS)[number];

const VALID_SORT_FIELDS = [
  "lastSeenAt",
  "importance",
  "accessCount",
  "kind",
  "firstSeenAt",
] as const;

type SortField = (typeof VALID_SORT_FIELDS)[number];

const SORT_COLUMN_MAP = {
  lastSeenAt: memoryItems.lastSeenAt,
  importance: memoryItems.importance,
  accessCount: memoryItems.accessCount,
  kind: memoryItems.kind,
  firstSeenAt: memoryItems.firstSeenAt,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidKind(value: string): value is MemoryItemKind {
  return (VALID_KINDS as readonly string[]).includes(value);
}

function isValidSortField(value: string): value is SortField {
  return (VALID_SORT_FIELDS as readonly string[]).includes(value);
}

/**
 * Resolve a `scopeLabel` for a memory item based on its `scopeId`.
 *
 * - `"default"` → `null`
 * - `"private:<conversationId>"` → `"Private · <title>"` when the conversation
 *   has a title, or `"Private"` when it doesn't (or the conversation was deleted).
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
 * Returns a Map from conversation ID → title (or null).
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
// Semantic search helper
// ---------------------------------------------------------------------------

/**
 * Attempt hybrid semantic search for memory items via Qdrant.
 * Returns ordered item IDs + total count on success, or `null` when
 * the embedding backend / Qdrant is unavailable (caller falls back to SQL).
 */
async function searchItemsSemantic(
  query: string,
  fetchLimit: number,
  kindFilter: string | null,
  statusFilter: string,
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

    // Build Qdrant filter — items only, exclude sentinel
    const mustConditions: Array<Record<string, unknown>> = [
      { key: "target_type", match: { value: "item" } },
    ];
    if (statusFilter && statusFilter !== "all") {
      mustConditions.push({ key: "status", match: { value: statusFilter } });
    }
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

    // Use the vector search result count as the pagination total.
    // A DB-wide COUNT would include items with no embedding yet (lagging) and
    // items irrelevant to the search query, inflating the total and causing
    // clients to paginate into empty pages.
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

  if (kindParam && !isValidKind(kindParam)) {
    return httpError(
      "BAD_REQUEST",
      `Invalid kind "${kindParam}". Must be one of: ${VALID_KINDS.join(", ")}`,
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

  // ── Semantic search path ────────────────────────────────────────────
  // When a search query is present, try Qdrant hybrid search first.
  // Falls back to SQL LIKE when embeddings / Qdrant are unavailable.
  if (searchParam) {
    // Search WITHOUT kind filter so we can compute cross-kind counts.
    // Kind filtering is applied post-hoc while preserving relevance order.
    const semanticResult = await searchItemsSemantic(
      searchParam,
      10_000,
      null,
      statusParam,
    );

    if (semanticResult && semanticResult.ids.length > 0) {
      // Compute kindCounts from all semantic matches (no kind filter)
      const kindCountRows = db
        .select({ kind: memoryItems.kind, count: count() })
        .from(memoryItems)
        .where(inArray(memoryItems.id, semanticResult.ids))
        .groupBy(memoryItems.kind)
        .all();
      const semanticKindCounts: Record<string, number> = {};
      for (const row of kindCountRows) {
        semanticKindCounts[row.kind] = row.count;
      }

      // Apply kind filter while preserving semantic relevance ordering
      let filteredIds = semanticResult.ids;
      if (kindParam) {
        const kindIdSet = new Set(
          db
            .select({ id: memoryItems.id })
            .from(memoryItems)
            .where(
              and(
                inArray(memoryItems.id, semanticResult.ids),
                eq(memoryItems.kind, kindParam),
              ),
            )
            .all()
            .map((r) => r.id),
        );
        filteredIds = semanticResult.ids.filter((id) => kindIdSet.has(id));
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

      // Re-apply DB-side filters as defense-in-depth against stale Qdrant
      // payloads leaking deleted/mismatched rows.
      const hydrationConditions = [inArray(memoryItems.id, pageIds)];
      if (statusParam && statusParam !== "all") {
        hydrationConditions.push(eq(memoryItems.status, statusParam));
      }
      if (kindParam) {
        hydrationConditions.push(eq(memoryItems.kind, kindParam));
      }

      const rows = db
        .select()
        .from(memoryItems)
        .where(and(...hydrationConditions))
        .all();

      // Preserve Qdrant relevance ordering
      const idOrder = new Map(pageIds.map((id, i) => [id, i]));
      rows.sort((a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0));

      const titleMap = buildConversationTitleMap(
        db,
        rows.map((i) => i.scopeId),
      );
      const enrichedItems = rows.map((item) => ({
        ...item,
        scopeLabel: resolveScopeLabel(item.scopeId, titleMap),
      }));

      return Response.json({
        items: enrichedItems,
        total,
        kindCounts: semanticKindCounts,
      });
    }
    // semanticResult was null (Qdrant unavailable) or empty — fall through to SQL
  }

  // ── Kind counts for SQL path ───────────────────────────────────────
  // Respects status/search filters but NOT kind filter, so the sidebar
  // can show totals for every kind simultaneously.
  const kindCountConditions = [];
  if (statusParam && statusParam !== "all") {
    kindCountConditions.push(eq(memoryItems.status, statusParam));
  }
  if (searchParam) {
    kindCountConditions.push(
      or(
        like(memoryItems.subject, `%${searchParam}%`),
        like(memoryItems.statement, `%${searchParam}%`),
      )!,
    );
  }
  const kindCountWhere =
    kindCountConditions.length > 0 ? and(...kindCountConditions) : undefined;
  const sqlKindCountRows = db
    .select({ kind: memoryItems.kind, count: count() })
    .from(memoryItems)
    .where(kindCountWhere)
    .groupBy(memoryItems.kind)
    .all();
  const kindCounts: Record<string, number> = {};
  for (const row of sqlKindCountRows) {
    kindCounts[row.kind] = row.count;
  }

  // ── SQL path (default or fallback) ──────────────────────────────────
  const conditions = [];
  if (statusParam && statusParam !== "all") {
    conditions.push(eq(memoryItems.status, statusParam));
  }
  if (kindParam) {
    conditions.push(eq(memoryItems.kind, kindParam));
  }
  if (searchParam) {
    conditions.push(
      or(
        like(memoryItems.subject, `%${searchParam}%`),
        like(memoryItems.statement, `%${searchParam}%`),
      )!,
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Count query
  const countResult = db
    .select({ count: count() })
    .from(memoryItems)
    .where(whereClause)
    .get();
  const total = countResult?.count ?? 0;

  // Data query
  const sortColumn = SORT_COLUMN_MAP[sortParam];
  const orderFn = orderParam === "asc" ? asc : desc;

  const items = db
    .select()
    .from(memoryItems)
    .where(whereClause)
    .orderBy(orderFn(sortColumn))
    .limit(limitParam)
    .offset(offsetParam)
    .all();

  // Resolve scope labels for private-scoped items
  const titleMap = buildConversationTitleMap(
    db,
    items.map((i) => i.scopeId),
  );
  const enrichedItems = items.map((item) => ({
    ...item,
    scopeLabel: resolveScopeLabel(item.scopeId, titleMap),
  }));

  return Response.json({ items: enrichedItems, total, kindCounts });
}

// ---------------------------------------------------------------------------
// GET /v1/memory-items/:id
// ---------------------------------------------------------------------------

export function handleGetMemoryItem(ctx: RouteContext): Response {
  const { id } = ctx.params;
  const db = getDb();

  const item = db
    .select()
    .from(memoryItems)
    .where(eq(memoryItems.id, id))
    .get();

  if (!item) {
    return httpError("NOT_FOUND", "Memory item not found", 404);
  }

  let supersedesSubject: string | undefined;
  let supersededBySubject: string | undefined;

  if (item.supersedes) {
    const superseded = db
      .select({ subject: memoryItems.subject })
      .from(memoryItems)
      .where(eq(memoryItems.id, item.supersedes))
      .get();
    supersedesSubject = superseded?.subject;
  }

  if (item.supersededBy) {
    const superseding = db
      .select({ subject: memoryItems.subject })
      .from(memoryItems)
      .where(eq(memoryItems.id, item.supersededBy))
      .get();
    supersededBySubject = superseding?.subject;
  }

  // Resolve scope label
  const titleMap = buildConversationTitleMap(db, [item.scopeId]);
  const scopeLabel = resolveScopeLabel(item.scopeId, titleMap);

  return Response.json({
    item: {
      ...item,
      scopeLabel,
      ...(supersedesSubject !== undefined ? { supersedesSubject } : {}),
      ...(supersededBySubject !== undefined ? { supersededBySubject } : {}),
    },
  });
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

  // Validate kind
  if (typeof kind !== "string" || !isValidKind(kind)) {
    return httpError(
      "BAD_REQUEST",
      `kind is required and must be one of: ${VALID_KINDS.join(", ")}`,
      400,
    );
  }

  // Validate subject
  if (typeof subject !== "string" || subject.trim().length === 0) {
    return httpError(
      "BAD_REQUEST",
      "subject is required and must be a non-empty string",
      400,
    );
  }

  // Validate statement
  if (typeof statement !== "string" || statement.trim().length === 0) {
    return httpError(
      "BAD_REQUEST",
      "statement is required and must be a non-empty string",
      400,
    );
  }

  const trimmedSubject = subject.trim();
  const trimmedStatement = statement.trim();

  const scopeId = "default";
  const fingerprint = computeMemoryFingerprint(
    scopeId,
    kind,
    trimmedSubject,
    trimmedStatement,
  );

  const db = getDb();

  // Check for existing item with same fingerprint + scopeId
  const existing = db
    .select()
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.fingerprint, fingerprint),
        eq(memoryItems.scopeId, scopeId),
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

  const id = uuid();
  const now = Date.now();

  db.insert(memoryItems)
    .values({
      id,
      kind,
      subject: trimmedSubject,
      statement: trimmedStatement,
      status: "active",
      confidence: 0.95,
      importance: importance ?? 0.8,
      fingerprint,
      sourceType: "tool",
      verificationState: "user_confirmed",
      scopeId,
      firstSeenAt: now,
      lastSeenAt: now,
      lastUsedAt: null,
      overrideConfidence: "explicit",
    })
    .run();

  enqueueMemoryJob("embed_item", { itemId: id });

  // Fetch the inserted row to return it
  const insertedRow = db
    .select()
    .from(memoryItems)
    .where(eq(memoryItems.id, id))
    .get();

  // Enrich with scopeLabel for API consistency
  const titleMap = buildConversationTitleMap(db, [scopeId]);
  const scopeLabel = resolveScopeLabel(scopeId, titleMap);

  return Response.json(
    { item: { ...insertedRow, scopeLabel } },
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
  const body = (await ctx.req.json()) as {
    subject?: string;
    statement?: string;
    kind?: string;
    status?: string;
    importance?: number;
    sourceType?: string;
    verificationState?: string;
  };

  const db = getDb();

  const existing = db
    .select()
    .from(memoryItems)
    .where(eq(memoryItems.id, id))
    .get();

  if (!existing) {
    return httpError("NOT_FOUND", "Memory item not found", 404);
  }

  // Build the update set with only provided fields
  const set: Record<string, unknown> = {
    lastSeenAt: Date.now(),
  };

  if (body.subject !== undefined) {
    if (typeof body.subject !== "string") {
      return httpError("BAD_REQUEST", "subject must be a string", 400);
    }
    set.subject = body.subject.trim();
  }
  if (body.statement !== undefined) {
    if (typeof body.statement !== "string") {
      return httpError("BAD_REQUEST", "statement must be a string", 400);
    }
    set.statement = body.statement.trim();
  }
  if (body.kind !== undefined) {
    if (!isValidKind(body.kind)) {
      return httpError(
        "BAD_REQUEST",
        `Invalid kind "${body.kind}". Must be one of: ${VALID_KINDS.join(", ")}`,
        400,
      );
    }
    set.kind = body.kind;
  }
  if (body.status !== undefined) {
    set.status = body.status;
  }
  if (body.importance !== undefined) {
    set.importance = body.importance;
  }
  if (body.sourceType !== undefined) {
    set.sourceType = body.sourceType;
  }

  // Accept verificationState from clients that haven't migrated to sourceType yet.
  // Map verificationState → sourceType for forward compat, and write both fields.
  if (body.verificationState !== undefined) {
    set.verificationState = body.verificationState;
    // Map verificationState to sourceType if sourceType wasn't explicitly provided
    if (body.sourceType === undefined) {
      set.sourceType =
        body.verificationState === "user_confirmed" ? "tool" : "extraction";
    }
  }
  // If sourceType was set (either directly or via mapping), also write verificationState
  if (body.sourceType !== undefined && body.verificationState === undefined) {
    set.verificationState =
      body.sourceType === "tool"
        ? "user_confirmed"
        : existing.verificationState === "user_reported"
          ? "user_reported"
          : "assistant_inferred";
  }

  // If subject, statement, or kind changed, recompute fingerprint
  const contentChanged =
    body.subject !== undefined ||
    body.statement !== undefined ||
    body.kind !== undefined;

  if (contentChanged) {
    const newSubject = (set.subject as string | undefined) ?? existing.subject;
    const newStatement =
      (set.statement as string | undefined) ?? existing.statement;
    const newKind = (set.kind as string | undefined) ?? existing.kind;
    const scopeId = existing.scopeId;

    const fingerprint = computeMemoryFingerprint(
      scopeId,
      newKind,
      newSubject,
      newStatement,
    );

    // Check for collision (exclude self)
    const collision = db
      .select({ id: memoryItems.id })
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.fingerprint, fingerprint),
          eq(memoryItems.scopeId, scopeId),
          ne(memoryItems.id, id),
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

    set.fingerprint = fingerprint;
  }

  db.update(memoryItems).set(set).where(eq(memoryItems.id, id)).run();

  // If statement changed, enqueue embed job
  if (body.statement !== undefined) {
    enqueueMemoryJob("embed_item", { itemId: id });
  }

  // Fetch and return the updated row
  const updatedRow = db
    .select()
    .from(memoryItems)
    .where(eq(memoryItems.id, id))
    .get();

  // Enrich with scopeLabel for API consistency
  const patchTitleMap = buildConversationTitleMap(db, [
    updatedRow?.scopeId ?? existing.scopeId,
  ]);
  const patchScopeLabel = resolveScopeLabel(
    updatedRow?.scopeId ?? existing.scopeId,
    patchTitleMap,
  );

  return Response.json({
    item: { ...updatedRow, scopeLabel: patchScopeLabel },
  });
}

// ---------------------------------------------------------------------------
// DELETE /v1/memory-items/:id
// ---------------------------------------------------------------------------

export async function handleDeleteMemoryItem(
  ctx: RouteContext,
): Promise<Response> {
  const { id } = ctx.params;
  const db = getDb();

  const existing = db
    .select()
    .from(memoryItems)
    .where(eq(memoryItems.id, id))
    .get();

  if (!existing) {
    return httpError("NOT_FOUND", "Memory item not found", 404);
  }

  // Delete embeddings for this item
  db.delete(memoryEmbeddings)
    .where(
      and(
        eq(memoryEmbeddings.targetType, "item"),
        eq(memoryEmbeddings.targetId, id),
      ),
    )
    .run();

  // Delete the item (cascades memoryItemSources)
  db.delete(memoryItems).where(eq(memoryItems.id, id)).run();

  return new Response(null, { status: 204 });
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
      description:
        "Return a single memory item by ID with supersession metadata.",
      tags: ["memory"],
      responseBody: z.object({
        item: z
          .object({})
          .passthrough()
          .describe("Memory item with scopeLabel and supersession info"),
      }),
      handler: (ctx) => handleGetMemoryItem(ctx),
    },
    {
      endpoint: "memory-items",
      method: "POST",
      summary: "Create a memory item",
      description: "Create a new memory item and enqueue embedding.",
      tags: ["memory"],
      requestBody: z.object({
        kind: z
          .string()
          .describe("Memory kind (identity, preference, project, etc.)"),
        subject: z.string().describe("Subject line"),
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
      description: "Partially update fields on an existing memory item.",
      tags: ["memory"],
      requestBody: z.object({
        subject: z.string(),
        statement: z.string(),
        kind: z.string(),
        status: z.string(),
        importance: z.number(),
        sourceType: z.string(),
        verificationState: z.string(),
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
      description: "Delete a memory item and its embeddings.",
      tags: ["memory"],
      responseBody: z.object({
        ok: z.boolean(),
      }),
      handler: (ctx) => handleDeleteMemoryItem(ctx),
    },
  ];
}
