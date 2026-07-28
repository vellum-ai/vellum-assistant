/**
 * IPC route definitions for approving plugin-declared public ingress routes.
 *
 * A plugin declares the routes it wants exposed; only a decision recorded
 * here turns that declaration into a grant the gateway will serve.
 */

import {
  PluginIngressApproveIpcParamsSchema,
  PluginIngressListIpcParamsSchema,
  PluginIngressRevokeIpcParamsSchema,
  type PluginIngressApproveIpcResponse,
  type PluginIngressDeclaration,
  type PluginIngressListIpcResponse,
  type PluginIngressRevokeIpcResponse,
} from "@vellumai/gateway-client/gateway-ipc-contracts";

import { resolvePluginIngress } from "../channels/plugin-ingress-approvals.js";
import { pluginWebhookPath } from "../channels/plugin-ingress.js";
import {
  approvePluginIngress,
  revokePluginIngressApproval,
} from "../db/plugin-ingress-approval-store.js";
import type { IpcRoute } from "./server.js";

/** Shape one resolved declaration for the wire, absolute paths included. */
function toDeclaration(
  plugin: string,
  digest: string,
  approved: boolean,
  routes: readonly {
    path: string;
    kind: "http" | "websocket";
    description: string;
  }[],
): PluginIngressDeclaration {
  return {
    plugin,
    digest,
    approved,
    routes: routes.map((route) => ({
      path: route.path,
      kind: route.kind,
      description: route.description,
      publicPath: pluginWebhookPath(plugin, route.path),
    })),
  };
}

export const pluginIngressRoutes: IpcRoute[] = [
  {
    method: "plugin_ingress_list",
    schema: PluginIngressListIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      PluginIngressListIpcParamsSchema.parse(params);
      const { approved, pending, problems } = resolvePluginIngress();
      const response: PluginIngressListIpcResponse = {
        ok: true,
        declarations: [
          ...approved.map((d) =>
            toDeclaration(d.plugin, d.digest, true, d.routes),
          ),
          ...pending.map((d) =>
            toDeclaration(d.plugin, d.digest, false, d.routes),
          ),
        ],
        problems: problems.map((p) => ({
          plugin: p.plugin,
          reason: p.reason,
        })),
      };
      return response;
    },
  },
  {
    method: "plugin_ingress_approve",
    schema: PluginIngressApproveIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { plugin, digest } =
        PluginIngressApproveIpcParamsSchema.parse(params);

      // Approve only what the plugin currently declares. Without this the
      // caller could record a digest for routes nobody has seen, which
      // would silently activate the moment a manifest happened to match.
      const { approved, pending } = resolvePluginIngress();
      const current = [...approved, ...pending].find(
        (d) => d.plugin === plugin,
      );
      if (!current) {
        throw new Error(`plugin ${plugin} declares no ingress routes`);
      }
      if (current.digest !== digest) {
        throw new Error(
          `digest mismatch for ${plugin}: it currently declares ${current.digest}. ` +
            `Re-read the declaration and approve that.`,
        );
      }

      const row = approvePluginIngress({ plugin, digest });
      const response: PluginIngressApproveIpcResponse = {
        ok: true,
        plugin: row.plugin,
        digest: row.digest,
        approvedAt: row.approvedAt,
      };
      return response;
    },
  },
  {
    method: "plugin_ingress_revoke",
    schema: PluginIngressRevokeIpcParamsSchema,
    handler: (params?: Record<string, unknown>) => {
      const { plugin } = PluginIngressRevokeIpcParamsSchema.parse(params);
      const response: PluginIngressRevokeIpcResponse = {
        ok: true,
        revoked: revokePluginIngressApproval(plugin),
      };
      return response;
    },
  },
];
