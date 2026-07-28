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
  type ResolvedChannelPermission,
  type RiskThreshold,
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

/**
 * Collapse a threshold to the two levels a channel distinguishes for
 * non-guardian contact types: `none` is itself, everything else is `low`.
 * Applied to stored cells and to the global default a cell-less room
 * inherits alike; the picker applies the same collapse for display (web
 * `channelTierBehavesAs`), so a room can never behave wider than the level
 * displayed for it.
 */
export function collapseChannelThresholdForContact(
  threshold: RiskThreshold,
): RiskThreshold {
  return threshold === "none" ? "none" : "low";
}

/**
 * The threshold a cell resolution actually authorizes for a contact type.
 * The single rule every cell consumer applies — the sensitive-tool gate,
 * the threshold cascade, and the pre-prompt refresh — kept in this leaf
 * module so tests that stub the IPC lookup still exercise it.
 *
 * For non-guardian contact types, a resolved cell authorizes its collapsed
 * threshold ({@link collapseChannelThresholdForContact}), and a successful
 * walk with no cell at any level authorizes `noCellDefault` — the room
 * default the caller derives from the owner's global setting, already
 * collapsed. Callers that cannot derive one pass `undefined`, which keeps
 * the caller's fail-safe path in charge.
 *
 * Guardian queries pass through untouched — a resolved cell keeps its raw
 * threshold and no-cell returns `undefined` (fall through to the global
 * thresholds): the channel setting governs other people in the room, never
 * the guardian's own lane.
 *
 * A transport failure (`ok: false`) is `undefined`: an unreachable gateway
 * must never widen what a channel actor may do.
 */
export function effectiveChannelCellThreshold(
  cell:
    | {
        ok: true;
        resolved: Pick<ResolvedChannelPermission, "threshold"> | null;
      }
    | { ok: false },
  contactType: ResolveChannelPermissionRequest["contactType"],
  noCellDefault: RiskThreshold | undefined,
): RiskThreshold | undefined {
  if (!cell.ok) {
    return undefined;
  }
  if (contactType === "guardian") {
    return cell.resolved?.threshold;
  }
  if (!cell.resolved) {
    return noCellDefault;
  }
  return collapseChannelThresholdForContact(cell.resolved.threshold);
}
