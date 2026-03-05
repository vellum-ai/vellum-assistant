/**
 * Route handlers for channel readiness endpoints.
 *
 * GET   /v1/channels/readiness          — get channel readiness snapshots
 * POST  /v1/channels/readiness/refresh  — invalidate cache and refresh readiness
 */

import type { ChannelId } from "../../channels/types.js";
import { getReadinessService } from "../../daemon/handlers/config-channels.js";
import { getInviteAdapterRegistry } from "../channel-invite-transport.js";
import type { RouteDefinition } from "../http-router.js";

/**
 * GET /v1/channels/readiness
 *
 * Query params: channel? (optional ChannelId), includeRemote? (optional boolean)
 */
export async function handleGetChannelReadiness(url: URL): Promise<Response> {
  const channel =
    (url.searchParams.get("channel") as ChannelId | null) ?? undefined;
  const includeRemote = url.searchParams.get("includeRemote") === "true";

  const service = getReadinessService();
  const snapshots = await service.getReadiness(channel, includeRemote);
  const adapterRegistry = getInviteAdapterRegistry();

  return Response.json({
    success: true,
    snapshots: snapshots.map((s) => {
      const adapter = adapterRegistry.get(s.channel);
      return {
        channel: s.channel,
        ready: s.ready,
        checkedAt: s.checkedAt,
        stale: s.stale,
        reasons: s.reasons,
        localChecks: s.localChecks,
        remoteChecks: s.remoteChecks,
        channelHandle: adapter?.resolveChannelHandle?.() ?? undefined,
      };
    }),
  });
}

/**
 * POST /v1/channels/readiness/refresh
 *
 * Body: { channel?: ChannelId, includeRemote?: boolean }
 */
export async function handleRefreshChannelReadiness(
  req: Request,
): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    channel?: ChannelId;
    includeRemote?: boolean;
  };

  const service = getReadinessService();

  // Invalidate cache before fetching
  if (body.channel) {
    service.invalidateChannel(body.channel);
  } else {
    service.invalidateAll();
  }

  const snapshots = await service.getReadiness(
    body.channel,
    body.includeRemote,
  );
  const adapterRegistry = getInviteAdapterRegistry();

  return Response.json({
    success: true,
    snapshots: snapshots.map((s) => {
      const adapter = adapterRegistry.get(s.channel);
      return {
        channel: s.channel,
        ready: s.ready,
        checkedAt: s.checkedAt,
        stale: s.stale,
        reasons: s.reasons,
        localChecks: s.localChecks,
        remoteChecks: s.remoteChecks,
        channelHandle: adapter?.resolveChannelHandle?.() ?? undefined,
      };
    }),
  });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function channelReadinessRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "channels/readiness",
      method: "GET",
      handler: async ({ url }) => handleGetChannelReadiness(url),
    },
    {
      endpoint: "channels/readiness/refresh",
      method: "POST",
      handler: async ({ req }) => handleRefreshChannelReadiness(req),
    },
  ];
}
