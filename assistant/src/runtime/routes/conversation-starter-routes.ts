/**
 * Route handlers for conversation starter endpoints.
 *
 * GET /v1/conversation-starters — list conversation starters (chips)
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../../memory/db.js";
import { enqueueMemoryJob } from "../../memory/jobs-store.js";
import { rawGet } from "../../memory/raw-query.js";
import {
  conversationStarters,
  memoryCheckpoints,
  memoryJobs,
} from "../../memory/schema.js";
import type { RouteDefinition } from "../http-router.js";

// ---------------------------------------------------------------------------
// Strongest-first ordering — maximize category diversity so the top four
// chips form a coherent, non-repetitive row.
// ---------------------------------------------------------------------------

interface StarterItem {
  id: string;
  label: string;
  prompt: string;
  category: string | null;
  batch: number;
}

const CK_ITEM_COUNT = "conversation_starters:item_count_at_last_gen";
const CK_LAST_GEN_AT = "conversation_starters:last_gen_at";
export const CONVERSATION_STARTERS_STALE_TTL_MS = 24 * 60 * 60 * 1000;

function checkpointKey(base: string, scopeId: string): string {
  return `${base}:${scopeId}`;
}

function parseCheckpointInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasActiveConversationStarterJob(
  db: ReturnType<typeof getDb>,
  scopeId: string,
): boolean {
  return (
    db
      .select({ id: memoryJobs.id })
      .from(memoryJobs)
      .where(
        and(
          eq(memoryJobs.type, "generate_conversation_starters"),
          inArray(memoryJobs.status, ["pending", "running"]),
          sql`json_extract(${memoryJobs.payload}, '$.scopeId') = ${scopeId}`,
        ),
      )
      .get() != null
  );
}

/**
 * Re-order starters so adjacent items have distinct categories wherever
 * possible. Within each category, preserve the original (batch-desc) order.
 * This is deterministic — same input always produces the same output.
 */
export function orderStrongestFirst<T extends StarterItem>(items: T[]): T[] {
  if (items.length <= 1) return items;

  // Group by category, preserving original order within each group
  const byCategory = new Map<string, T[]>();
  for (const item of items) {
    const cat = item.category ?? "other";
    let group = byCategory.get(cat);
    if (!group) {
      group = [];
      byCategory.set(cat, group);
    }
    group.push(item);
  }

  // Prefer categories with the most remaining items so the row stays varied
  // early without burying the dominant themes entirely.
  const sortedGroups = [...byCategory.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([, group]) => ({ items: group, idx: 0 }));

  const result: T[] = [];
  const seenCategories = new Set<string>();
  let lastCategory: string | null = null;

  while (result.length < items.length) {
    let picked = false;
    const availableGroups = sortedGroups.filter(
      (group) => group.idx < group.items.length,
    );

    const unseenGroups = availableGroups.filter((group) => {
      const category = group.items[group.idx]?.category ?? "other";
      return category !== lastCategory && !seenCategories.has(category);
    });

    const nextGroups =
      unseenGroups.length > 0
        ? unseenGroups
        : availableGroups.filter((group) => {
            const category = group.items[group.idx]?.category ?? "other";
            return category !== lastCategory;
          });

    // First pass: prefer unseen categories, then avoid adjacent duplicates.
    for (const group of nextGroups) {
      if (group.idx >= group.items.length) continue;
      const candidate = group.items[group.idx];
      const cat = candidate.category ?? "other";
      result.push(candidate);
      group.idx++;
      seenCategories.add(cat);
      lastCategory = cat;
      picked = true;
      break;
    }

    // Fallback: if all remaining items share the same category, just pick next
    if (!picked) {
      for (const group of availableGroups) {
        if (group.idx < group.items.length) {
          const candidate = group.items[group.idx];
          const cat = candidate.category ?? "other";
          result.push(candidate);
          group.idx++;
          seenCategories.add(cat);
          lastCategory = cat;
          picked = true;
          break;
        }
      }
    }

    if (!picked) break;
  }

  return result;
}

// ---------------------------------------------------------------------------
// GET /v1/conversation-starters
// ---------------------------------------------------------------------------

function handleListConversationStarters(url: URL): Response {
  const limitParam = Math.min(
    Math.max(1, Number(url.searchParams.get("limit") ?? 4)),
    20,
  );
  const offsetParam = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
  const scopeId = url.searchParams.get("scope_id") ?? "default";

  const db = getDb();

  // Fetch all chips (ranked by model, newest batch first), apply diversity
  // reordering, then paginate. Reordering must happen before offset/limit so
  // that paginated results are stable across pages.
  const allItems = db
    .select({
      id: conversationStarters.id,
      label: conversationStarters.label,
      prompt: conversationStarters.prompt,
      category: conversationStarters.category,
      batch: conversationStarters.generationBatch,
    })
    .from(conversationStarters)
    .where(
      and(
        eq(conversationStarters.scopeId, scopeId),
        eq(conversationStarters.cardType, "chip"),
      ),
    )
    .orderBy(
      desc(conversationStarters.generationBatch),
      desc(conversationStarters.createdAt),
    )
    .all();

  const total = allItems.length;

  // If starters exist, return them immediately. If the batch is stale or
  // the generation checkpoint is ahead of the current active memory count,
  // kick off a background refresh but keep the existing chips visible.
  if (total > 0) {
    const totalActive =
      rawGet<{ c: number }>(
        `SELECT COUNT(*) AS c FROM memory_graph_nodes WHERE fidelity != 'gone' AND scope_id = ?`,
        scopeId,
      )?.c ?? 0;
    const lastCount = parseCheckpointInt(
      db
        .select({ value: memoryCheckpoints.value })
        .from(memoryCheckpoints)
        .where(eq(memoryCheckpoints.key, checkpointKey(CK_ITEM_COUNT, scopeId)))
        .get()?.value,
    );
    const lastGenAt = parseCheckpointInt(
      db
        .select({ value: memoryCheckpoints.value })
        .from(memoryCheckpoints)
        .where(
          eq(memoryCheckpoints.key, checkpointKey(CK_LAST_GEN_AT, scopeId)),
        )
        .get()?.value,
    );
    const staleByAge =
      lastGenAt == null ||
      Date.now() - lastGenAt >= CONVERSATION_STARTERS_STALE_TTL_MS;
    const checkpointAhead = lastCount != null && totalActive < lastCount;
    let hasActiveJob = hasActiveConversationStarterJob(db, scopeId);
    const shouldRefresh = staleByAge || checkpointAhead;

    if (shouldRefresh && !hasActiveJob) {
      enqueueMemoryJob("generate_conversation_starters", { scopeId });
      hasActiveJob = true;
    }

    const ordered = orderStrongestFirst(allItems);
    const page = ordered.slice(offsetParam, offsetParam + limitParam);
    return Response.json({
      starters: page,
      total,
      status: hasActiveJob ? "refreshing" : "ready",
    });
  }

  // No starters — check whether we have memory graph nodes to generate from.
  const memoryCount = rawGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM memory_graph_nodes WHERE fidelity != 'gone' AND scope_id = ?`,
    scopeId,
  );

  if (!memoryCount || memoryCount.c === 0) {
    return Response.json({ starters: [], total: 0, status: "empty" });
  }

  // Memory items exist but no starters yet — ensure a generation job is queued.
  const existing = hasActiveConversationStarterJob(db, scopeId);

  if (!existing) {
    enqueueMemoryJob("generate_conversation_starters", { scopeId });
  }

  return Response.json({ starters: [], total: 0, status: "generating" });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function conversationStarterRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "conversation-starters",
      method: "GET",
      summary: "List conversation starters",
      description:
        "Return conversation starter chips, ordered for category diversity.",
      tags: ["conversation-starters"],
      handler: (ctx) => handleListConversationStarters(ctx.url),
      queryParams: [
        {
          name: "limit",
          schema: { type: "integer" },
          description: "Max starters to return (1–20, default 4)",
        },
        {
          name: "offset",
          schema: { type: "integer" },
          description: "Pagination offset (default 0)",
        },
        {
          name: "scope_id",
          schema: { type: "string" },
          description: 'Scope ID (default "default")',
        },
      ],
      responseBody: z.object({
        starters: z
          .array(z.unknown())
          .describe("Ordered list of starter chips"),
        total: z.number().int().describe("Total number of available starters"),
        status: z
          .enum(["ready", "refreshing", "empty", "generating"])
          .describe("One of: ready, refreshing, empty, generating"),
      }),
    },
  ];
}
