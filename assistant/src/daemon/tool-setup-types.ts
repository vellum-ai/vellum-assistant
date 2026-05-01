/**
 * Types extracted from conversation-tool-setup.ts to break the
 * tool-setup ↔ doordash-steps and tool-setup ↔ tool-side-effects cycles.
 */

import type { InterfaceId } from "../channels/types.js";
import type { CesClient } from "../credential-execution/client.js";
import type { SurfaceConversationContext } from "./conversation-surfaces.js";
import type { TrustContext } from "./trust-context.js";

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
  /** Conversation memory policy used to propagate scopeId into ToolContext. */
  memoryPolicy: { scopeId: string };
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
  /** CES RPC client for credential execution operations. Injected when CES tools are enabled and the CES process is available. */
  cesClient?: CesClient;
  /** The interface ID of the connected client driving the current turn (e.g. "macos", "chrome-extension"). Propagated into ToolContext for browser backend selection. */
  readonly transportInterface?: InterfaceId;

  /** Turn-scoped flag: true when any tool call in the current turn received explicit user approval via interactive prompt. Cleared at turn end. */
  approvedViaPromptThisTurn?: boolean;
  /**
   * Per-turn snapshot of the resolved inference-profile override, set by
   * `runAgentLoopImpl`. Propagated into `ToolContext.overrideProfile` so
   * tools that spawn nested invocations (e.g. `subagent_spawn`) can forward
   * the override without round-tripping through a row read that would
   * return `undefined` for the in-flight (background) subagent.
   */
  currentTurnOverrideProfile?: string;
}
