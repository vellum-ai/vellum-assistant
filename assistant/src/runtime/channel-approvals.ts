/**
 * Channel-agnostic approval orchestration module.
 *
 * Bridges the gap between external channel adapters (Telegram, Slack, etc.)
 * and the pending-interactions tracker / permission system:
 *
 *   1. Detect pending confirmations for a conversation
 *   2. Build human-readable approval prompts with action buttons
 *   3. Consume user decisions and apply them to the underlying session
 */

import { findConversation } from "../daemon/conversation-store.js";
import type { UserDecision } from "../permissions/types.js";
import { composeApprovalMessage } from "./approval-message-composer.js";
import type {
  ApprovalAction,
  ApprovalDecisionResult,
  ApprovalUIMetadata,
  ChannelApprovalPrompt,
} from "./channel-approval-types.js";
import { toApprovalActionOptions } from "./channel-approval-types.js";
import {
  buildOneTimeDecisionActions,
  buildPlainTextFallback,
} from "./guardian-decision-types.js";
import * as pendingInteractions from "./pending-interactions.js";

/** Summary of a pending interaction, used by channel approval flows. */
export interface PendingApprovalInfo {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  riskLevel: string;
}

// ---------------------------------------------------------------------------
// 1. Detect pending confirmations and build prompt
// ---------------------------------------------------------------------------

/**
 * Check whether a conversation has a pending tool-use confirmation and,
 * if so, build a human-readable approval prompt.
 *
 * Returns `null` when there is nothing waiting for approval.
 */
export function getChannelApprovalPrompt(
  conversationId: string,
): ChannelApprovalPrompt | null {
  const pending = getApprovalInfoByConversation(conversationId);
  if (pending.length === 0) return null;

  // Use the first pending interaction — channel UIs show one prompt at a time.
  const info = pending[0];
  return buildPromptFromApprovalInfo(info);
}

/**
 * Get all pending approval interactions for a conversation, mapped
 * to the PendingApprovalInfo shape used by channel approval flows.
 */
export function getApprovalInfoByConversation(
  conversationId: string,
): PendingApprovalInfo[] {
  const interactions = pendingInteractions.getByConversation(conversationId);
  return interactions
    .filter((i) => i.kind === "confirmation" && i.confirmationDetails)
    .map((i) => ({
      requestId: i.requestId,
      toolName: i.confirmationDetails!.toolName,
      input: i.confirmationDetails!.input,
      riskLevel: i.confirmationDetails!.riskLevel,
    }));
}

/**
 * Internal helper: turn a PendingApprovalInfo into a ChannelApprovalPrompt.
 *
 * Derives actions from `buildOneTimeDecisionActions`, then maps them to the
 * channel-facing `ApprovalActionOption` shape. This ensures channel button sets
 * are always consistent with the unified `GuardianDecisionPrompt` type.
 */
function buildPromptFromApprovalInfo(
  info: PendingApprovalInfo,
): ChannelApprovalPrompt {
  const promptText = composeApprovalMessage({
    scenario: "standard_prompt",
    toolName: info.toolName,
  });

  const decisionActions = buildOneTimeDecisionActions();
  const actions = toApprovalActionOptions(decisionActions);
  const plainTextFallback = buildPlainTextFallback(promptText, decisionActions);

  return { promptText, actions, plainTextFallback };
}

// ---------------------------------------------------------------------------
// 2. Build gateway-facing UI metadata
// ---------------------------------------------------------------------------

/**
 * Convert a prompt + approval info into the `ApprovalUIMetadata` payload that
 * gateway adapters use to render buttons and route decisions back.
 */
export function buildApprovalUIMetadata(
  prompt: ChannelApprovalPrompt,
  info: PendingApprovalInfo,
  requesterIdentifier?: string,
): ApprovalUIMetadata {
  return {
    requestId: info.requestId,
    actions: prompt.actions,
    plainTextFallback: prompt.plainTextFallback,
    permissionDetails: {
      toolName: info.toolName,
      riskLevel: info.riskLevel,
      toolInput: info.input,
      ...(requesterIdentifier ? { requesterIdentifier } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// 2.5. Action → UserDecision mapping
// ---------------------------------------------------------------------------

/**
 * Map a channel-level `ApprovalAction` to the permission system's
 * `UserDecision` type.
 */
function mapApprovalActionToUserDecision(action: ApprovalAction): UserDecision {
  return action === "reject" ? "deny" : "allow";
}

// ---------------------------------------------------------------------------
// 3. Consume a user decision and apply it to the session
// ---------------------------------------------------------------------------

export interface HandleDecisionResult {
  applied: boolean;
  requestId?: string;
}

/**
 * Find the pending interaction for a conversation, map the user's decision to the
 * permission system's vocabulary, and apply it via session.handleConfirmationResponse().
 */
export function handleChannelDecision(
  conversationId: string,
  decision: ApprovalDecisionResult,
  decisionContext?: string,
): HandleDecisionResult {
  const pending = getApprovalInfoByConversation(conversationId);
  if (pending.length === 0) return { applied: false };

  // Callback-based decisions include a request ID and must resolve to that exact
  // pending confirmation. Plain-text decisions still apply to the first prompt.
  const info = decision.requestId
    ? pending.find((candidate) => candidate.requestId === decision.requestId)
    : pending[0];
  if (!info) return { applied: false };

  // Peek (not consume) — resolveConfirmation() owns deregistration and
  // must fire the promptResolve callback stored in the interaction.
  const resolved = pendingInteractions.get(info.requestId);
  if (!resolved) return { applied: false };

  // Map channel-level action to the permission system's UserDecision type.
  const userDecision = mapApprovalActionToUserDecision(decision.action);
  const conversation = findConversation(resolved.conversationId);
  if (!conversation) return { applied: false };

  if (decisionContext === undefined) {
    conversation.handleConfirmationResponse(
      info.requestId,
      userDecision,
    );
  } else {
    conversation.handleConfirmationResponse(
      info.requestId,
      userDecision,
      undefined,
      undefined,
      decisionContext,
    );
  }

  return {
    applied: true,
    requestId: info.requestId,
  };
}

// ---------------------------------------------------------------------------
// 4. Guardian-aware approval prompt
// ---------------------------------------------------------------------------

/**
 * Build an approval prompt that includes context about which non-guardian
 * user is requesting the action. Sent to the guardian's chat so they
 * can approve or deny on behalf of the requester.
 */
export function buildGuardianApprovalPrompt(
  info: PendingApprovalInfo,
  requesterIdentifier: string,
): ChannelApprovalPrompt {
  const promptText = composeApprovalMessage({
    scenario: "guardian_prompt",
    toolName: info.toolName,
    requesterIdentifier,
  });

  const decisionActions = buildOneTimeDecisionActions();
  const actions = toApprovalActionOptions(decisionActions);
  const plainTextFallback = buildPlainTextFallback(promptText, decisionActions);

  return { promptText, actions, plainTextFallback };
}

// ---------------------------------------------------------------------------
// 5. Channel UI capability check
// ---------------------------------------------------------------------------

/**
 * Channels known to support rich inline approval UI (e.g. inline keyboards).
 * All other channels fall back to plain-text instructions embedded in the
 * message body.
 */
const RICH_APPROVAL_CHANNELS: ReadonlySet<string> = new Set([
  "telegram",
  "whatsapp",
  "slack",
]);

/**
 * Returns true when the given channel supports rich approval UI such as
 * inline buttons / keyboards. For channels that return false, the
 * plainTextFallback instructions should be appended to the message body
 * so the user sees how to approve or reject via text.
 */
export function channelSupportsRichApprovalUI(channel: string): boolean {
  return RICH_APPROVAL_CHANNELS.has(channel);
}
