/**
 * Home activity feed HTTP routes.
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
} from "../../home/feed-types.js";
import { patchFeedItemStatus, readHomeFeed } from "../../home/feed-writer.js";
import { runRollupProducer } from "../../home/rollup-producer.js";
import {
  addMessage,
  createConversation,
} from "../../memory/conversation-crud.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("home-feed-routes");

/**
 * Debounce window for the on-visit rollup refresh. A GET on the feed
 * route fires the rollup producer fire-and-forget at most once per
 * window — repeat GETs within this interval (e.g. from a client that
 * polls aggressively, or from multiple panels opening in rapid
 * succession) skip the trigger and just return the cached feed.
 */
const ON_VISIT_REFRESH_DEBOUNCE_MS = 10 * 60 * 1000;

let lastOnVisitRefreshAt = 0;

/**
 * Reset the on-visit debounce gate. Test-only — production callers
 * should never touch this. Exported with an underscore-prefixed name
 * so lint rules can flag misuse.
 */
export function __resetOnVisitRefreshStateForTests(): void {
  lastOnVisitRefreshAt = 0;
}

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
});

const patchFeedItemRequestSchema = z.object({
  status: z.enum(["new", "seen", "acted_on", "dismissed"]),
});

// ---------------------------------------------------------------------------
// Pure helpers (exported for direct testing — see home-feed-routes.test.ts)
// ---------------------------------------------------------------------------

/**
 * Map the server's wall-clock hour to a human greeting. Pure function;
 * no LLM. The buckets match the plan:
 *   - 05:00–11:59 → "Good morning"
 *   - 12:00–16:59 → "Good afternoon"
 *   - 17:00–21:59 → "Good evening"
 *   - otherwise   → "Welcome back"
 */
export function computeGreeting(now: Date): string {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  if (hour >= 17 && hour < 22) return "Good evening";
  return "Welcome back";
}

/**
 * Format a `timeAwaySeconds` value as a coarse relative-time label.
 * Kept in-file since no other caller needs it yet; extract to a shared
 * util module when a second caller appears.
 */
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

/**
 * Bucket `timeAwaySeconds` into coarse ranges used only for debug
 * logging cardinality control. Not exposed to clients.
 */
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

/**
 * `GET /v1/home/feed`.
 *
 * Required query param: `timeAwaySeconds` (non-negative integer). The
 * handler reads the feed via `readHomeFeed()` (which has already
 * applied TTL filtering), drops items whose `minTimeAway` exceeds the
 * client-reported time away, then computes the context banner.
 */
export async function handleGetHomeFeed(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const raw = url.searchParams.get("timeAwaySeconds");
  if (raw === null) {
    return httpError(
      "BAD_REQUEST",
      "Missing required query parameter: timeAwaySeconds",
      400,
    );
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return httpError(
      "BAD_REQUEST",
      "timeAwaySeconds must be a non-negative integer",
      400,
    );
  }
  const timeAwaySeconds = parsed;

  const feed = readHomeFeed();
  const filtered = feed.items.filter((item) => {
    if (item.minTimeAway === undefined) return true;
    return item.minTimeAway <= timeAwaySeconds;
  });

  const now = new Date();
  const contextBanner = {
    greeting: computeGreeting(now),
    timeAwayLabel: formatRelativeTime(timeAwaySeconds),
    newCount: filtered.filter((i) => i.status === "new").length,
  };

  log.debug(
    {
      timeAwayBucket: timeAwayBucket(timeAwaySeconds),
      totalItems: feed.items.length,
      filteredItems: filtered.length,
      newCount: contextBanner.newCount,
    },
    "GET /v1/home/feed",
  );

  // Fire the on-visit rollup refresh AFTER computing the response so
  // nothing in the trigger path can delay the GET. The rollup runs
  // fire-and-forget; its writes will publish `home_feed_updated` via
  // the writer's SSE path, and the client auto-refreshes.
  maybeTriggerOnVisitRollupRefresh(now);

  return Response.json({
    items: filtered,
    updatedAt: feed.updatedAt,
    contextBanner,
  });
}

/**
 * Fire the rollup producer fire-and-forget when the debounce window
 * has elapsed since the last trigger. Returns immediately — the
 * caller never awaits the rollup, and any error inside the producer
 * is swallowed into a warn log so an LLM hiccup can never turn a
 * GET /v1/home/feed into a 500.
 *
 * The debounce is deliberately set in this module rather than the
 * producer itself so the producer stays reusable from the scheduler
 * (which has its own separate 2h safety-net cadence). The
 * producer's internal in-flight guard handles the rare race where
 * both the scheduler and the route fire at the same instant.
 *
 * Debounce semantics: we eager-advance `lastOnVisitRefreshAt` before
 * awaiting the producer so concurrent GETs during the LLM call are
 * blocked at the guard check above. When the producer returns with
 * a skip reason that short-circuited BEFORE the LLM call
 * (`no_provider`, `no_actions`, `in_flight`) we roll the gate back
 * to its previous value — burning the full 10-minute window on a
 * daemon that hasn't finished booting would leave Home stale the
 * whole time the user is actively trying to refresh. Real LLM
 * attempts (success / `empty_items` / `malformed_output` /
 * `provider_error`) keep the advanced gate so a broken producer
 * can't be hammered by an aggressive client.
 */
function maybeTriggerOnVisitRollupRefresh(now: Date): void {
  const nowMs = now.getTime();
  if (nowMs - lastOnVisitRefreshAt < ON_VISIT_REFRESH_DEBOUNCE_MS) return;
  const previousRefreshAt = lastOnVisitRefreshAt;
  lastOnVisitRefreshAt = nowMs;
  void runRollupProducer(now)
    .then((result) => {
      const skippedBeforeLLM =
        result.skippedReason === "no_provider" ||
        result.skippedReason === "no_actions" ||
        result.skippedReason === "in_flight";
      if (skippedBeforeLLM) {
        // Only roll back if no subsequent GET has since advanced the
        // gate past our eager value. Defensive: given the guard at
        // the top of this function a concurrent GET shouldn't be
        // able to advance past our `nowMs`, but if some future
        // refactor changes that we don't want to silently clobber a
        // newer timestamp.
        if (lastOnVisitRefreshAt === nowMs) {
          lastOnVisitRefreshAt = previousRefreshAt;
        }
        log.debug(
          { skippedReason: result.skippedReason },
          "On-visit rollup refresh skipped; debounce gate rolled back",
        );
      } else if (result.skippedReason !== null) {
        log.debug(
          { skippedReason: result.skippedReason },
          "On-visit rollup refresh skipped",
        );
      } else {
        log.info(
          { wroteCount: result.wroteCount },
          "On-visit rollup refresh completed",
        );
      }
    })
    .catch((err) => {
      log.warn({ err }, "On-visit rollup refresh failed");
    });
}

/**
 * `PATCH /v1/home/feed/:id`.
 *
 * Body: `{ status: "new" | "seen" | "acted_on" | "dismissed" }`. Returns the updated
 * `FeedItem` on success.
 *
 * Disambiguates the writer's `null` return by looking up the item via
 * `readHomeFeed()` first — if the lookup finds the item and the patch
 * still returns null, it's a write failure (500), not a missing id
 * (404).
 */
export async function handlePatchFeedItem(
  req: Request,
  itemId: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return httpError("BAD_REQUEST", "Invalid JSON body", 400);
  }

  const parsed = patchFeedItemRequestSchema.safeParse(body);
  if (!parsed.success) {
    return httpError("BAD_REQUEST", "Invalid request body", 400, {
      issues: parsed.error.issues,
    });
  }
  const status: FeedItemStatus = parsed.data.status;

  // Pre-check for existence so we can distinguish "unknown id" (404)
  // from "found, but write failed" (500). The writer applies the patch
  // inside its coalescing queue against the same on-disk state we just
  // read, so a race where the item disappears between the check and
  // the write resolves cleanly as a 500 (write failed / no such item).
  const currentFeed = readHomeFeed();
  const existing = currentFeed.items.find((i) => i.id === itemId);
  if (!existing) {
    return httpError("NOT_FOUND", `Feed item not found: ${itemId}`, 404);
  }

  const updated = await patchFeedItemStatus(itemId, status);
  if (!updated) {
    log.warn(
      { itemId, status },
      "patchFeedItemStatus returned null despite pre-check — treating as write failure",
    );
    return httpError(
      "INTERNAL_ERROR",
      "Failed to persist feed item status",
      500,
    );
  }

  return Response.json(updated);
}

/**
 * `POST /v1/home/feed/:id/actions/:actionId`.
 *
 * Looks up the item + action, creates a new conversation pre-seeded
 * with the action's `prompt` as the first user message, and returns
 * `{ conversationId }`. Any lookup failure → 404; conversation create
 * error → 500.
 */
export async function handlePostFeedAction(
  _req: Request,
  itemId: string,
  actionId: string,
): Promise<Response> {
  const feed = readHomeFeed();
  const item: FeedItem | undefined = feed.items.find((i) => i.id === itemId);
  if (!item) {
    return httpError("NOT_FOUND", `Feed item not found: ${itemId}`, 404);
  }

  const action = item.actions?.find((a) => a.id === actionId);
  if (!action) {
    return httpError(
      "NOT_FOUND",
      `Action not found on item ${itemId}: ${actionId}`,
      404,
    );
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
    return Response.json({ conversationId: conversation.id });
  } catch (err) {
    log.warn(
      { err, itemId, actionId },
      "Failed to create conversation from feed action",
    );
    return httpError(
      "INTERNAL_ERROR",
      "Failed to create conversation for feed action",
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function homeFeedRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "home/feed",
      method: "GET",
      handler: ({ req }) => handleGetHomeFeed(req),
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
            "Seconds since the user was last active in the client. Used to filter items with a `minTimeAway` gate and to compute the context-banner relative-time label.",
        },
      ],
      responseBody: getHomeFeedResponseSchema,
    },
    {
      endpoint: "home/feed/:id",
      method: "PATCH",
      handler: ({ req, params }) => handlePatchFeedItem(req, params.id),
      summary: "Patch home feed item status",
      description:
        "Update the `status` field of a single feed item (e.g. mark it seen or acted_on). Returns the updated item on success, 404 if the item does not exist, 500 if the underlying write fails.",
      tags: ["home"],
      requestBody: patchFeedItemRequestSchema,
      responseBody: feedItemSchema,
    },
    {
      endpoint: "home/feed/:id/actions/:actionId",
      method: "POST",
      handler: ({ req, params }) =>
        handlePostFeedAction(req, params.id, params.actionId),
      summary: "Trigger home feed action",
      description:
        "Create a new conversation pre-seeded with the action's prompt as the first user message. Returns the new `conversationId`.",
      tags: ["home"],
      responseBody: z.object({
        conversationId: z.string(),
      }),
    },
  ];
}
