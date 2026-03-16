/**
 * Route handlers for thread starter endpoints.
 *
 * GET /v1/thread-starters — list thread starters for empty conversation chips
 */

import { desc, eq } from "drizzle-orm";

import { getDb } from "../../memory/db.js";
import { rawGet } from "../../memory/raw-query.js";
import { threadStarters } from "../../memory/schema.js";
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

  return Response.json({ starters: items, total });
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
