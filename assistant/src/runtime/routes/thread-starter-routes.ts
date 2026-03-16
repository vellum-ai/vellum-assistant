/**
 * Route handlers for thread starter endpoints.
 *
 * GET /v1/thread-starters — list thread starters for empty conversation chips
 */

import { and, desc, eq, inArray, like } from "drizzle-orm";

import { getDb } from "../../memory/db.js";
import { enqueueMemoryJob } from "../../memory/jobs-store.js";
import { rawGet } from "../../memory/raw-query.js";
import { memoryJobs, threadStarters } from "../../memory/schema.js";
import type { RouteDefinition } from "../http-router.js";

// ---------------------------------------------------------------------------
// GET /v1/thread-starters
// ---------------------------------------------------------------------------

function handleListThreadStarters(url: URL): Response {
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
    .where(eq(threadStarters.scopeId, scopeId))
    .orderBy(
      desc(threadStarters.generationBatch),
      desc(threadStarters.createdAt),
    )
    .limit(limitParam)
    .offset(offsetParam)
    .all();

  const countRow = rawGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM thread_starters WHERE scope_id = ?`,
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
