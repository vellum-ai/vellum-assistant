/**
 * Route handlers for simplified memory endpoints.
 *
 * GET    /v1/memories      — list observations, episodes, time contexts, and open loops
 * POST   /v1/memories      — create a new observation (manual memory)
 * DELETE /v1/memories/:id  — delete an observation and its associated chunks/embeddings
 */

import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  like,
  ne,
  or,
} from "drizzle-orm";
import { v4 as uuid } from "uuid";

import {
  insertObservation,
  type InsertObservationParams,
} from "../../memory/archive-store.js";
import { getLatestConversation } from "../../memory/conversation-queries.js";
import { getDb } from "../../memory/db.js";
import {
  conversations,
  memoryChunks,
  memoryEmbeddings,
  memoryEpisodes,
  memoryObservations,
  openLoops,
  timeContexts,
} from "../../memory/schema.js";
import { httpError } from "../http-errors.js";
import type { RouteContext, RouteDefinition } from "../http-router.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_SECTIONS = [
  "observations",
  "episodes",
  "time_contexts",
  "open_loops",
] as const;

type Section = (typeof VALID_SECTIONS)[number];

const VALID_SORT_FIELDS = ["createdAt", "role"] as const;

type SortField = (typeof VALID_SORT_FIELDS)[number];

function isValidSection(value: string): value is Section {
  return (VALID_SECTIONS as readonly string[]).includes(value);
}

function isValidSortField(value: string): value is SortField {
  return (VALID_SORT_FIELDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// GET /v1/memories
// ---------------------------------------------------------------------------

export function handleListMemories(url: URL): Response {
  const searchParam = url.searchParams.get("search");
  const sortParam = url.searchParams.get("sort") ?? "createdAt";
  const orderParam = url.searchParams.get("order") ?? "desc";
  const limitParam = Number(url.searchParams.get("limit") ?? 100);
  const offsetParam = Number(url.searchParams.get("offset") ?? 0);
  const sectionParam = url.searchParams.get("section");

  if (sectionParam && !isValidSection(sectionParam)) {
    return httpError(
      "BAD_REQUEST",
      `Invalid section "${sectionParam}". Must be one of: ${VALID_SECTIONS.join(", ")}`,
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
  const orderFn = orderParam === "asc" ? asc : desc;
  const now = Date.now();

  const sections = sectionParam ? [sectionParam] : [...VALID_SECTIONS];

  const result: Record<string, unknown> = {};

  // -- Observations --
  if (sections.includes("observations")) {
    const conditions = [];
    if (searchParam) {
      conditions.push(like(memoryObservations.content, `%${searchParam}%`));
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const sortColumn =
      sortParam === "role"
        ? memoryObservations.role
        : memoryObservations.createdAt;

    const countResult = db
      .select({ count: count() })
      .from(memoryObservations)
      .where(whereClause)
      .get();
    const total = countResult?.count ?? 0;

    const rows = db
      .select({
        id: memoryObservations.id,
        scopeId: memoryObservations.scopeId,
        conversationId: memoryObservations.conversationId,
        role: memoryObservations.role,
        content: memoryObservations.content,
        modality: memoryObservations.modality,
        source: memoryObservations.source,
        createdAt: memoryObservations.createdAt,
        conversationTitle: conversations.title,
      })
      .from(memoryObservations)
      .leftJoin(
        conversations,
        eq(memoryObservations.conversationId, conversations.id),
      )
      .where(whereClause)
      .orderBy(orderFn(sortColumn))
      .limit(limitParam)
      .offset(offsetParam)
      .all();

    result.observations = { items: rows, total };
  }

  // -- Episodes --
  if (sections.includes("episodes")) {
    const conditions = [];
    if (searchParam) {
      conditions.push(
        or(
          like(memoryEpisodes.title, `%${searchParam}%`),
          like(memoryEpisodes.summary, `%${searchParam}%`),
        )!,
      );
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const countResult = db
      .select({ count: count() })
      .from(memoryEpisodes)
      .where(whereClause)
      .get();
    const total = countResult?.count ?? 0;

    const rows = db
      .select({
        id: memoryEpisodes.id,
        scopeId: memoryEpisodes.scopeId,
        conversationId: memoryEpisodes.conversationId,
        title: memoryEpisodes.title,
        summary: memoryEpisodes.summary,
        source: memoryEpisodes.source,
        startAt: memoryEpisodes.startAt,
        endAt: memoryEpisodes.endAt,
        createdAt: memoryEpisodes.createdAt,
        conversationTitle: conversations.title,
      })
      .from(memoryEpisodes)
      .leftJoin(
        conversations,
        eq(memoryEpisodes.conversationId, conversations.id),
      )
      .where(whereClause)
      .orderBy(orderFn(memoryEpisodes.createdAt))
      .limit(limitParam)
      .offset(offsetParam)
      .all();

    result.episodes = { items: rows, total };
  }

  // -- Time Contexts (active only) --
  if (sections.includes("time_contexts")) {
    const conditions = [gt(timeContexts.activeUntil, now)];
    if (searchParam) {
      conditions.push(like(timeContexts.summary, `%${searchParam}%`));
    }
    const whereClause = and(...conditions);

    const countResult = db
      .select({ count: count() })
      .from(timeContexts)
      .where(whereClause)
      .get();
    const total = countResult?.count ?? 0;

    const rows = db
      .select({
        id: timeContexts.id,
        summary: timeContexts.summary,
        source: timeContexts.source,
        activeFrom: timeContexts.activeFrom,
        activeUntil: timeContexts.activeUntil,
        createdAt: timeContexts.createdAt,
      })
      .from(timeContexts)
      .where(whereClause)
      .orderBy(orderFn(timeContexts.createdAt))
      .all();

    result.timeContexts = { items: rows, total };
  }

  // -- Open Loops (non-expired) --
  if (sections.includes("open_loops")) {
    const conditions = [ne(openLoops.status, "expired")];
    if (searchParam) {
      conditions.push(like(openLoops.summary, `%${searchParam}%`));
    }
    const whereClause = and(...conditions);

    const countResult = db
      .select({ count: count() })
      .from(openLoops)
      .where(whereClause)
      .get();
    const total = countResult?.count ?? 0;

    const rows = db
      .select({
        id: openLoops.id,
        summary: openLoops.summary,
        status: openLoops.status,
        source: openLoops.source,
        dueAt: openLoops.dueAt,
        createdAt: openLoops.createdAt,
      })
      .from(openLoops)
      .where(whereClause)
      .orderBy(orderFn(openLoops.createdAt))
      .all();

    result.openLoops = { items: rows, total };
  }

  return Response.json(result);
}

// ---------------------------------------------------------------------------
// POST /v1/memories
// ---------------------------------------------------------------------------

export async function handleCreateMemory(
  ctx: RouteContext,
): Promise<Response> {
  const body = (await ctx.req.json()) as {
    content?: string;
    role?: string;
  };

  const { content, role } = body;

  if (typeof content !== "string" || content.trim().length === 0) {
    return httpError(
      "BAD_REQUEST",
      "content is required and must be a non-empty string",
      400,
    );
  }

  // Use the most recent conversation as the parent, or create a synthetic ID
  const latestConversation = getLatestConversation();
  const conversationId = latestConversation?.id ?? `manual-${uuid()}`;

  // If there's no real conversation, we need to insert a placeholder row
  // so the FK constraint on memory_observations.conversation_id is satisfied.
  if (!latestConversation) {
    const db = getDb();
    const now = Date.now();
    db.insert(conversations)
      .values({
        id: conversationId,
        title: "Manual Memories",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  const params: InsertObservationParams = {
    conversationId,
    role: role ?? "user",
    content: content.trim(),
    source: "manual",
  };

  const inserted = insertObservation(params);

  // Fetch the observation back to return it
  const db = getDb();
  const observation = db
    .select({
      id: memoryObservations.id,
      scopeId: memoryObservations.scopeId,
      conversationId: memoryObservations.conversationId,
      role: memoryObservations.role,
      content: memoryObservations.content,
      modality: memoryObservations.modality,
      source: memoryObservations.source,
      createdAt: memoryObservations.createdAt,
      conversationTitle: conversations.title,
    })
    .from(memoryObservations)
    .leftJoin(
      conversations,
      eq(memoryObservations.conversationId, conversations.id),
    )
    .where(eq(memoryObservations.id, inserted.observationId))
    .get();

  return Response.json({ observation }, { status: 201 });
}

// ---------------------------------------------------------------------------
// DELETE /v1/memories/:id
// ---------------------------------------------------------------------------

export async function handleDeleteMemory(
  ctx: RouteContext,
): Promise<Response> {
  const { id } = ctx.params;
  const db = getDb();

  // Look up the observation
  const observation = db
    .select()
    .from(memoryObservations)
    .where(eq(memoryObservations.id, id))
    .get();

  if (!observation) {
    return httpError("NOT_FOUND", "Observation not found", 404);
  }

  // Get chunk IDs for this observation (for embedding cleanup)
  const chunks = db
    .select({ id: memoryChunks.id })
    .from(memoryChunks)
    .where(eq(memoryChunks.observationId, id))
    .all();

  const chunkIds = chunks.map((c) => c.id);

  // Delete embeddings targeting the observation directly
  db.delete(memoryEmbeddings)
    .where(
      and(
        eq(memoryEmbeddings.targetType, "observation"),
        eq(memoryEmbeddings.targetId, id),
      ),
    )
    .run();

  // Delete embeddings targeting chunks of this observation
  if (chunkIds.length > 0) {
    db.delete(memoryEmbeddings)
      .where(
        and(
          eq(memoryEmbeddings.targetType, "chunk"),
          inArray(memoryEmbeddings.targetId, chunkIds),
        ),
      )
      .run();
  }

  // Delete chunks (cascade from observation FK would handle this, but be explicit)
  db.delete(memoryChunks)
    .where(eq(memoryChunks.observationId, id))
    .run();

  // Delete the observation
  db.delete(memoryObservations)
    .where(eq(memoryObservations.id, id))
    .run();

  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function memoriesRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "memories",
      method: "GET",
      handler: (ctx) => handleListMemories(ctx.url),
    },
    {
      endpoint: "memories",
      method: "POST",
      handler: (ctx) => handleCreateMemory(ctx),
    },
    {
      endpoint: "memories/:id",
      method: "DELETE",
      policyKey: "memories",
      handler: (ctx) => handleDeleteMemory(ctx),
    },
  ];
}
