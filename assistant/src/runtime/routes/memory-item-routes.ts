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
import { truncate } from "../../util/truncate.js";
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

    // Build Qdrant filter — items only, exclude capability kind and sentinel
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
      must_not: [
        { key: "kind", match: { value: "capability" } },
        { key: "_meta", match: { value: true } },
      ],
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

    // Use SQL COUNT(*) for accurate pagination total — Qdrant results are
    // capped by fetchLimit and would undercount when more matches exist.
    const db = getDb();
    const countConditions = [ne(memoryItems.kind, "capability")];
    if (statusFilter && statusFilter !== "all") {
      countConditions.push(eq(memoryItems.status, statusFilter));
    }
    if (kindFilter) {
      countConditions.push(eq(memoryItems.kind, kindFilter));
    }
    const countResult = db
      .select({ count: count() })
      .from(memoryItems)
      .where(and(...countConditions))
      .get();
    const total = countResult?.count ?? 0;

    return { ids, total };
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
    const semanticResult = await searchItemsSemantic(
      searchParam,
      limitParam + offsetParam,
      kindParam,
      statusParam,
    );

    if (semanticResult && semanticResult.ids.length > 0) {
      // Slice for pagination
      const pageIds = semanticResult.ids.slice(
        offsetParam,
        offsetParam + limitParam,
      );

      if (pageIds.length === 0) {
        return Response.json({ items: [], total: semanticResult.total });
      }

      // Re-apply the same DB-side filters used in the SQL path as defense-
      // in-depth against stale Qdrant payloads leaking deleted/mismatched rows.
      const hydrationConditions = [
        inArray(memoryItems.id, pageIds),
        ne(memoryItems.kind, "capability"),
      ];
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
        total: semanticResult.total,
      });
    }
    // semanticResult was null (Qdrant unavailable) or empty — fall through to SQL
  }

  // ── SQL path (default or fallback) ──────────────────────────────────
  const conditions = [];
  // Hide system-managed capability memories (skill announcements) from the UI
  conditions.push(ne(memoryItems.kind, "capability"));
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

  return Response.json({ items: enrichedItems, total });
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

  const trimmedSubject = truncate(subject.trim(), 80, "");
  const trimmedStatement = truncate(statement.trim(), 500, "");

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
    set.subject = truncate(body.subject.trim(), 80, "");
  }
  if (body.statement !== undefined) {
    if (typeof body.statement !== "string") {
      return httpError("BAD_REQUEST", "statement must be a string", 400);
    }
    set.statement = truncate(body.statement.trim(), 500, "");
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
  if (body.verificationState !== undefined) {
    set.verificationState = body.verificationState;
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
      handler: (ctx) => handleListMemoryItems(ctx.url),
    },
    {
      endpoint: "memory-items/:id",
      method: "GET",
      policyKey: "memory-items",
      handler: (ctx) => handleGetMemoryItem(ctx),
    },
    {
      endpoint: "memory-items",
      method: "POST",
      handler: (ctx) => handleCreateMemoryItem(ctx),
    },
    {
      endpoint: "memory-items/:id",
      method: "PATCH",
      policyKey: "memory-items",
      handler: (ctx) => handleUpdateMemoryItem(ctx),
    },
    {
      endpoint: "memory-items/:id",
      method: "DELETE",
      policyKey: "memory-items",
      handler: (ctx) => handleDeleteMemoryItem(ctx),
    },
  ];
}
