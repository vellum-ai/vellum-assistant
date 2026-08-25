/**
 * Route handlers for channel readiness endpoints.
 *
 * GET   /v1/channels/readiness          — get channel readiness snapshots
 * POST  /v1/channels/readiness/refresh  — invalidate cache and refresh readiness
 */

import { z } from "zod";

import { CHANNEL_IDS, type ChannelId } from "../../channels/types.js";
import { getReadinessService } from "../../daemon/handlers/config-channels.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  getInviteAdapterRegistry,
  resolveAdapterHandle,
} from "../channel-invite-transport.js";
import {
  CHANNEL_HEALTHS,
  CHECK_KINDS,
  SETUP_STATUSES,
} from "../channel-readiness-types.js";
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
        health: s.health,
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
async function handleGetChannelReadiness({
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
async function handleRefreshChannelReadiness({ body = {} }: RouteHandlerArgs) {
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
// Response schemas (drive OpenAPI spec → codegen → typed SDK)
// ---------------------------------------------------------------------------

const readinessCheckSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  message: z.string().nullable().optional(),
  // `passed` alone cannot say "I could not tell", and dropping this at the
  // boundary is why a client cannot distinguish a channel that is broken from
  // one whose state could not be established.
  indeterminate: z.boolean().optional(),
  kind: z.enum(CHECK_KINDS).optional(),
});

const readinessSnapshotSchema = z.object({
  channel: z.enum(CHANNEL_IDS),
  ready: z.boolean(),
  setupStatus: z.enum(SETUP_STATUSES).nullable().optional(),
  health: z.enum(CHANNEL_HEALTHS).optional(),
  checkedAt: z.number().nullable().optional(),
  stale: z.boolean().optional(),
  reasons: z.array(z.object({ code: z.string(), text: z.string() })).optional(),
  localChecks: z.array(readinessCheckSchema).optional(),
  remoteChecks: z.array(readinessCheckSchema).optional(),
  channelHandle: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "channels_readiness_get",
    endpoint: "channels/readiness",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get channel readiness",
    description: "Return readiness snapshots for one or all channels.",
    tags: ["channels"],
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
      snapshots: z
        .array(readinessSnapshotSchema)
        .describe("Channel readiness snapshots"),
    }),
  },
  {
    operationId: "channels_readiness_refresh_post",
    endpoint: "channels/readiness/refresh",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Refresh channel readiness",
    description: "Invalidate cache and re-evaluate channel readiness.",
    tags: ["channels"],
    handler: handleRefreshChannelReadiness,
    requestBody: z.object({
      channel: z
        .enum(CHANNEL_IDS)
        .optional()
        .describe("Optional channel ID to refresh"),
      includeRemote: z
        .boolean()
        .optional()
        .describe("Include remote checks (default true)"),
    }),
    responseBody: z.object({
      success: z.boolean(),
      snapshots: z
        .array(readinessSnapshotSchema)
        .describe("Refreshed readiness snapshots"),
    }),
  },
];
