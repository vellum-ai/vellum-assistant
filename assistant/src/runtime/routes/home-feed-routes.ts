/**
 * Home activity feed routes.
 *
 * Exposes the three endpoints the macOS Home page uses to render and
 * interact with the activity feed:
 *
 *   - `GET  /v1/home/feed`                         — read + filter
 *   - `PATCH /v1/home/feed/:id`                    — mark seen / acted_on
 *   - `POST  /v1/home/feed/:id/actions/:actionId`  — trigger an action
 *
 * The routes are always available — the `home-feed` feature flag gates
 * the client rendering path only, so the daemon surface can ship ahead
 * of the rollout and client versions can adopt independently of
 * feature-flag timing.
 *
 * All persistence goes through `readHomeFeed` / `patchFeedItemStatus`
 * in `home/feed-writer.ts`; this module does not touch the on-disk
 * file directly. The writer already applies the TTL filter on read
 * and owns all SSE publication, so the route handlers stay pure
 * shape + validation + banner computation.
 */

import { z } from "zod";

import {
  type FeedItem,
  FeedItemSchema,
  type FeedItemStatus,
  HomeFeedResponseSchema,
} from "../../api/responses/home.js";
import { patchFeedItemStatus, readHomeFeed } from "../../home/feed-writer.js";
import { revalidateHomeContentInBackground } from "../../home/home-content-refresh.js";
import { getPersonalizedGreeting } from "../../home/home-greeting.js";
import { getSuggestedPrompts } from "../../home/suggested-prompts.js";
import {
  addMessage,
  createConversation,
} from "../../memory/conversation-crud.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("home-feed-routes");

// ---------------------------------------------------------------------------
// Response / request schemas
// ---------------------------------------------------------------------------

const patchFeedItemRequestSchema = z.object({
  status: z.enum(["new", "seen", "acted_on", "dismissed"]),
});

const listHomeFeedRequestSchema = z.object({
  includeDismissed: z.boolean().optional(),
  statuses: z
    .array(z.enum(["new", "seen", "acted_on", "dismissed"]))
    .optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  urgencies: z.array(z.enum(["low", "medium", "high", "critical"])).optional(),
  categories: z
    .array(z.enum(["security", "scheduling", "background", "email", "system"]))
    .optional(),
  conversationId: z.string().optional(),
  fromAssistant: z.boolean().optional(),
  noteworthy: z.boolean().optional(),
  limit: z.number().int().positive().max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
});

const listHomeFeedResponseSchema = z.object({
  items: z.array(FeedItemSchema),
  total: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  updatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Pure helpers (exported for direct testing)
// ---------------------------------------------------------------------------

export function computeGreeting(now: Date): string {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  if (hour >= 17 && hour < 22) return "Good evening";
  return "Welcome back";
}

export function formatRelativeTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 60) return "just now";
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  }
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  if (seconds < 172800) return "yesterday";
  const days = Math.floor(seconds / 86400);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function timeAwayBucket(seconds: number): string {
  if (seconds < 1800) return "<1800";
  if (seconds < 14400) return "1800-14400";
  if (seconds < 43200) return "14400-43200";
  if (seconds < 86400) return "43200-86400";
  return ">=86400";
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleGetHomeFeed({
  queryParams = {},
}: RouteHandlerArgs): Promise<Record<string, unknown>> {
  const raw = queryParams.timeAwaySeconds;
  if (raw === undefined) {
    throw new BadRequestError(
      "Missing required query parameter: timeAwaySeconds",
    );
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new BadRequestError("timeAwaySeconds must be a non-negative integer");
  }
  const timeAwaySeconds = parsed;

  const feed = readHomeFeed();
  // v2 schema dropped per-item `minTimeAway` gating; surface every item
  // and let the client decide what to render based on its own
  // session state. `timeAwaySeconds` survives only to feed the
  // context-banner relative-time label.
  const filtered = feed.items;

  const now = new Date();

  // Stale-while-revalidate: serve whatever is cached right now and kick
  // off a bounded background regeneration of any stale LLM content. The
  // refresh publishes `home_feed_updated` when fresh content lands, so
  // connected clients refetch and the personalized content swaps in.
  // This is the accepted exception to GET-handler idempotency documented
  // in `src/runtime/AGENTS.md` — the handler itself stays read-only and
  // returns immediately with cached/fallback copy.
  revalidateHomeContentInBackground();

  const personalizedGreeting = getPersonalizedGreeting();
  const suggestedPrompts = await getSuggestedPrompts();

  const contextBanner = {
    greeting: personalizedGreeting ?? computeGreeting(now),
    timeAwayLabel: formatRelativeTime(timeAwaySeconds),
    newCount: filtered.filter((i) => i.status === "new").length,
  };

  log.debug(
    {
      timeAwayBucket: timeAwayBucket(timeAwaySeconds),
      totalItems: feed.items.length,
      filteredItems: filtered.length,
      newCount: contextBanner.newCount,
      suggestedPromptsCount: suggestedPrompts.length,
    },
    "GET /v1/home/feed",
  );

  return {
    items: filtered,
    updatedAt: feed.updatedAt,
    contextBanner,
    suggestedPrompts,
  };
}

export async function handlePatchFeedItem({
  pathParams = {},
  body,
}: RouteHandlerArgs): Promise<Record<string, unknown>> {
  const itemId = pathParams.id;

  const parsed = patchFeedItemRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError("Invalid request body");
  }
  const status: FeedItemStatus = parsed.data.status;

  const currentFeed = readHomeFeed();
  const existing = currentFeed.items.find((i) => i.id === itemId);
  if (!existing) {
    throw new NotFoundError(`Feed item not found: ${itemId}`);
  }

  const updated = await patchFeedItemStatus(itemId, status);
  if (!updated) {
    log.warn(
      { itemId, status },
      "patchFeedItemStatus returned null despite pre-check — treating as write failure",
    );
    throw new InternalError("Failed to persist feed item status");
  }

  return updated as unknown as Record<string, unknown>;
}

export function handleListHomeFeed({
  body = {},
}: RouteHandlerArgs): Record<string, unknown> {
  const parsed = listHomeFeedRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(
      `Invalid list request: ${parsed.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    );
  }
  const params = parsed.data;

  const beforeMs =
    params.before !== undefined ? Date.parse(params.before) : undefined;
  if (beforeMs !== undefined && Number.isNaN(beforeMs)) {
    throw new BadRequestError(
      `Invalid 'before' timestamp; expected ISO-8601 (got "${params.before}")`,
    );
  }
  const afterMs =
    params.after !== undefined ? Date.parse(params.after) : undefined;
  if (afterMs !== undefined && Number.isNaN(afterMs)) {
    throw new BadRequestError(
      `Invalid 'after' timestamp; expected ISO-8601 (got "${params.after}")`,
    );
  }

  // `statuses` is the explicit override. Otherwise default to excluding
  // dismissed unless includeDismissed=true — the assistant's primary use
  // case is "what's still outstanding", so dismissed items are noise
  // unless explicitly requested.
  const statusFilter: Set<FeedItemStatus> | null = params.statuses
    ? new Set(params.statuses)
    : params.includeDismissed
      ? null
      : new Set<FeedItemStatus>(["new", "seen", "acted_on"]);

  const urgencySet = params.urgencies ? new Set(params.urgencies) : null;
  const categorySet = params.categories ? new Set(params.categories) : null;

  const feed = readHomeFeed();

  const filtered = feed.items.filter((item) => {
    if (statusFilter && !statusFilter.has(item.status)) return false;
    if (urgencySet) {
      if (!item.urgency || !urgencySet.has(item.urgency)) return false;
    }
    if (categorySet) {
      if (!item.category || !categorySet.has(item.category)) return false;
    }
    if (
      params.conversationId !== undefined &&
      item.conversationId !== params.conversationId
    )
      return false;
    if (
      params.fromAssistant !== undefined &&
      (item.fromAssistant ?? false) !== params.fromAssistant
    )
      return false;
    if (
      params.noteworthy !== undefined &&
      (item.noteworthy ?? false) !== params.noteworthy
    )
      return false;

    if (beforeMs !== undefined || afterMs !== undefined) {
      const createdMs = Date.parse(item.createdAt);
      if (Number.isNaN(createdMs)) return false;
      if (beforeMs !== undefined && createdMs >= beforeMs) return false;
      if (afterMs !== undefined && createdMs <= afterMs) return false;
    }

    return true;
  });

  const total = filtered.length;
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 20;
  const items = filtered.slice(offset, offset + limit);

  return {
    items,
    total,
    returned: items.length,
    hasMore: total > offset + items.length,
    updatedAt: feed.updatedAt,
  };
}

export async function handlePostFeedAction({
  pathParams = {},
}: RouteHandlerArgs): Promise<Record<string, unknown>> {
  const itemId = pathParams.id;
  const actionId = pathParams.actionId;

  const feed = readHomeFeed();
  const item: FeedItem | undefined = feed.items.find((i) => i.id === itemId);
  if (!item) {
    throw new NotFoundError(`Feed item not found: ${itemId}`);
  }

  const action = item.actions?.find((a) => a.id === actionId);
  if (!action) {
    throw new NotFoundError(`Action not found on item ${itemId}: ${actionId}`);
  }

  try {
    const conversation = createConversation({
      title: action.label,
      source: "home-feed",
    });
    await addMessage(
      conversation.id,
      "user",
      JSON.stringify([{ type: "text", text: action.prompt }]),
    );
    return { conversationId: conversation.id };
  } catch (err) {
    log.warn(
      { err, itemId, actionId },
      "Failed to create conversation from feed action",
    );
    throw new InternalError("Failed to create conversation for feed action");
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "get_home_feed",
    endpoint: "home/feed",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleGetHomeFeed,
    summary: "Get home activity feed",
    description:
      "Return the current Home activity feed with TTL + time-away filtering applied. Also returns a context banner (greeting, relative time-away label, new-item count).",
    tags: ["home"],
    queryParams: [
      {
        name: "timeAwaySeconds",
        type: "integer",
        required: true,
        description:
          "Seconds since the user was last active in the client. Used to compute the context-banner relative-time label.",
      },
    ],
    responseBody: HomeFeedResponseSchema,
  },
  {
    operationId: "patch_home_feed_item",
    endpoint: "home/feed/:id",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handlePatchFeedItem,
    summary: "Patch home feed item status",
    description:
      "Update the `status` field of a single feed item (e.g. mark it seen or acted_on). Returns the updated item on success, 404 if the item does not exist, 500 if the underlying write fails.",
    tags: ["home"],
    requestBody: patchFeedItemRequestSchema,
    responseBody: FeedItemSchema,
    additionalResponses: {
      "404": { description: "Feed item not found" },
      "500": { description: "Failed to persist feed item status" },
    },
  },
  {
    operationId: "list_home_feed",
    endpoint: "home/feed/query",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleListHomeFeed,
    summary: "List home feed items with filters",
    description:
      "Return home feed items filtered by status, urgency, category, conversation, and date range. Defaults to excluding dismissed items. Used by the assistant CLI to inspect what notifications have been surfaced to the user.",
    tags: ["home"],
    requestBody: listHomeFeedRequestSchema,
    responseBody: listHomeFeedResponseSchema,
  },
  {
    operationId: "trigger_home_feed_action",
    endpoint: "home/feed/:id/actions/:actionId",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handlePostFeedAction,
    summary: "Trigger home feed action",
    description:
      "Create a new conversation pre-seeded with the action's prompt as the first user message. Returns the new `conversationId`.",
    tags: ["home"],
    responseBody: z.object({
      conversationId: z.string(),
    }),
    additionalResponses: {
      "404": { description: "Feed item or action not found" },
      "500": { description: "Failed to create conversation" },
    },
  },
];
