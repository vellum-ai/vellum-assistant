/**
 * Route handlers for conversation starter endpoints.
 *
 * GET    /v1/conversation-starters     — list conversation starters (chips)
 * DELETE /v1/conversation-starters/:id — remove a conversation starter chip
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import {
  checkpointKey,
  CK_ITEM_COUNT,
  CK_LAST_GEN_AT,
  countActiveMemoryNodes,
  getCheckpointValue,
  parseCheckpointInt,
} from "../../memory/conversation-starter-checkpoints.js";
import {
  buildConversationStarterValidationContext,
  isValidConversationStarterText,
} from "../../memory/conversation-starter-validation.js";
import { getDb } from "../../memory/db-connection.js";
import { enqueueMemoryJob } from "../../memory/jobs-store.js";
import { conversationStarters, memoryJobs } from "../../memory/schema.js";
import { NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

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

export const CONVERSATION_STARTERS_STALE_TTL_MS = 24 * 60 * 60 * 1000;

/** Minimum interval between re-enqueue attempts triggered by invalid items. */
const REFRESH_COOLDOWN_MS = 60_000;

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
// Handlers
// ---------------------------------------------------------------------------

function handleListConversationStarters({
  queryParams = {},
}: RouteHandlerArgs) {
  const limitParam = Math.min(Math.max(1, Number(queryParams.limit ?? 4)), 20);
  const offsetParam = Math.max(0, Number(queryParams.offset ?? 0));
  const scopeId = queryParams.scope_id ?? "default";

  const db = getDb();

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

  const validationContext = buildConversationStarterValidationContext();
  const validItems = allItems.filter((item) =>
    isValidConversationStarterText(item, validationContext),
  );
  const invalidItemCount = allItems.length - validItems.length;
  const total = validItems.length;

  if (allItems.length > 0) {
    const totalActive = countActiveMemoryNodes(scopeId);
    const lastCount = parseCheckpointInt(
      getCheckpointValue(checkpointKey(CK_ITEM_COUNT, scopeId)),
    );
    const lastGenAt = parseCheckpointInt(
      getCheckpointValue(checkpointKey(CK_LAST_GEN_AT, scopeId)),
    );
    const staleByAge =
      lastGenAt == null ||
      Date.now() - lastGenAt >= CONVERSATION_STARTERS_STALE_TTL_MS;
    const checkpointAhead = lastCount != null && totalActive < lastCount;
    let hasActiveJob = hasActiveConversationStarterJob(db, scopeId);
    const withinCooldown =
      lastGenAt != null && Date.now() - lastGenAt < REFRESH_COOLDOWN_MS;
    const shouldRefresh =
      staleByAge ||
      checkpointAhead ||
      (invalidItemCount > 0 && totalActive > 0 && !withinCooldown);

    if (shouldRefresh && !hasActiveJob) {
      enqueueMemoryJob("generate_conversation_starters", { scopeId });
      hasActiveJob = true;
    }

    const ordered = orderStrongestFirst(validItems);
    const page = ordered.slice(offsetParam, offsetParam + limitParam);
    return {
      starters: page,
      total,
      status: hasActiveJob ? "refreshing" : "ready",
    };
  }

  const memoryCount = countActiveMemoryNodes(scopeId);

  if (memoryCount === 0) {
    return { starters: [], total: 0, status: "empty" };
  }

  const existing = hasActiveConversationStarterJob(db, scopeId);

  if (!existing) {
    enqueueMemoryJob("generate_conversation_starters", { scopeId });
  }

  return { starters: [], total: 0, status: "generating" };
}

function handleDeleteConversationStarter({
  pathParams = {},
}: RouteHandlerArgs) {
  const starterId = pathParams.id;
  const db = getDb();
  const existing = db
    .select({ id: conversationStarters.id })
    .from(conversationStarters)
    .where(
      and(
        eq(conversationStarters.id, starterId),
        eq(conversationStarters.cardType, "chip"),
      ),
    )
    .get();

  if (!existing) {
    throw new NotFoundError(`Conversation starter not found: ${starterId}`);
  }

  db.delete(conversationStarters)
    .where(
      and(
        eq(conversationStarters.id, starterId),
        eq(conversationStarters.cardType, "chip"),
      ),
    )
    .run();

  return { deleted: true, id: starterId };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "conversation_starters_list",
    endpoint: "conversation-starters",
    method: "GET",
    handler: handleListConversationStarters,
    summary: "List conversation starters",
    description:
      "Return conversation starter chips, ordered for category diversity.",
    tags: ["conversation-starters"],
    queryParams: [
      {
        name: "limit",
        type: "integer",
        description: "Max starters to return (1–20, default 4)",
      },
      {
        name: "offset",
        type: "integer",
        description: "Pagination offset (default 0)",
      },
      {
        name: "scope_id",
        description: 'Scope ID (default "default")',
      },
    ],
    responseBody: z.object({
      starters: z.array(z.unknown()).describe("Ordered list of starter chips"),
      total: z.number().int().describe("Total number of available starters"),
      status: z
        .enum(["ready", "refreshing", "empty", "generating"])
        .describe("One of: ready, refreshing, empty, generating"),
    }),
  },
  {
    operationId: "conversation_starters_delete",
    endpoint: "conversation-starters/:id",
    method: "DELETE",
    policyKey: "conversation-starters",
    handler: handleDeleteConversationStarter,
    summary: "Delete conversation starter",
    description:
      "Remove a generated conversation starter chip from the current starter set.",
    tags: ["conversation-starters"],
    responseBody: z.object({
      deleted: z.boolean(),
      id: z.string(),
    }),
    additionalResponses: {
      "404": {
        description: "Conversation starter not found",
      },
    },
  },
];
