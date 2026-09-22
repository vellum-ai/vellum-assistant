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
import {
  SEND_USER_MESSAGE_FLAG,
  SEND_USER_MESSAGE_TOOL_NAME,
} from "./send-user-message-constants.js";

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
 * Whether the workspace has excluded the tool outright.
 *
 * `tools.exclude` drops the name from the definitions the model is given, so a
 * turn that is otherwise gated would be told its plain text is invisible and
 * handed no way to speak: suppression on, prompt section rendered, tool
 * absent. Reading the same exclusion the resolver reads keeps the gate honest
 * about a surface the user has turned off. Never throws: an unreadable config
 * reads as "not excluded", and the flag check beside it already fails closed.
 */
function isSendUserMessageExcluded(): boolean {
  try {
    return getConfig().tools.exclude.includes(SEND_USER_MESSAGE_TOOL_NAME);
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
  /**
   * The turn's tool-disabled bracket depth. Above zero the resolver hands the
   * model an empty tool list, so the delivery tool is not among them.
   */
  toolsDisabledDepth?: number;
}

/**
 * Whether this turn routes its user-facing text through the tool: the flag is
 * on, the conversation is not a subagent, the turn has tools at all, and it
 * resolves to the `mainAgent` call site. Every other call site (subagent
 * spawns, calls and live-voice legs, heartbeat and memory workers) keeps
 * today's behavior.
 *
 * A turn with no resolved call site is a main-agent turn: `mainAgent` is what
 * the loop defaults to when a caller supplies none.
 *
 * A tool-disabled turn is excluded even though it keeps that call site. The
 * pointer-generation turn (call-status events) and the live-voice front-door
 * leg bracket themselves with `toolsDisabledDepth`, so the resolver returns an
 * empty tool list: gating them would suppress their text and hand them a
 * prompt naming a tool they were not given, so the reply would reach the user
 * only after a wasted nudge and the raw-text fallback.
 */
export function isSendUserMessageTurnScope(
  scope: SendUserMessageTurnScope,
): boolean {
  return (
    scope.isSubagent !== true &&
    (scope.toolsDisabledDepth ?? 0) === 0 &&
    (scope.currentCallSite ?? "mainAgent") === "mainAgent"
  );
}

/**
 * {@link isSendUserMessageTurnScope} with the flag read and the workspace
 * exclusion folded in: the turn is gated only when the tool will actually be
 * on its surface.
 */
export function isSendUserMessageActiveForTurn(
  scope: SendUserMessageTurnScope,
): boolean {
  return (
    isSendUserMessageTurnScope(scope) &&
    isSendUserMessageFlagOn() &&
    !isSendUserMessageExcluded()
  );
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
