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
import { resolveCapabilities } from "../capabilities.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import {
  findPersistedSurfaceState,
  resolveSurfaceConversation,
} from "./surface-conversation-resolver.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";
import { resolveVellumActorTrustContext } from "./vellum-actor-trust.js";

const log = getLogger("surface-content-routes");

// ---------------------------------------------------------------------------
// GET /v1/surfaces/:surfaceId?conversationId=...
// ---------------------------------------------------------------------------

async function handleGetSurfaceContent({
  pathParams = {},
  queryParams = {},
  headers = {},
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

  // Fall back to persisted history. A surface appended out-of-band
  // (`addMessage` against an already-loaded conversation — the memory
  // retrospective's skill card) lands in the messages table without
  // touching the live object's `surfaceState`, which is only rebuilt on
  // construction. Without this rung the lookup 404s exactly while the
  // conversation is loaded and works again after eviction. Memoize the hit
  // so later fetches, action routing, and `findConversationBySurfaceId`
  // resolve in-memory — the same O(1) registration that helper already
  // performs; no DB state is written on this GET.
  // Provenance is scoped to the REQUESTER, not to whatever trust class the
  // cached conversation happens to be loaded under — a guardian-loaded view
  // must not leak a guardian-provenance row to a non-guardian actor who
  // names its surface id. Resolved read-only (no reset-drift repair): safe
  // methods stay side-effect-free, and an unhealed drift just fail-closes
  // to the untrusted filter until a mutating route heals it.
  const requesterTrust = await resolveVellumActorTrustContext(
    headers["x-vellum-actor-principal-id"],
  );
  const persisted = findPersistedSurfaceState(conversationId, surfaceId, {
    // Share the live window's compaction boundary so the scan can never
    // resurrect (and memoize) a surface the compacted-away prefix owned.
    liveHistoryStartRow: conversation.contextCompactedMessageCount,
    requesterCanAccessMemory: resolveCapabilities(requesterTrust.trustClass)
      .canAccessMemory,
  });
  if (persisted) {
    // Memoize only when the row belongs in the LOADED view's scope: writing
    // a guardian-only payload into an actor-scoped `surfaceState` would let
    // a later untrusted fetch read it straight off the fast path.
    const viewCanAccessMemory = resolveCapabilities(
      conversation.loadedHistoryTrustClass,
    ).canAccessMemory;
    if (viewCanAccessMemory || persisted.visibleToUntrustedActor) {
      conversation.surfaceState.set(surfaceId, persisted.state);
    }
    log.info(
      { conversationId, surfaceId },
      "Surface content served from persisted history",
    );
    return {
      surfaceId,
      surfaceType: persisted.state.surfaceType,
      title: persisted.state.title ?? null,
      data: persisted.state.data,
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
