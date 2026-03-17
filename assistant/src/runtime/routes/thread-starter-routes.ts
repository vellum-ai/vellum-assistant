/**
 * Route handlers for thread starter endpoints.
 *
 * GET /v1/thread-starters — list thread starters (chips) or capability cards
 */

import { and, desc, eq, inArray, like } from "drizzle-orm";

import { getDb } from "../../memory/db.js";
import { CAPABILITY_CARD_CATEGORIES } from "../../memory/job-handlers/capability-cards.js";
import { enqueueMemoryJob } from "../../memory/jobs-store.js";
import { rawAll, rawGet } from "../../memory/raw-query.js";
import {
  capabilityCardCategories,
  memoryJobs,
  threadStarters,
} from "../../memory/schema.js";
import type { RouteDefinition } from "../http-router.js";

// ---------------------------------------------------------------------------
// GET /v1/thread-starters?card_type=chip (default, backwards-compat)
// ---------------------------------------------------------------------------

function handleListThreadStarters(url: URL): Response {
  const cardType = url.searchParams.get("card_type") ?? "chip";

  if (cardType === "card") {
    return handleListCapabilityCards(url);
  }

  const limitParam = Math.min(
    Math.max(1, Number(url.searchParams.get("limit") ?? 4)),
    20,
  );
  const offsetParam = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
  const scopeId = url.searchParams.get("scope_id") ?? "default";

  const db = getDb();

  const items = db
    .select({
      id: threadStarters.id,
      label: threadStarters.label,
      prompt: threadStarters.prompt,
      category: threadStarters.category,
      batch: threadStarters.generationBatch,
    })
    .from(threadStarters)
    .where(
      and(
        eq(threadStarters.scopeId, scopeId),
        eq(threadStarters.cardType, "chip"),
      ),
    )
    .orderBy(
      desc(threadStarters.generationBatch),
      desc(threadStarters.createdAt),
    )
    .limit(limitParam)
    .offset(offsetParam)
    .all();

  const countRow = rawGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM thread_starters WHERE scope_id = ? AND card_type = 'chip'`,
    scopeId,
  );
  const total = countRow?.c ?? 0;

  // If starters exist, return them immediately.
  if (total > 0) {
    return Response.json({ starters: items, total, status: "ready" });
  }

  // No starters — check whether we have memory items to generate from.
  const memoryCount = rawGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM memory_items WHERE status = 'active' AND scope_id = ?`,
    scopeId,
  );

  if (!memoryCount || memoryCount.c === 0) {
    return Response.json({ starters: [], total: 0, status: "empty" });
  }

  // Memory items exist but no starters yet — ensure a generation job is queued.
  const existing = db
    .select({ id: memoryJobs.id })
    .from(memoryJobs)
    .where(
      and(
        eq(memoryJobs.type, "generate_thread_starters"),
        inArray(memoryJobs.status, ["pending", "running"]),
        like(memoryJobs.payload, `%"scopeId":"${scopeId}"%`),
      ),
    )
    .get();

  if (!existing) {
    enqueueMemoryJob("generate_thread_starters", { scopeId });
  }

  return Response.json({ starters: [], total: 0, status: "generating" });
}

// ---------------------------------------------------------------------------
// GET /v1/thread-starters?card_type=card — capability cards feed
// ---------------------------------------------------------------------------

function handleListCapabilityCards(url: URL): Response {
  const limitParam = Math.min(
    Math.max(1, Number(url.searchParams.get("limit") ?? 24)),
    50,
  );
  const scopeId = url.searchParams.get("scope_id") ?? "default";
  const categoryFilter = url.searchParams.get("category");

  const db = getDb();

  // Build WHERE conditions for cards
  const conditions = [
    eq(threadStarters.scopeId, scopeId),
    eq(threadStarters.cardType, "card"),
  ];
  if (categoryFilter) {
    conditions.push(eq(threadStarters.category, categoryFilter));
  }

  const cards = db
    .select({
      id: threadStarters.id,
      icon: threadStarters.icon,
      label: threadStarters.label,
      description: threadStarters.description,
      prompt: threadStarters.prompt,
      category: threadStarters.category,
      tags: threadStarters.tags,
      batch: threadStarters.generationBatch,
    })
    .from(threadStarters)
    .where(and(...conditions))
    .orderBy(
      desc(threadStarters.generationBatch),
      desc(threadStarters.createdAt),
    )
    .limit(limitParam)
    .all();

  // Transform tags from comma-separated string to array
  const transformedCards = cards.map((c) => ({
    ...c,
    tags: c.tags ? c.tags.split(",").filter(Boolean) : [],
  }));

  // Build per-category status map
  const categoryStatuses = buildCategoryStatuses(scopeId);

  // Proper COUNT query — transformedCards.length would be LIMIT-capped
  const countCondition = categoryFilter ? `AND category = ?` : ``;
  const countParams = categoryFilter ? [scopeId, categoryFilter] : [scopeId];
  const countRow = rawGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM thread_starters WHERE scope_id = ? AND card_type = 'card' ${countCondition}`,
    ...countParams,
  );
  const total = countRow?.c ?? 0;

  // If we have cards, return them
  if (total > 0) {
    const overallStatus = Object.values(categoryStatuses).some(
      (s) => s.status === "generating",
    )
      ? "generating"
      : "ready";

    return Response.json({
      cards: transformedCards,
      total,
      status: overallStatus,
      categories: categoryStatuses,
    });
  }

  // No cards — check whether we have memory items to generate from
  const memoryCount = rawGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM memory_items WHERE status = 'active' AND scope_id = ?`,
    scopeId,
  );

  if (!memoryCount || memoryCount.c === 0) {
    return Response.json({
      cards: [],
      total: 0,
      status: "empty",
      categories: {},
    });
  }

  // Memory items exist but no cards — enqueue generation for all categories
  enqueueCapabilityCardJobs(scopeId);

  return Response.json({
    cards: [],
    total: 0,
    status: "generating",
    categories: Object.fromEntries(
      CAPABILITY_CARD_CATEGORIES.map((cat) => [
        cat,
        { status: "generating" as const },
      ]),
    ),
  });
}

/** Build a status map for each category: ready (with relevance) or generating. */
function buildCategoryStatuses(
  scopeId: string,
): Record<string, { status: string; relevance?: number }> {
  const db = getDb();
  const statuses: Record<string, { status: string; relevance?: number }> = {};

  // Get completed categories with relevance scores
  const completed = db
    .select({
      category: capabilityCardCategories.category,
      relevance: capabilityCardCategories.relevance,
    })
    .from(capabilityCardCategories)
    .where(eq(capabilityCardCategories.scopeId, scopeId))
    .all();

  const completedSet = new Set(completed.map((c) => c.category));
  for (const row of completed) {
    statuses[row.category] = { status: "ready", relevance: row.relevance };
  }

  // Check for in-flight generation jobs
  const pendingJobs = rawAll<{ payload: string }>(
    `SELECT payload FROM memory_jobs
     WHERE type = 'generate_capability_cards'
       AND status IN ('pending', 'running')
       AND payload LIKE ?`,
    `%"scopeId":"${scopeId}"%`,
  );

  for (const job of pendingJobs) {
    try {
      const parsed = JSON.parse(job.payload) as { category?: string };
      if (parsed.category && !completedSet.has(parsed.category)) {
        statuses[parsed.category] = { status: "generating" };
      }
    } catch {
      // Skip malformed payloads
    }
  }

  return statuses;
}

/** Enqueue one generation job per category, skipping those already in-flight. */
function enqueueCapabilityCardJobs(scopeId: string): void {
  const db = getDb();

  for (const category of CAPABILITY_CARD_CATEGORIES) {
    // Check if already pending/running for this scope+category
    const existing = db
      .select({ id: memoryJobs.id })
      .from(memoryJobs)
      .where(
        and(
          eq(memoryJobs.type, "generate_capability_cards"),
          inArray(memoryJobs.status, ["pending", "running"]),
          like(memoryJobs.payload, `%"scopeId":"${scopeId}"%`),
          like(memoryJobs.payload, `%"category":"${category}"%`),
        ),
      )
      .get();

    if (!existing) {
      enqueueMemoryJob("generate_capability_cards", { scopeId, category });
    }
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function threadStarterRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "thread-starters",
      method: "GET",
      handler: (ctx) => handleListThreadStarters(ctx.url),
    },
  ];
}
