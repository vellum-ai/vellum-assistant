/**
 * Types extracted from conversation-tool-setup.ts to break the
 * tool-setup ↔ doordash-steps and tool-setup ↔ tool-side-effects cycles.
 */

import type { InterfaceId } from "../channels/types.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
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
  /** Voice/call session ID, if the conversation originates from a call. Propagated into ToolContext for scoped grant consumption. */
  callSessionId?: string;
  /** The interface ID of the connected client driving the current turn (e.g. "macos", "chrome-extension"). Propagated into ToolContext for browser backend selection. */
  readonly transportInterface?: InterfaceId;

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
   * Set by the `switch_inference_profile` tool when the model self-selects a
   * different profile mid-turn. Read by `readCurrentOverrideProfile` in the
   * agent loop so the next LLM call uses the switched profile. Reset at
   * turn start.
   */
  toolRoutedProfile?: string;
}
