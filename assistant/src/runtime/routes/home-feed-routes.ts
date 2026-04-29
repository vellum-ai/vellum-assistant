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
  feedItemSchema,
  type FeedItemStatus,
  suggestedPromptSchema,
} from "../../home/feed-types.js";
import { patchFeedItemStatus, readHomeFeed } from "../../home/feed-writer.js";
import { getSuggestedPrompts } from "../../home/suggested-prompts.js";
import {
  addMessage,
  createConversation,
} from "../../memory/conversation-crud.js";
import { getLogger } from "../../util/logger.js";
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("home-feed-routes");

// ---------------------------------------------------------------------------
// Response / request schemas
// ---------------------------------------------------------------------------

const contextBannerSchema = z.object({
  greeting: z.string(),
  timeAwayLabel: z.string(),
  newCount: z.number().int().min(0),
});

const getHomeFeedResponseSchema = z.object({
  items: z.array(feedItemSchema),
  updatedAt: z.string(),
  contextBanner: contextBannerSchema,
  suggestedPrompts: z.array(suggestedPromptSchema),
});

const patchFeedItemRequestSchema = z.object({
  status: z.enum(["new", "seen", "acted_on", "dismissed"]),
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
  const contextBanner = {
    greeting: computeGreeting(now),
    timeAwayLabel: formatRelativeTime(timeAwaySeconds),
    newCount: filtered.filter((i) => i.status === "new").length,
  };

  const suggestedPrompts = await getSuggestedPrompts();

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
    responseBody: getHomeFeedResponseSchema,
  },
  {
    operationId: "patch_home_feed_item",
    endpoint: "home/feed/:id",
    method: "PATCH",
    handler: handlePatchFeedItem,
    summary: "Patch home feed item status",
    description:
      "Update the `status` field of a single feed item (e.g. mark it seen or acted_on). Returns the updated item on success, 404 if the item does not exist, 500 if the underlying write fails.",
    tags: ["home"],
    requestBody: patchFeedItemRequestSchema,
    responseBody: feedItemSchema,
    additionalResponses: {
      "404": { description: "Feed item not found" },
      "500": { description: "Failed to persist feed item status" },
    },
  },
  {
    operationId: "trigger_home_feed_action",
    endpoint: "home/feed/:id/actions/:actionId",
    method: "POST",
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
