/**
 * Shared host-proxy skill preactivation.
 *
 * The capability-to-skill registry lives in `host-proxy-capabilities.ts` so
 * voice routing, tool projection, and preactivation classify host-backed
 * tools from the same source of truth. Proxy instantiation remains at each
 * call site because the proxy constructors take different arguments.
 */

import type { HostProxyCapability, InterfaceId } from "../channels/types.js";
import { supportsHostProxy } from "../channels/types.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";
import { HOST_PROXY_SKILL_PREACTIVATIONS } from "./host-proxy-capabilities.js";

export { HOST_PROXY_SKILL_PREACTIVATIONS } from "./host-proxy-capabilities.js";

const log = getLogger("host-proxy-preactivation");

/**
 * Subset of `Conversation` that `preactivateHostProxySkills` needs.
 */
export interface HostProxyPreactivationTarget {
  readonly conversationId: string;
  addPreactivatedSkillId(id: string): void;
}

/**
 * Why an attachment decision went the way it did. Logged per turn so that
 * silent-gate failures (e.g. ATL-609: computer-use never reaches the LLM
 * surface for a macOS user) can be diagnosed from production logs without
 * extra instrumentation.
 */
export type HostProxyAttachmentReason =
  | "native_support"
  | "cross_client"
  | "denied_no_interface"
  | "denied_chrome_extension"
  | "denied_no_clients";

export interface HostProxyAttachmentDecision {
  shouldAttach: boolean;
  reason: HostProxyAttachmentReason;
  clientCount?: number;
}

/**
 * Returns the full attachment decision for a host-proxy capability — used both
 * to gate proxy instantiation and to feed the structured preactivation log so
 * silent gates can be diagnosed without re-instrumenting after the fact.
 *
 *  1. No source interface → `denied_no_interface`.
 *  2. Source interface natively supports the capability and no actor identity
 *     is available → `native_support` from the interface declaration.
 *  3. `chrome-extension` source can never broker cross-client routing to a
 *     macOS client (security boundary) → `denied_chrome_extension`.
 *  4. At least one connected client advertises the capability →
 *     `cross_client` with `clientCount`.
 *  5. Otherwise → `denied_no_clients` with `clientCount: 0`.
 *
 * Single source of truth for preactivation and proxy instantiation.
 */
/**
 * Capabilities a client asks for on its connection rather than getting from
 * what it is. Each rides the host_cu transport and is answered only by a
 * macOS build new enough to send the header (`events-routes.ts`), so the
 * interface alone cannot say whether one is really there.
 */
const NEGOTIATED_CAPABILITIES: ReadonlySet<HostProxyCapability> = new Set([
  "host_cu_window_capture",
  "host_cu_sequence",
  "host_cu_annotate",
]);

export function evaluateHostProxyAttachment(
  capability: HostProxyCapability,
  sourceInterface: InterfaceId | undefined,
  sourceActorPrincipalId?: string,
): HostProxyAttachmentDecision {
  if (!sourceInterface) {
    return { shouldAttach: false, reason: "denied_no_interface" };
  }
  // A negotiated capability is never taken from the interface table. The
  // table says macOS can draw, which is true of the client that sends the
  // header and false of every build that predates it, and this shortcut does
  // not look at the connection at all. Granting it here offered the skill to
  // an older macOS client whose every point and clear was then refused for
  // having nothing to draw on. Falling through puts it on the same footing as
  // a cross-client grant, where an actual registered client has to advertise
  // it.
  const hasNativeSupport =
    !NEGOTIATED_CAPABILITIES.has(capability) &&
    supportsHostProxy(sourceInterface, capability);
  if (hasNativeSupport && sourceActorPrincipalId == null) {
    return { shouldAttach: true, reason: "native_support" };
  }
  if (sourceInterface === "chrome-extension" && !hasNativeSupport) {
    return { shouldAttach: false, reason: "denied_chrome_extension" };
  }
  if (sourceActorPrincipalId == null) {
    return { shouldAttach: false, reason: "denied_no_clients", clientCount: 0 };
  }
  const sameActorClients = assistantEventHub
    .listClientsByCapability(capability)
    .filter((c) => c.actorPrincipalId === sourceActorPrincipalId);
  if (sameActorClients.length > 0) {
    return {
      shouldAttach: true,
      reason: hasNativeSupport ? "native_support" : "cross_client",
      clientCount: sameActorClients.length,
    };
  }
  return { shouldAttach: false, reason: "denied_no_clients", clientCount: 0 };
}

/**
 * Boolean wrapper retained for the proxy-instantiation call sites that only
 * need the gate result. Prefer `evaluateHostProxyAttachment` when the reason
 * is also useful (e.g. for logging or telemetry).
 */
export function shouldAttachHostProxyForCapability(
  capability: HostProxyCapability,
  sourceInterface: InterfaceId | undefined,
  sourceActorPrincipalId?: string,
): boolean {
  return evaluateHostProxyAttachment(
    capability,
    sourceInterface,
    sourceActorPrincipalId,
  ).shouldAttach;
}

/**
 * Enforce live capability checks when a turn has an authoritative actor
 * decision. A turn without one defers to the caller's transport policy.
 */
export function isHostProxyCapabilityAvailableForTurn(
  capability: HostProxyCapability,
  sourceInterface: InterfaceId | undefined,
  sourceActorPrincipalId?: string,
  actorFallbackSuppressed?: boolean,
): boolean {
  if (actorFallbackSuppressed === true) {
    return false;
  }
  if (sourceActorPrincipalId === undefined) {
    return true;
  }
  return shouldAttachHostProxyForCapability(
    capability,
    sourceInterface,
    sourceActorPrincipalId,
  );
}

/**
 * Preactivate every host-proxy-backed skill that the given source interface
 * supports, and emit one structured `log.info` line per turn capturing each
 * capability's decision + the final preactivated skill IDs.
 *
 * The log line fires unconditionally — even when `sourceInterface` is
 * undefined — because "preactivation never ran because no interface" is
 * itself the diagnostic signal we want visible in production.
 *
 * Callers are responsible for any additional gating (e.g. only preactivating
 * when the conversation is idle vs. when re-adding after dequeue), since
 * those constraints differ across create vs. drain paths.
 */
export function preactivateHostProxySkills(
  conversation: HostProxyPreactivationTarget,
  sourceInterface: InterfaceId | undefined,
  sourceActorPrincipalId?: string,
): void {
  const decisions: Record<string, HostProxyAttachmentDecision> = {};
  const preactivatedSkillIds: string[] = [];

  for (const { capability, skillId } of HOST_PROXY_SKILL_PREACTIVATIONS) {
    const decision = evaluateHostProxyAttachment(
      capability,
      sourceInterface,
      sourceActorPrincipalId,
    );
    decisions[capability] = decision;
    if (decision.shouldAttach) {
      conversation.addPreactivatedSkillId(skillId);
      preactivatedSkillIds.push(skillId);
    }
  }

  log.info(
    {
      conversationId: conversation.conversationId,
      sourceInterface,
      decisions,
      preactivatedSkillIds,
    },
    "host-proxy preactivation decision",
  );
}
