/**
 * Gate for the `send_user_message` tool surface.
 *
 * When the `send-user-message` flag is on, a main-agent turn's plain
 * assistant text is a private scratchpad the user never sees and the
 * `send_user_message` tool is the only channel that reaches them.
 *
 * Import this module only where the gate is evaluated at runtime: it reaches
 * the feature-flag resolver and, through it, the gateway IPC client. A module
 * that only needs the tool's name imports
 * {@link ./send-user-message-constants.js} instead, which has no imports at
 * all. Both names are re-exported here so a runtime evaluator reads one module.
 *
 * The gate is scoped to the main agent. Subagents, live-voice, calls, and
 * background workers resolve their own call sites and keep streamed assistant
 * text, so they never see the tool and their output is never suppressed.
 */

import { isAssistantFeatureFlagEnabled } from "./assistant-feature-flags.js";
import { getConfig } from "./loader.js";
import type { AssistantConfig } from "./schema.js";
import type { LLMCallSite } from "./schemas/llm.js";
import { SEND_USER_MESSAGE_FLAG } from "./send-user-message-constants.js";

export {
  SEND_USER_MESSAGE_FLAG,
  SEND_USER_MESSAGE_TOOL_NAME,
} from "./send-user-message-constants.js";

/** Whether the `send-user-message` flag is on for this assistant. */
export function isSendUserMessageEnabled(config?: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled(SEND_USER_MESSAGE_FLAG, config);
}

/**
 * Flag read for call sites that hold no config. Never throws: a config that
 * cannot be loaded reads as off, which is the shipped behavior (streamed
 * assistant text).
 */
export function isSendUserMessageFlagOn(): boolean {
  try {
    return isSendUserMessageEnabled(getConfig());
  } catch {
    return false;
  }
}

/**
 * The turn shape the gate needs: the call site the turn resolves to and
 * whether the conversation is running as a subagent.
 */
export interface SendUserMessageTurnScope {
  currentCallSite?: LLMCallSite;
  isSubagent?: boolean;
}

/**
 * Whether this turn routes its user-facing text through the tool: the flag is
 * on, the conversation is not a subagent, and the turn resolves to the
 * `mainAgent` call site. Every other call site (subagent spawns, calls and
 * live-voice legs, heartbeat and memory workers) keeps today's behavior.
 *
 * A turn with no resolved call site is a main-agent turn: `mainAgent` is what
 * the loop defaults to when a caller supplies none.
 */
export function isSendUserMessageTurnScope(
  scope: SendUserMessageTurnScope,
): boolean {
  return (
    scope.isSubagent !== true &&
    (scope.currentCallSite ?? "mainAgent") === "mainAgent"
  );
}

/** {@link isSendUserMessageTurnScope} with the flag read folded in. */
export function isSendUserMessageActiveForTurn(
  scope: SendUserMessageTurnScope,
): boolean {
  return isSendUserMessageTurnScope(scope) && isSendUserMessageFlagOn();
}

/**
 * The turn's answer, taken from the snapshot the turn runner pinned at turn
 * start. Every consumer inside a live turn (tool availability, the reserved
 * row's marker, the prompt section) reads this rather than the flag, so a
 * remote flag change mid-turn cannot contradict the loop's own suppression,
 * which is fixed for the run. Falls back to a live evaluation for callers
 * outside a turn, where there is no snapshot to honor.
 */
export function resolveSendUserMessageActive(
  scope: SendUserMessageTurnScope & {
    currentTurnSendUserMessageActive?: boolean;
  },
): boolean {
  return (
    scope.currentTurnSendUserMessageActive ??
    isSendUserMessageActiveForTurn(scope)
  );
}
