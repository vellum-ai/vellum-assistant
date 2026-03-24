/**
 * Route handlers for channel readiness endpoints.
 *
 * GET   /v1/channels/readiness          — get channel readiness snapshots
 * POST  /v1/channels/readiness/refresh  — invalidate cache and refresh readiness
 */

import type { ChannelId } from "../../channels/types.js";
import { getReadinessService } from "../../daemon/handlers/config-channels.js";
import {
  getInviteAdapterRegistry,
  resolveAdapterHandle,
} from "../channel-invite-transport.js";
import type { RouteDefinition } from "../http-router.js";

/**
 * GET /v1/channels/readiness
 *
 * Query params: channel? (optional ChannelId), includeRemote? (optional boolean)
 */
export async function handleGetChannelReadiness(url: URL): Promise<Response> {
  const channel =
    (url.searchParams.get("channel") as ChannelId | null) ?? undefined;
  // Default to including remote checks — they're cached for 5 minutes and
  // required for accurate readiness (e.g. email inbox existence).
  const includeRemote = url.searchParams.get("includeRemote") !== "false";

  const service = getReadinessService();
  const snapshots = await service.getReadiness(channel, includeRemote);
  const adapterRegistry = getInviteAdapterRegistry();

  const enriched = await Promise.all(
    snapshots.map(async (s) => {
      const adapter = adapterRegistry.get(s.channel);
      const channelHandle = adapter
        ? await resolveAdapterHandle(adapter)
        : undefined;
      return {
        channel: s.channel,
        ready: s.ready,
        setupStatus: s.setupStatus,
        checkedAt: s.checkedAt,
        stale: s.stale,
        reasons: s.reasons,
        localChecks: s.localChecks,
        remoteChecks: s.remoteChecks,
        channelHandle,
      };
    }),
  );

  return Response.json({
    success: true,
    snapshots: enriched,
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
  let body: { channel?: ChannelId; includeRemote?: boolean };
  const text = await req.text();
  if (!text.trim()) {
    body = {};
  } else {
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      return Response.json(
        { success: false, error: "Invalid JSON in request body" },
        { status: 400 },
      );
    }
  }

  const service = getReadinessService();

  // Invalidate cache before fetching
  if (body.channel) {
    service.invalidateChannel(body.channel);
  } else {
    service.invalidateAll();
  }

  const snapshots = await service.getReadiness(
    body.channel,
    body.includeRemote ?? true,
  );
  const adapterRegistry = getInviteAdapterRegistry();

  const enriched = await Promise.all(
    snapshots.map(async (s) => {
      const adapter = adapterRegistry.get(s.channel);
      const channelHandle = adapter
        ? await resolveAdapterHandle(adapter)
        : undefined;
      return {
        channel: s.channel,
        ready: s.ready,
        setupStatus: s.setupStatus,
        checkedAt: s.checkedAt,
        stale: s.stale,
        reasons: s.reasons,
        localChecks: s.localChecks,
        remoteChecks: s.remoteChecks,
        channelHandle,
      };
    }),
  );

  return Response.json({
    success: true,
    snapshots: enriched,
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
