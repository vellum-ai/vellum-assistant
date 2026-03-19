/**
 * Route handlers for memory item CRUD endpoints.
 *
 * GET    /v1/memory-items        — list memory items (with filtering, search, sort, pagination)
 * GET    /v1/memory-items/:id    — get a single memory item
 * POST   /v1/memory-items        — create a new memory item
 * PATCH  /v1/memory-items/:id    — update an existing memory item
 * DELETE /v1/memory-items/:id    — delete a memory item and its embeddings
 */

import { and, asc, count, desc, eq, like, ne, or } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "../../memory/db.js";
import { computeMemoryFingerprint } from "../../memory/fingerprint.js";
import { enqueueMemoryJob } from "../../memory/jobs-store.js";
import { memoryEmbeddings, memoryItems } from "../../memory/schema.js";
import { truncate } from "../../util/truncate.js";
import { httpError } from "../http-errors.js";
import type { RouteContext, RouteDefinition } from "../http-router.js";

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

// ---------------------------------------------------------------------------
// GET /v1/memory-items
// ---------------------------------------------------------------------------

export function handleListMemoryItems(url: URL): Response {
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

  // Build WHERE conditions
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

  return Response.json({ items, total });
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

  return Response.json({
    item: {
      ...item,
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

  return Response.json({ item: insertedRow }, { status: 201 });
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

  return Response.json({ item: updatedRow });
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
