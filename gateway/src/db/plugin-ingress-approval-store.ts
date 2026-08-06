/** Store for guardian approvals of plugin-declared public ingress routes. */

import { eq } from "drizzle-orm";

import { getGatewayDb } from "./connection.js";
import { pluginIngressApprovals } from "./schema.js";

export interface PluginIngressApproval {
  plugin: string;
  digest: string;
  approvedAt: number;
  approvedBy: string | null;
}

/** Every current approval, one per plugin. */
export function listPluginIngressApprovals(): PluginIngressApproval[] {
  return getGatewayDb().select().from(pluginIngressApprovals).all();
}

/** The approval for `plugin`, or undefined when it has none. */
export function getPluginIngressApproval(
  plugin: string,
): PluginIngressApproval | undefined {
  return getGatewayDb()
    .select()
    .from(pluginIngressApprovals)
    .where(eq(pluginIngressApprovals.plugin, plugin))
    .get();
}

export interface ApprovePluginIngressInput {
  plugin: string;
  /** Digest of the declaration being approved. */
  digest: string;
  /** Guardian principal granting it; omitted for out-of-band grants. */
  approvedBy?: string | null;
}

/**
 * Grant `plugin` the declaration identified by `digest`.
 *
 * Replaces any existing row, so a plugin is never approved for two
 * declarations at once: approving a new manifest revokes the previous
 * grant in the same write.
 */
export function approvePluginIngress(
  input: ApprovePluginIngressInput,
): PluginIngressApproval {
  const row: PluginIngressApproval = {
    plugin: input.plugin,
    digest: input.digest,
    approvedAt: Date.now(),
    approvedBy: input.approvedBy ?? null,
  };
  getGatewayDb()
    .insert(pluginIngressApprovals)
    .values(row)
    .onConflictDoUpdate({
      target: pluginIngressApprovals.plugin,
      set: {
        digest: row.digest,
        approvedAt: row.approvedAt,
        approvedBy: row.approvedBy,
      },
    })
    .run();
  return row;
}

/** Drop `plugin`'s approval. Returns true when a row was removed. */
export function revokePluginIngressApproval(plugin: string): boolean {
  if (getPluginIngressApproval(plugin) === undefined) {
    return false;
  }
  getGatewayDb()
    .delete(pluginIngressApprovals)
    .where(eq(pluginIngressApprovals.plugin, plugin))
    .run();
  return true;
}
