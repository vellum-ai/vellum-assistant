/**
 * Route handlers for channel readiness endpoints.
 *
 * GET   /v1/channels/readiness          — get channel readiness snapshots
 * POST  /v1/channels/readiness/refresh  — invalidate cache and refresh readiness
 */

import { z } from "zod";

import type { ChannelId } from "../../channels/types.js";
import { getReadinessService } from "../../daemon/handlers/config-channels.js";
import {
  getInviteAdapterRegistry,
  resolveAdapterHandle,
} from "../channel-invite-transport.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

async function enrichSnapshots(
  snapshots: Awaited<
    ReturnType<ReturnType<typeof getReadinessService>["getReadiness"]>
  >,
) {
  const adapterRegistry = getInviteAdapterRegistry();
  return Promise.all(
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
}

/**
 * GET /v1/channels/readiness
 */
export async function handleGetChannelReadiness({
  queryParams = {},
}: RouteHandlerArgs) {
  const channel = (queryParams.channel as ChannelId | undefined) ?? undefined;
  const includeRemote = queryParams.includeRemote !== "false";

  const service = getReadinessService();
  const snapshots = await service.getReadiness(channel, includeRemote);
  const enriched = await enrichSnapshots(snapshots);

  return { success: true, snapshots: enriched };
}

/**
 * POST /v1/channels/readiness/refresh
 */
export async function handleRefreshChannelReadiness({
  body = {},
}: RouteHandlerArgs) {
  const channel = (body.channel as ChannelId | undefined) ?? undefined;
  const includeRemote =
    body.includeRemote !== undefined ? Boolean(body.includeRemote) : true;

  const service = getReadinessService();

  if (channel) {
    service.invalidateChannel(channel);
  } else {
    service.invalidateAll();
  }

  const snapshots = await service.getReadiness(channel, includeRemote);
  const enriched = await enrichSnapshots(snapshots);

  return { success: true, snapshots: enriched };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "channels_readiness_get",
    endpoint: "channels/readiness",
    method: "GET",
    summary: "Get channel readiness",
    description: "Return readiness snapshots for one or all channels.",
    tags: ["channels"],
    requirePolicyEnforcement: true,
    handler: handleGetChannelReadiness,
    queryParams: [
      {
        name: "channel",
        schema: { type: "string" },
        description: "Optional channel ID filter",
      },
      {
        name: "includeRemote",
        schema: { type: "string" },
        description: "Include remote checks (default true)",
      },
    ],
    responseBody: z.object({
      success: z.boolean(),
      snapshots: z.array(z.unknown()).describe("Channel readiness snapshots"),
    }),
  },
  {
    operationId: "channels_readiness_refresh_post",
    endpoint: "channels/readiness/refresh",
    method: "POST",
    summary: "Refresh channel readiness",
    description: "Invalidate cache and re-evaluate channel readiness.",
    tags: ["channels"],
    requirePolicyEnforcement: true,
    handler: handleRefreshChannelReadiness,
    requestBody: z.object({
      channel: z.string().describe("Optional channel ID to refresh"),
      includeRemote: z
        .boolean()
        .describe("Include remote checks (default true)"),
    }),
    responseBody: z.object({
      success: z.boolean(),
      snapshots: z
        .array(z.unknown())
        .describe("Refreshed readiness snapshots"),
    }),
  },
];
