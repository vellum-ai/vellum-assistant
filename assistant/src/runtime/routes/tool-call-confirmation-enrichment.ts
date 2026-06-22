/**
 * Render-time enrichment of history tool calls with confirmation context.
 *
 * Two pieces of state the persisted content does not itself carry are layered
 * onto each rendered tool call here so the web/API clients can render the same
 * confirmation UI on a cold reconnect (or a history reopen after the live
 * event buffer has aged out) that the live `confirmation_request` SSE stream
 * would have produced:
 *
 * 1. `scopeOptions` — the confirmation scope ladder for scope-aware tools
 *    (file/bash). It is a pure function of the workspace directory and the
 *    tool name, so it is *derived* at render rather than persisted. Completed
 *    tool calls regain the ladder the rule editor's trust-rule suggestion
 *    fallback consumes.
 *
 * 2. `pendingConfirmation` — the in-flight prompt for a tool call still
 *    awaiting a user decision. It is read from the in-memory
 *    `pending-interactions` registry (the authoritative store of unresolved
 *    prompts), so it appears only while the prompt is genuinely outstanding.
 */

import type { ConversationMessageToolCall } from "../../api/responses/conversation-message.js";
import { generateScopeOptions } from "../../permissions/checker.js";
import {
  type ConfirmationDetails,
  getByConversation,
} from "../pending-interactions.js";

/** A pending confirmation matched to the tool call it prompts for, keyed by `toolUseId`. */
interface PendingConfirmationMatch {
  requestId: string;
  details: ConfirmationDetails;
}

/**
 * Build the `toolUseId → pending confirmation` lookup for a conversation from
 * the registry. Only confirmation interactions that carry both a `toolUseId`
 * and `confirmationDetails` can be stamped onto a wire tool call.
 */
export function collectPendingConfirmations(
  conversationId: string,
): Map<string, PendingConfirmationMatch> {
  const byToolUseId = new Map<string, PendingConfirmationMatch>();
  for (const interaction of getByConversation(conversationId)) {
    if (
      interaction.kind === "confirmation" &&
      interaction.confirmationDetails &&
      interaction.toolUseId
    ) {
      byToolUseId.set(interaction.toolUseId, {
        requestId: interaction.requestId,
        details: interaction.confirmationDetails,
      });
    }
  }
  return byToolUseId;
}

/** Project a registry `ConfirmationDetails` into the wire `pendingConfirmation` shape. */
function toPendingConfirmation(
  requestId: string,
  details: ConfirmationDetails,
): NonNullable<ConversationMessageToolCall["pendingConfirmation"]> {
  return {
    requestId,
    toolName: details.toolName,
    riskLevel: details.riskLevel,
    input: details.input,
    allowlistOptions: details.allowlistOptions,
    scopeOptions: details.scopeOptions,
    directoryScopeOptions: details.directoryScopeOptions,
    persistentDecisionsAllowed: details.persistentDecisionsAllowed,
  };
}

/**
 * Layer derived `scopeOptions` and any outstanding `pendingConfirmation` onto a
 * message's rendered tool calls. Returns a new array; tool calls without
 * enrichment are returned unchanged.
 */
export function enrichToolCallsWithConfirmation(
  toolCalls: ConversationMessageToolCall[],
  opts: {
    workspaceDir: string;
    pendingConfirmations: ReadonlyMap<string, PendingConfirmationMatch>;
  },
): ConversationMessageToolCall[] {
  return toolCalls.map((tc) => {
    const scopeOptions = generateScopeOptions(opts.workspaceDir, tc.name);
    const match = tc.id ? opts.pendingConfirmations.get(tc.id) : undefined;
    if (scopeOptions.length === 0 && !match) {
      return tc;
    }
    return {
      ...tc,
      ...(scopeOptions.length > 0 ? { scopeOptions } : {}),
      ...(match
        ? {
            pendingConfirmation: toPendingConfirmation(
              match.requestId,
              match.details,
            ),
          }
        : {}),
    };
  });
}
