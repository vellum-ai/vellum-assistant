/**
 * Route handlers for conversation starter endpoints.
 *
 * GET /v1/conversation-starters — list conversation starters (chips)
 */

import { and, desc, eq, inArray, like } from "drizzle-orm";

import { getDb } from "../../memory/db.js";
import { enqueueMemoryJob } from "../../memory/jobs-store.js";
import { rawGet } from "../../memory/raw-query.js";
import { conversationStarters, memoryJobs } from "../../memory/schema.js";
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

  // Fetch from the latest batch, then apply strongest-first ordering so the
  // first four chips form a coherent, category-diverse row.
  const rawItems = db
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
    .limit(Math.max(limitParam, 20))
    .offset(offsetParam)
    .all();

  const items = orderStrongestFirst(rawItems).slice(0, limitParam);

  const countRow = rawGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM conversation_starters WHERE scope_id = ? AND card_type = 'chip'`,
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
        eq(memoryJobs.type, "generate_conversation_starters"),
        inArray(memoryJobs.status, ["pending", "running"]),
        like(memoryJobs.payload, `%"scopeId":"${scopeId}"%`),
      ),
    )
    .get();

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
      handler: (ctx) => handleListConversationStarters(ctx.url),
    },
  ];
}
