/**
 * Derivation of channel-permission cell coordinates from a PolicyContext.
 *
 * Kept as a leaf module (no config, registry, or IPC imports) so every
 * consumer of the threshold cascade — the permission checker hot path, the
 * tool-executor's PermissionChecker re-reads, and route-level consent gates
 * like the workflow-resume gate — derives identical coordinates from one
 * place. A threshold read that skips the cell can silently apply a looser
 * global than the cell intends, so all of them must build the query here.
 */

import {
  isChannelConversationType,
  isTrustClass,
  type ResolveChannelPermissionRequest,
} from "@vellumai/gateway-client";

import type { PolicyContext } from "./types.js";

/**
 * The fields a cell query is derived from — a subset of {@link PolicyContext}
 * so a caller holding only a turn's channel coordinates (the sensitive-tool
 * gate, which runs before a policy context exists) can build the same query.
 */
export type ChannelPermissionCoordinates = Pick<
  PolicyContext,
  | "sourceChannel"
  | "trustClass"
  | "channelConversationType"
  | "channelExternalId"
>;

/**
 * Build the permission-matrix cell query for a permission decision: the
 * channel coordinates of the turn plus the actor's contact-type. Returns
 * undefined when the turn has no channel coordinates (e.g. an internal job
 * with no source channel) or the trust class isn't a recognized
 * contact-type — the threshold cascade then skips the matrix and resolves
 * from the conversation override / global defaults as before.
 */
export function buildChannelPermissionCellQuery(
  policyContext?: ChannelPermissionCoordinates,
): ResolveChannelPermissionRequest | undefined {
  const adapter = policyContext?.sourceChannel;
  const trustClass = policyContext?.trustClass;
  if (!adapter || !trustClass || !isTrustClass(trustClass)) {
    return undefined;
  }
  return {
    adapter,
    channelType: isChannelConversationType(
      policyContext.channelConversationType,
    )
      ? policyContext.channelConversationType
      : undefined,
    channelExternalId: policyContext.channelExternalId || undefined,
    contactType: trustClass,
  };
}
