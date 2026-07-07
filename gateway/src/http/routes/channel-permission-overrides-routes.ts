import { z } from "zod";
import {
  ChannelPermissionCellKeySchema,
  ChannelPermissionCellSchema,
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
 * operation, minus resolve (a runtime-evaluator concern, not a
 * configuration read).
 *
 * The handlers live in `channel-permission-overrides.ts`. Delete is a POST
 * verb path (`/delete`) rather than a body-carrying DELETE because cells
 * are identified by a composite key (selector × contact-type), not a row
 * id, and DELETE request bodies are unreliable through proxies.
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
