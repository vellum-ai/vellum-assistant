/**
 * Channel-agnostic approval orchestration module.
 *
 * Bridges the gap between external channel adapters (Telegram, SMS, etc.)
 * and the internal run orchestrator / permission system:
 *
 *   1. Detect pending confirmations for a conversation
 *   2. Build human-readable approval prompts with action buttons
 *   3. Consume user decisions and apply them to the underlying run
 *   4. Build reminder prompts when non-decision messages arrive
 */

import { getPendingConfirmationsByConversation, getRun } from '../memory/runs-store.js';
import type { PendingRunInfo } from '../memory/runs-store.js';
import { addRule } from '../permissions/trust-store.js';
import { getTool } from '../tools/registry.js';
import type { RunOrchestrator } from './run-orchestrator.js';
import { DEFAULT_APPROVAL_ACTIONS } from './channel-approval-types.js';
import type {
  ChannelApprovalPrompt,
  ApprovalUIMetadata,
  ApprovalDecisionResult,
} from './channel-approval-types.js';
import { composeApprovalMessage } from './approval-message-composer.js';

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
  const pending = getPendingConfirmationsByConversation(conversationId);
  if (pending.length === 0) return null;

  // Use the first pending run — channel UIs show one prompt at a time.
  const info = pending[0];
  return buildPromptFromRunInfo(info);
}

/**
 * Internal helper: turn a PendingRunInfo into a ChannelApprovalPrompt.
 */
function buildPromptFromRunInfo(info: PendingRunInfo): ChannelApprovalPrompt {
  const promptText = composeApprovalMessage({
    scenario: 'standard_prompt',
    toolName: info.toolName,
  });

  // Hide "approve always" when persistent trust rules are disallowed for this invocation.
  const actions = info.persistentDecisionsAllowed === false
    ? DEFAULT_APPROVAL_ACTIONS.filter((a) => a.id !== 'approve_always')
    : [...DEFAULT_APPROVAL_ACTIONS];

  // Plain-text fallback must remain parser-compatible (contains "yes"/"always"/"no" keywords).
  const plainTextFallback = info.persistentDecisionsAllowed === false
    ? `${promptText}\n\nReply "yes" to approve or "no" to reject.`
    : `${promptText}\n\nReply "yes" to approve once, "always" to approve always, or "no" to reject.`;

  return { promptText, actions, plainTextFallback };
}

// ---------------------------------------------------------------------------
// 2. Build gateway-facing UI metadata
// ---------------------------------------------------------------------------

/**
 * Convert a prompt + run info into the `ApprovalUIMetadata` payload that
 * gateway adapters use to render buttons and route decisions back.
 */
export function buildApprovalUIMetadata(
  prompt: ChannelApprovalPrompt,
  runInfo: PendingRunInfo,
): ApprovalUIMetadata {
  return {
    runId: runInfo.runId,
    requestId: runInfo.requestId,
    actions: prompt.actions,
    plainTextFallback: prompt.plainTextFallback,
  };
}

// ---------------------------------------------------------------------------
// 3. Consume a user decision and apply it to the run
// ---------------------------------------------------------------------------

export interface HandleDecisionResult {
  applied: boolean;
  runId?: string;
}

/**
 * Find the pending run for a conversation, map the user's decision to the
 * permission system's vocabulary, and apply it.
 *
 * For `approve_always`, a trust rule is persisted using the first allowlist
 * option and first scope option from the pending confirmation (narrow
 * default). The current invocation is also approved.
 */
export function handleChannelDecision(
  conversationId: string,
  decision: ApprovalDecisionResult,
  orchestrator: RunOrchestrator,
  decisionContext?: string,
): HandleDecisionResult {
  const pending = getPendingConfirmationsByConversation(conversationId);
  if (pending.length === 0) return { applied: false };

  // Callback-based decisions include a run ID and must resolve to that exact
  // pending confirmation. Plain-text decisions still apply to the first prompt.
  const info = decision.runId
    ? pending.find((candidate) => candidate.runId === decision.runId)
    : pending[0];
  if (!info) return { applied: false };

  if (decision.action === 'approve_always') {
    // Only persist a trust rule when the confirmation explicitly allows persistence
    // AND provides explicit allowlist/scope options. Without explicit options we
    // would create a blanket "**"/"everywhere" rule, which is a security risk.
    const run = getRun(info.runId);
    const confirmation = run?.pendingConfirmation;
    if (
      confirmation &&
      confirmation.persistentDecisionsAllowed !== false &&
      confirmation.allowlistOptions?.length &&
      confirmation.scopeOptions?.length
    ) {
      const pattern = confirmation.allowlistOptions[0].pattern;
      const scope = confirmation.scopeOptions[0].scope;
      // Only persist executionTarget for skill-origin tools — core tools don't
      // set it in their PolicyContext, so a persisted value would prevent the
      // rule from ever matching on subsequent permission checks.
      const tool = getTool(confirmation.toolName);
      const executionTarget = tool?.origin === 'skill' ? confirmation.executionTarget : undefined;
      addRule(confirmation.toolName, pattern, scope, 'allow', 100, {
        executionTarget,
      });
    }
    // When persistence is not allowed or options are missing, the decision
    // still proceeds as a one-time approval (falls through to submitDecision).
  }

  // Map channel-level action to the permission system's UserDecision type.
  const userDecision = decision.action === 'reject' ? 'deny' as const : 'allow' as const;
  const result = decisionContext === undefined
    ? orchestrator.submitDecision(info.runId, userDecision)
    : orchestrator.submitDecision(info.runId, userDecision, decisionContext);

  return {
    applied: result === 'applied',
    runId: info.runId,
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
  info: PendingRunInfo,
  requesterIdentifier: string,
): ChannelApprovalPrompt {
  const promptText = composeApprovalMessage({
    scenario: 'guardian_prompt',
    toolName: info.toolName,
    requesterIdentifier,
  });

  // Guardian approvals are always one-time decisions — "approve always"
  // doesn't make sense when the guardian is approving on behalf of someone else.
  const actions = DEFAULT_APPROVAL_ACTIONS.filter((a) => a.id !== 'approve_always');

  const plainTextFallback = `${promptText}\n\nReply "yes" to approve or "no" to reject.`;

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
const RICH_APPROVAL_CHANNELS: ReadonlySet<string> = new Set(['telegram']);

/**
 * Returns true when the given channel supports rich approval UI such as
 * inline buttons / keyboards. For channels that return false, the
 * plainTextFallback instructions should be appended to the message body
 * so the user sees how to approve or reject via text.
 */
export function channelSupportsRichApprovalUI(channel: string): boolean {
  return RICH_APPROVAL_CHANNELS.has(channel);
}

// ---------------------------------------------------------------------------
// 6. Reminder prompt for non-decision messages
// ---------------------------------------------------------------------------

/**
 * Build a reminder prompt when the user sends a non-decision message while
 * an approval is pending. Reuses the original actions and fallback text
 * but prefixes the prompt text with a reminder.
 */
export function buildReminderPrompt(
  pendingPrompt: ChannelApprovalPrompt,
): ChannelApprovalPrompt {
  const reminderPrefix = composeApprovalMessage({ scenario: 'reminder_prompt' });
  return {
    promptText: `${reminderPrefix}\n\n${pendingPrompt.promptText}`,
    actions: pendingPrompt.actions,
    plainTextFallback: `${reminderPrefix}\n\n${pendingPrompt.plainTextFallback}`,
  };
}
