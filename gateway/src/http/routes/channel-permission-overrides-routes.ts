import { z } from "zod";
import {
  ChannelPermissionCellKeySchema,
  ChannelPermissionCellSchema,
  ChannelPermissionScopeSchema,
  ResolveChannelPermissionRequestSchema,
  RiskThresholdSchema,
} from "@vellumai/gateway-client";

import type { GatewayRouteDefinition } from "./types.js";

/**
 * OpenAPI route metadata for the channel-permission matrix cell API.
 *
 * These schemas are the codegen source of truth for the generated gateway
 * SDK (see scripts/generate-openapi.ts). Clients consume the operations
 * through the SDK, which targets the assistant-scoped
 * `/v1/assistants/{assistant_id}/channel-permission-overrides/...` routes
 * registered in `index.ts` alongside the flat paths documented here.
 * The cell/selector schemas come from the shared contract in
 * `@vellumai/gateway-client` so gateway, daemon IPC, clients, and spec share
 * one source — the HTTP surface mirrors the IPC surface
 * (`gateway/src/ipc/channel-permission-handlers.ts`) operation for
 * operation, including a read-only resolve so configuration clients can
 * display the effective fall-through without re-implementing the cascade
 * walk client-side (the runtime evaluator keeps using the IPC resolve).
 *
 * The handlers live in `channel-permission-overrides.ts`. Delete and
 * resolve are POST verb paths (`/delete`, `/resolve`) rather than
 * body-carrying DELETE/GET because cells are identified by a composite key
 * (selector × contact-type), not a row id, and request bodies on those
 * verbs are unreliable through proxies.
 */

const ChannelPermissionCellRowSchema = ChannelPermissionCellSchema.extend({
  updatedAt: z.number(),
});

export const ROUTES: GatewayRouteDefinition[] = [
  {
    path: "/v1/channel-permission-overrides",
    method: "get",
    operationId: "channelPermissionOverridesList",
    summary: "List channel-permission matrix cells",
    description:
      "Returns every persisted cell (cascade selector × contact-type → RiskThreshold). Unset cells fall through the cascade; the list contains only explicit overrides.",
    tags: ["channel-permission-overrides"],
    responseBody: z.object({
      cells: z.array(ChannelPermissionCellRowSchema),
    }),
  },
  {
    path: "/v1/channel-permission-overrides",
    method: "put",
    operationId: "channelPermissionOverrideSet",
    summary: "Upsert a channel-permission matrix cell",
    description:
      "Upserts one cell, identified by the selector × contact-type in the body. The adapter must be a known channel id.",
    tags: ["channel-permission-overrides"],
    requestBody: ChannelPermissionCellSchema,
    responseBody: z.object({ cell: ChannelPermissionCellRowSchema }),
  },
  {
    path: "/v1/channel-permission-overrides/resolve",
    method: "post",
    operationId: "channelPermissionResolve",
    summary: "Resolve the effective channel-permission threshold",
    description:
      "Read-only cascade resolution for one coordinate: walks channel → channel_type → adapter → workspace for the given selector keys and contact-type, returning the winning cell's threshold and scope, or null when no cell matches (the caller then falls through to the global thresholds). Same resolver the runtime evaluator uses over IPC.",
    tags: ["channel-permission-overrides"],
    requestBody: ResolveChannelPermissionRequestSchema,
    responseBody: z.object({
      resolved: z
        .object({
          threshold: RiskThresholdSchema,
          scope: ChannelPermissionScopeSchema,
        })
        .nullable(),
    }),
  },
  {
    path: "/v1/channel-permission-overrides/delete",
    method: "post",
    operationId: "channelPermissionOverrideDelete",
    summary: "Delete a channel-permission matrix cell",
    description:
      "Removes one cell by its composite key (selector × contact-type), letting the next cascade tier up win. Returns whether a cell was removed.",
    tags: ["channel-permission-overrides"],
    requestBody: ChannelPermissionCellKeySchema,
    responseBody: z.object({ removed: z.boolean() }),
  },
];
