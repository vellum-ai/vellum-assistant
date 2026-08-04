/**
 * Types extracted from conversation-tool-setup.ts to break the
 * tool-setup ↔ doordash-steps and tool-setup ↔ tool-side-effects cycles.
 */

import type { InterfaceId } from "../channels/types.js";

/**
 * How a subagent/wake tool allowlist is enforced.
 *
 * - `"wire"` (default): filter the tool definitions sent to the provider so
 *   the model never sees non-allowlisted tools. Smaller request, but the
 *   tool array no longer byte-matches the conversation's normal turns, so
 *   the provider prompt-cache prefix (`tools → system → messages`) cannot
 *   be reused.
 * - `"execution"`: keep the conversation's full tool surface on the wire
 *   (preserving cache parity with the source conversation's turns) and
 *   enforce the allowlist at execution time — a call to a non-allowlisted
 *   tool returns an error tool_result without ever invoking the tool's
 *   executor.
 */
export type SubagentToolGateMode = "wire" | "execution";

/**
 * Client-context inputs frozen for tool-DEFINITION resolution during a wake
 * that runs with `subagentToolGateMode: "execution"`.
 *
 * Execution gate mode exists to keep the wire tool array byte-identical to
 * the source conversation's live turns (see {@link SubagentToolGateMode}),
 * but the definitions themselves are resolved from the live context: a
 * fork-retrospective wake hydrates clientless (`hasNoClient = true`, no
 * transport interface, no channel capabilities), which drops client-gated
 * tools (`host_*`, `ui_*`, `ask_question`, `request_system_permission`) from
 * the wire definitions and breaks the cache prefix anyway. When this pin is
 * set on the conversation, `isToolActiveForContext` reads `hasNoClient` and
 * `transportInterface` exclusively from the pin and treats channel
 * capabilities as unset — an absent optional field pins the value to
 * `undefined`; there is no fall-through to the live conversation state.
 * (Interactive-interface turns never set channel capabilities, so unset IS
 * parity for desktop/web sources; channel-routed sources resolve every tool
 * gate identically under `hasNoClient: true` with or without them.)
 *
 * Tool-definition resolution ONLY. The executor callback and host-proxy
 * attachment paths never read the pin, so it cannot make a host tool
 * runnable: in execution gate mode every non-allowlisted call is rejected
 * before its executor runs, so a pinned-in tool can appear on the wire but
 * can never execute.
 */
export interface WakeToolContextPin {
  /** The source conversation's live-turn `hasNoClient` value. */
  hasNoClient: boolean;
  /** The interface the source's live turns ran on (e.g. `"macos"`). */
  transportInterface?: InterfaceId;
  /**
   * Origin tag stamped onto `ToolContext.requestOrigin` for the duration of
   * the wake (e.g. `"memory_retrospective"`). Wakes bypass `runAgentLoopImpl`,
   * which is what normally sets `currentTurnRequestOrigin`, so the pin carries
   * the origin through to `buildPolicyContext` → the permission checker's
   * origin-scoped auto-grants. Applied and restored alongside the allowlist by
   * `scopeWakeAllowedTools`. Unset for wakes that need no origin-scoped grant.
   */
  requestOrigin?: string;
}
