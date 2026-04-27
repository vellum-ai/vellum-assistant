/**
 * Route handler for fetching surface content by ID.
 *
 * GET /v1/surfaces/:surfaceId — return the full surface payload from the
 * conversation's in-memory surface state. Used by clients to re-hydrate surfaces
 * whose data was stripped during memory compaction.
 */
import { z } from "zod";

import { findConversation } from "../../daemon/conversation-store.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { HTTPRouteDefinition } from "../http-router.js";

const log = getLogger("surface-content-routes");

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function surfaceContentRouteDefinitions(): HTTPRouteDefinition[] {
  return [
    {
      endpoint: "surfaces/:surfaceId",
      method: "GET",
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
        title: z.string(),
        data: z.object({}).passthrough().describe("Surface data payload"),
      }),
      handler: ({ url, params }) => {
        const conversationId = url.searchParams.get("conversationId");
        if (!conversationId) {
          return httpError(
            "BAD_REQUEST",
            "conversationId query parameter is required",
            400,
          );
        }

        const surfaceId = params.surfaceId;
        if (!surfaceId) {
          return httpError(
            "BAD_REQUEST",
            "surfaceId path parameter is required",
            400,
          );
        }

        const conversation = findConversation(conversationId);
        if (!conversation) {
          return httpError(
            "NOT_FOUND",
            "No active conversation found for this conversationId",
            404,
          );
        }

        // Look up the surface in the conversation's in-memory state.
        const stored = conversation.surfaceState.get(surfaceId);
        if (stored) {
          log.info(
            { conversationId, surfaceId },
            "Surface content served from surfaceState",
          );
          return Response.json({
            surfaceId,
            surfaceType: stored.surfaceType,
            title: stored.title ?? null,
            data: stored.data,
          });
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
          return Response.json({
            surfaceId,
            surfaceType: turnSurface.surfaceType,
            title: turnSurface.title ?? null,
            data: turnSurface.data,
          });
        }

        return httpError("NOT_FOUND", "Surface not found in conversation", 404);
      },
    },
  ];
}
