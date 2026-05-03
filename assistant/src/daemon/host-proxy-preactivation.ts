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

/**
 * Subset of Conversation/ProcessConversationContext that
 * `preactivateHostProxySkills` needs. Both `Conversation` and
 * `ProcessConversationContext` satisfy this structurally.
 */
export interface HostProxyPreactivationTarget {
  addPreactivatedSkillId(id: string): void;
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
 * Preactivate every host-proxy-backed skill that the given source interface
 * supports. No-op when `sourceInterface` is undefined.
 *
 * Callers are responsible for any additional gating (e.g. only preactivating
 * when the conversation is idle vs. when re-adding after dequeue), since
 * those constraints differ across create vs. drain paths. This helper just
 * iterates the registry and dispatches.
 */
export function preactivateHostProxySkills(
  conversation: HostProxyPreactivationTarget,
  sourceInterface: InterfaceId | undefined,
): void {
  if (!sourceInterface) return;
  for (const { capability, skillId } of HOST_PROXY_SKILL_PREACTIVATIONS) {
    if (supportsHostProxy(sourceInterface, capability)) {
      conversation.addPreactivatedSkillId(skillId);
    }
  }
}
