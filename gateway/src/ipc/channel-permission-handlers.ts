/**
 * IPC route definitions for channel-permission matrix cells.
 *
 * Exposes gateway-owned matrix storage (cascade cell × contact-type →
 * RiskThreshold) to the assistant daemon over the IPC socket: list/set/
 * delete for configuration surfaces, and cascade resolution for the
 * per-tool-call evaluator.
 */

import { z } from "zod";

import {
  ChannelPermissionCellSchema,
  ChannelPermissionSelectorSchema,
  ResolveChannelPermissionRequestSchema,
} from "@vellumai/gateway-client";
import { ChannelPermissionStore } from "../db/channel-permission-store.js";
import { isChannelId } from "../channels/types.js";
import type { IpcRoute } from "./server.js";

const DeleteCellSchema = z.object({
  selector: ChannelPermissionSelectorSchema,
  contactType: ChannelPermissionCellSchema.shape.contactType,
});

/**
 * Selectors carry the adapter as free text in the shared contract (the
 * contract package cannot depend on the gateway channel registry); the
 * write path validates it here so only known adapters are persisted.
 */
function assertKnownAdapter(selector: {
  scope: string;
  adapter?: string;
}): void {
  if (selector.scope === "workspace") return;
  if (!selector.adapter || !isChannelId(selector.adapter)) {
    throw Object.assign(
      new Error(`Unknown channel adapter: ${selector.adapter ?? "(missing)"}`),
      { statusCode: 400, errorCode: "unknown_adapter" },
    );
  }
}

export const channelPermissionRoutes: IpcRoute[] = [
  {
    method: "list_channel_permission_overrides",
    handler: () => {
      const store = new ChannelPermissionStore();
      return { cells: store.list() };
    },
  },
  {
    method: "set_channel_permission_override",
    schema: ChannelPermissionCellSchema,
    handler: (params?: Record<string, unknown>) => {
      const cell = ChannelPermissionCellSchema.parse(params ?? {});
      assertKnownAdapter(cell.selector);
      const store = new ChannelPermissionStore();
      return { cell: store.set(cell) };
    },
  },
  {
    method: "delete_channel_permission_override",
    schema: DeleteCellSchema,
    handler: (params?: Record<string, unknown>) => {
      const parsed = DeleteCellSchema.parse(params ?? {});
      const store = new ChannelPermissionStore();
      return { removed: store.remove(parsed.selector, parsed.contactType) };
    },
  },
  {
    method: "resolve_channel_permission_threshold",
    schema: ResolveChannelPermissionRequestSchema,
    handler: (params?: Record<string, unknown>) => {
      const query = ResolveChannelPermissionRequestSchema.parse(params ?? {});
      const store = new ChannelPermissionStore();
      return { resolved: store.resolve(query) };
    },
  },
];
