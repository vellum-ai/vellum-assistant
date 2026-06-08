/**
 * Route handler for fetching surface content by ID.
 *
 * GET /v1/surfaces/:surfaceId — return the full surface payload from the
 * conversation's in-memory surface state. Used by clients to re-hydrate
 * surfaces whose data was stripped during memory compaction, or whose
 * owning conversation has been evicted from the daemon's in-memory map
 * (daemon restart, LRU eviction).
 */
import { z } from "zod";

import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import { resolveSurfaceConversation } from "./surface-conversation-resolver.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("surface-content-routes");

// ---------------------------------------------------------------------------
// GET /v1/surfaces/:surfaceId?conversationId=...
// ---------------------------------------------------------------------------

async function handleGetSurfaceContent({
  pathParams = {},
  queryParams = {},
}: RouteHandlerArgs) {
  const conversationId = queryParams.conversationId;
  if (!conversationId) {
    throw new BadRequestError("conversationId query parameter is required");
  }

  const surfaceId = pathParams.surfaceId;
  if (!surfaceId) {
    throw new BadRequestError("surfaceId path parameter is required");
  }

  // Resolve via the shared surface→conversation helper: in-memory first,
  // falling back to a DB scan that rehydrates the conversation when the
  // owning Conversation has been evicted or the daemon was restarted. The
  // DB scan uses the surfaceId itself as the existence check so a stale
  // or made-up conversationId can't materialize a phantom conversation.
  const conversation = await resolveSurfaceConversation(
    conversationId,
    surfaceId,
  );
  if (!conversation) {
    throw new NotFoundError(
      "No active conversation found for this conversationId",
    );
  }

  // Look up the surface in the conversation's in-memory state.
  const stored = conversation.surfaceState.get(surfaceId);
  if (stored) {
    log.info(
      { conversationId, surfaceId },
      "Surface content served from surfaceState",
    );
    return {
      surfaceId,
      surfaceType: stored.surfaceType,
      title: stored.title ?? null,
      data: stored.data,
    };
  }

  // Fall back to currentTurnSurfaces in case the surface hasn't been
  // committed to surfaceState yet (e.g. mid-turn).
  const turnSurface = conversation.currentTurnSurfaces?.find(
    (s) => s.surfaceId === surfaceId,
  );
  if (turnSurface) {
    log.info(
      { conversationId, surfaceId },
      "Surface content served from currentTurnSurfaces",
    );
    return {
      surfaceId,
      surfaceType: turnSurface.surfaceType,
      title: turnSurface.title ?? null,
      data: turnSurface.data,
    };
  }

  throw new NotFoundError("Surface not found in conversation");
}

// ---------------------------------------------------------------------------
// Route definitions (shared HTTP + IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "surfaces_get_content",
    endpoint: "surfaces/:surfaceId",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get surface content",
    description:
      "Return the full surface payload from the conversation's in-memory surface state.",
    tags: ["surfaces"],
    queryParams: [
      {
        name: "conversationId",
        schema: { type: "string" },
        required: true,
        description: "Conversation that owns the surface",
      },
    ],
    responseBody: z.object({
      surfaceId: z.string(),
      surfaceType: z.string(),
      title: z.string().nullable(),
      data: z.object({}).passthrough().describe("Surface data payload"),
    }),
    handler: handleGetSurfaceContent,
  },
];
