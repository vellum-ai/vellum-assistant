/**
 * Route handler for fetching surface content by ID.
 *
 * GET /v1/surfaces/:surfaceId — return the full surface payload from the
 * conversation's in-memory surface state. Used by clients to re-hydrate surfaces
 * whose data was stripped during memory compaction.
 */
import type {
  SurfaceData,
  SurfaceType,
} from "../../daemon/message-types/surfaces.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("surface-content-routes");

/** Narrow interface for looking up surface state from a conversation. */
interface SurfaceContentTarget {
  surfaceState: Map<
    string,
    { surfaceType: SurfaceType; data: SurfaceData; title?: string }
  >;
  currentTurnSurfaces?: Array<{
    surfaceId: string;
    surfaceType: SurfaceType;
    title?: string;
    data: SurfaceData;
    actions?: Array<{ id: string; label: string; style?: string }>;
  }>;
}

export type SurfaceContentConversationLookup = (
  conversationId: string,
) => SurfaceContentTarget | undefined;

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function surfaceContentRouteDefinitions(deps: {
  findConversation?: SurfaceContentConversationLookup;
}): RouteDefinition[] {
  return [
    {
      endpoint: "surfaces/:surfaceId",
      method: "GET",
      handler: ({ url, params }) => {
        if (!deps.findConversation) {
          return httpError(
            "NOT_IMPLEMENTED",
            "Surface content lookup not available",
            501,
          );
        }

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

        const conversation = deps.findConversation(conversationId);
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
