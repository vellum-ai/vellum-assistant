/**
 * Types extracted from conversation-tool-setup.ts to break the
 * tool-setup ↔ doordash-steps and tool-setup ↔ tool-side-effects cycles.
 */

import type { InterfaceId } from "../channels/types.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import type { ExecutionTarget } from "../tools/tool-types.js";
import type { SurfaceConversationContext } from "./conversation-surfaces.js";
import type { TrustContext } from "./trust-context.js";

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
 * tools (`host_*`, `ui_*`, `app_open`, `request_system_permission`) from
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

/**
 * Subset of Conversation state that the tool executor callback reads at
 * call time (not construction time). These are captured by the
 * returned closure, so they must be live references.
 */
export interface ToolSetupContext extends SurfaceConversationContext {
  readonly conversationId: string;
  assistantId?: string;
  currentRequestId?: string;
  workingDir: string;
  abortController: AbortController | null;
  /** When set, only tools in this set may execute during the current turn. */
  allowedToolNames?: Set<string>;
  /**
   * Sandbox/host target per tool name as resolved into the current turn's wire
   * definitions. Written by the resolver alongside {@link allowedToolNames} and
   * read by the executor callback so a tool's execution target is the one the
   * model was shown, not a re-lookup that could race a mid-turn registry swap.
   */
  currentTurnToolExecutionTargets?: ReadonlyMap<string, ExecutionTarget>;
  /** When set, the subagent/wake tool allowlist (see {@link subagentToolGateMode}). */
  subagentAllowedTools?: Set<string>;
  /**
   * How {@link subagentAllowedTools} is enforced. Absent or `"wire"` keeps
   * the historical behavior (definitions filtered before the provider
   * request); `"execution"` keeps the full tool surface on the wire and
   * rejects non-allowlisted calls in the executor callback instead.
   */
  subagentToolGateMode?: SubagentToolGateMode;
  /** Turn-scoped disk-pressure cleanup mode flag. */
  diskPressureCleanupModeActive?: boolean;
  /** True when the conversation has no connected client (HTTP-only path). */
  hasNoClient?: boolean;
  /** When true, the conversation is executing a task run and must not become interactive. */
  headlessLock?: boolean;
  /** When set, this conversation is executing a task run. Used to retrieve ephemeral permission rules. */
  taskRunId?: string;
  /** Guardian runtime context for the conversation — trustClass is propagated into ToolContext for control-plane policy enforcement. */
  trustContext?: TrustContext;
  /** Per-turn trust snapshot, captured at turn start. Preferred over the live
   *  `trustContext` for mid-turn trust decisions (tool approval, control-plane
   *  policy) so a concurrent mutation cannot elevate the in-flight turn. */
  currentTurnTrustContext?: TrustContext;
  /** Voice/call session ID, if the conversation originates from a call. Propagated into ToolContext for scoped grant consumption. */
  callSessionId?: string;
  /** The interface ID of the connected client driving the current turn (e.g. "macos", "chrome-extension"). Propagated into ToolContext for browser backend selection. */
  readonly transportInterface?: InterfaceId;
  /**
   * The conversation's per-chat plugin scope (mirrors
   * {@link Conversation.enabledPlugins}). `null`/absent means no per-chat
   * restriction. Read per tool call to derive the effective enabled-plugin set
   * (via `getEffectiveEnabledPluginSet`) for the `ToolContext.enabledPluginSet`
   * field and the `skill_execute` dispatch guard.
   */
  readonly enabledPlugins?: string[] | null;

  /** Turn-scoped flag: true when any tool call in the current turn received explicit user approval via interactive prompt. Cleared at turn end. */
  approvedViaPromptThisTurn?: boolean;
  /**
   * When true, side-effect tools must prompt for confirmation even if a
   * trust/allow rule would auto-allow them. Set by callers without an
   * interactive approval UI (e.g. non-guardian phone voice turns) to force
   * a `confirmation_request` event that the caller's auto-deny / scoped-grant
   * handler can intercept. Provides a second layer of defense against broad
   * trust rules auto-executing side-effect tools in non-interactive contexts.
   */
  forcePromptSideEffects?: boolean;
  /**
   * The LLM call site driving the current turn, set by `runAgentLoopImpl`
   * (`options.callSite ?? "mainAgent"`). Non-main turns (voice `callAgent`,
   * `filingAgent`, …) resolve different provider/model/profile config, so
   * tool telemetry attribution must use this rather than assuming
   * `mainAgent`. Absent before the first turn starts.
   */
  currentCallSite?: LLMCallSite;
  /**
   * Per-turn snapshot of the resolved inference-profile override, set by
   * `runAgentLoopImpl`. Propagated into `ToolContext.overrideProfile` so
   * tools that spawn nested invocations (e.g. `subagent_spawn`) can forward
   * the override without round-tripping through a row read that would
   * return `undefined` for the in-flight (background) subagent.
   */
  currentTurnOverrideProfile?: string;
  /**
   * Whether the current turn has no human present to answer clarification
   * prompts. Resolved once per turn by the agent loop — honoring an explicit
   * per-run `isInteractive` option (e.g. scheduled/background turns) over the
   * live client state — so tool execution sees turn-level interactivity rather
   * than re-deriving it from `hasNoClient`/`headlessLock`, which would read a
   * scheduled turn running on a client-attached conversation as interactive.
   */
  currentTurnIsNonInteractive?: boolean;
  /**
   * Origin tag of the current turn (the conversation's `TitleOrigin`, e.g.
   * "memory_consolidation"), set by `runAgentLoop` from its `requestOrigin`
   * option. Propagated into `ToolContext.requestOrigin` so the permission
   * checker can scope narrow non-interactive auto-grants to a specific
   * internal background origin. Absent for normal interactive turns.
   */
  currentTurnRequestOrigin?: string;
}
