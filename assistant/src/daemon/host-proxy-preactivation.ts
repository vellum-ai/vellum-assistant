/**
 * Shared host-proxy skill preactivation registry.
 *
 * Several call sites need to mark host-proxy-backed skills as preactivated
 * for a turn whenever the source interface supports the corresponding
 * `HostProxyCapability`:
 *
 *   - `runtime/routes/conversation-routes.ts` (create path, /v1/messages)
 *   - `daemon/process-message.ts` (create path, prepareConversationForMessage)
 *   - `daemon/conversation-process.ts` `drainSingleMessage` (re-add after dequeue)
 *   - `daemon/conversation-process.ts` `drainBatch` (re-add after dequeue)
 *
 * The create paths additionally instantiate the proxy itself; that
 * instantiation logic is per-proxy-class and stays inline at each create
 * site (constructors take different argument shapes — `HostCuProxy()` vs
 * `HostAppControlProxy(conversationId)`). This module owns only the
 * capability-to-skill mapping and the preactivation step. Adding a new
 * host-proxy-backed skill is a one-line registry change here instead of
 * touching all four call sites.
 *
 * Why a registry instead of repeated branches: each new host-proxy-backed
 * skill that ships (e.g. a future `host_focus` capability with a `focus`
 * skill) would otherwise add four near-identical `if (supportsHostProxy(...))
 * conversation.addPreactivatedSkillId("...")` blocks across these files.
 * Centralizing the list makes the contract obvious and prevents drift
 * where one call site re-adds a skill but another forgets to.
 */

import type { HostProxyCapability, InterfaceId } from "../channels/types.js";
import { supportsHostProxy } from "../channels/types.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";

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
 * Registry mapping each host-proxy capability to the skill that must be
 * preactivated when that capability is supported by the source interface.
 *
 * Keep this list in sync with `HostProxyCapability` for any capability that
 * has a corresponding bundled skill.
 *
 * Capabilities NOT listed here:
 *  - `host_bash`, `host_file` — these are surfaced as built-in tools rather
 *    than skills, so there is nothing to preactivate.
 *  - `host_browser` — the browser proxy is provisioned via the assistant
 *    event hub for chrome-extension and its skill projection is governed by
 *    a different code path (`host-browser-proxy.ts`).
 */
export const HOST_PROXY_SKILL_PREACTIVATIONS: ReadonlyArray<{
  capability: HostProxyCapability;
  skillId: string;
}> = [
  { capability: "host_cu", skillId: "computer-use" },
  { capability: "host_app_control", skillId: "app-control" },
];

/**
 * Returns the full attachment decision for a host-proxy capability — used both
 * to gate proxy instantiation and to feed the structured preactivation log so
 * silent gates can be diagnosed without re-instrumenting after the fact.
 *
 *  1. No source interface → `denied_no_interface`.
 *  2. Source interface natively supports the capability → `native_support`.
 *  3. `chrome-extension` source can never broker cross-client routing to a
 *     macOS client (security boundary) → `denied_chrome_extension`.
 *  4. At least one connected client advertises the capability →
 *     `cross_client` with `clientCount`.
 *  5. Otherwise → `denied_no_clients` with `clientCount: 0`.
 *
 * Single source of truth for preactivation and proxy instantiation.
 */
export function evaluateHostProxyAttachment(
  capability: HostProxyCapability,
  sourceInterface: InterfaceId | undefined,
  sourceActorPrincipalId?: string,
): HostProxyAttachmentDecision {
  if (!sourceInterface) {
    return { shouldAttach: false, reason: "denied_no_interface" };
  }
  if (supportsHostProxy(sourceInterface, capability)) {
    return { shouldAttach: true, reason: "native_support" };
  }
  if (sourceInterface === "chrome-extension") {
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
      reason: "cross_client",
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
