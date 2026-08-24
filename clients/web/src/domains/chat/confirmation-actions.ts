/**
 * Confirmation-prompt interaction handlers.
 *
 * Stateless imperative functions — no React hooks, no component state.
 * Coordinates the allow/deny/allow-and-create-rule lifecycle for
 * tool-call confirmation prompts.
 */

import { captureError } from "@/lib/sentry/capture-error";

import type { DisplayMessage } from "@/domains/chat/types/types";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { offersRuleOption } from "@/domains/chat/confirmation-decisions";
import { patchTranscriptMessages } from "@/domains/chat/transcript/patch-transcript-messages";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import {
  clearSubmissionFailure,
  reportSubmissionFailure,
  stillOwnsSubmission,
} from "@/domains/chat/prompt-submission";
import { useStreamStore } from "@/domains/chat/stream-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useRuleEditorStore } from "@/domains/chat/rule-editor-store";
import type { RuleEditorContext } from "@/domains/chat/rule-editor-store";
import { clearConfirmationByRequestId } from "@/domains/chat/utils/send-message-utils";
import { deriveCommandText } from "@/domains/chat/utils/chat";
import { toRiskLevel } from "@/domains/chat/utils/risk";
import { mapMessageToolCalls } from "@/domains/chat/utils/map-message-tool-calls";
import { submitConfirmation } from "@/domains/chat/api/interactions";
import { fireSuggestion } from "@/domains/chat/rule-editor-actions";
import type { ConfirmationDecision } from "@/types/event-types";
import type { PendingConfirmationState } from "@/types/interaction-ui-types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/**
 * Clean up confirmation state after a successful decision. Stamps risk
 * metadata on the matched tool call, clears the pending confirmation from
 * inline-attached tool calls, handles unknown-risk nudge targets, and
 * removes the deterministic mapping entry.
 */
function cleanupAfterConfirmationDecision(
  snapshot: PendingConfirmationState,
  mappedToolCallId: string | undefined,
  decision: ConfirmationDecision,
): void {
  const confirmationDecisionValue =
    decision === "allow" ? "approved" : "denied";
  useInteractionStore
    .getState()
    .dismissConfirmationIfMatches(snapshot.requestId);
  useInteractionStore.getState().releaseInlineAnchorIfMatches(mappedToolCallId);
  const convKey = useConversationStore.getState().activeConversationId;
  if (convKey) {
    useConversationStore.getState().removeAttentionConversationId(convKey);
  }

  const riskMetadata = {
    pendingConfirmation: undefined,
    riskLevel: snapshot.riskLevel,
    riskReason: snapshot.riskReason,
    riskAllowlistOptions: snapshot.allowlistOptions,
    scopeOptions: snapshot.scopeOptions,
    riskDirectoryScopeOptions: snapshot.directoryScopeOptions,
    confirmationDecision: confirmationDecisionValue,
  } as const;

  // Single updater: clear pendingConfirmation from all matching tool calls
  // AND stamp risk metadata on the target tool call.
  let nudgeTcId: string | null = null;

  patchTranscriptMessages((prev: DisplayMessage[]) => {
    // The risk metadata describes a tool call, so it goes on the tool call the
    // prompt named and nowhere else. A prompt that named none (an ACP route
    // approval has no tool call of its own) has nothing to describe: stamping
    // whichever call happens to be last would label an unrelated, already
    // finished step with this decision's risk level, and point the
    // unknown-risk nudge at it too.
    const stampTargetId = mappedToolCallId;

    // Computed from pre-stamp state, before `riskLevel` is applied.
    if (stampTargetId && snapshot.riskLevel?.toLowerCase() === "unknown") {
      nudgeTcId = stampTargetId;
    }

    let anyChanged = false;
    const updated = prev.map((msg) => {
      const next = mapMessageToolCalls(msg, (tc) => {
        if (tc.id === stampTargetId) {
          return { ...tc, ...riskMetadata };
        }
        if (tc.pendingConfirmation?.requestId === snapshot.requestId) {
          return { ...tc, pendingConfirmation: undefined };
        }
        return tc;
      });
      if (next !== msg) {
        anyChanged = true;
      }
      return next;
    });
    return anyChanged ? updated : prev;
  });

  if (nudgeTcId) {
    useInteractionStore.getState().addUnknownNudgeToolCallId(nudgeTcId);
  }

  useChatSessionStore.getState().deleteConfirmationToolCall(snapshot.requestId);
  useInteractionStore
    .getState()
    .releaseSubmission("confirmation", snapshot.requestId);
}

/**
 * Clear a confirmation prompt the daemon has already discarded.
 *
 * A confirmation POST comes back 404 ("No pending interaction found for this
 * requestId") when the server-side pending interaction is gone — the turn
 * ended, the tool call timed out, the prompt was superseded, or a daemon
 * restart dropped it. This is terminal and non-retryable: the decision is moot
 * because the server has moved on. The matching `interaction_resolved` SSE
 * event that would normally retire the card can be missed entirely (the web /
 * iOS SSE stream tears down on app background and has no replay), so the stale
 * prompt lingers — leaving the user tapping Allow/Deny into the same 404.
 *
 * Retire the prompt without surfacing a blocking error so the user is never
 * stranded. No decision is stamped on the tool call — none was applied; the
 * transcript already reflects the tool call's own outcome.
 */
function clearStaleConfirmation(
  snapshot: PendingConfirmationState,
  mappedToolCallId: string | undefined,
): void {
  useInteractionStore
    .getState()
    .dismissConfirmationIfMatches(snapshot.requestId);
  useInteractionStore.getState().releaseInlineAnchorIfMatches(mappedToolCallId);
  const convKey = useConversationStore.getState().activeConversationId;
  if (convKey) {
    useConversationStore.getState().removeAttentionConversationId(convKey);
  }
  patchTranscriptMessages((prev: DisplayMessage[]) =>
    clearConfirmationByRequestId(prev, snapshot.requestId),
  );
  useChatSessionStore.getState().deleteConfirmationToolCall(snapshot.requestId);
  // Before the release below, which is what the clear's own door reads.
  clearSubmissionFailure("confirmation", snapshot.requestId);
  useInteractionStore
    .getState()
    .releaseSubmission("confirmation", snapshot.requestId);
}

// ---------------------------------------------------------------------------
// Public actions
// ---------------------------------------------------------------------------

/**
 * Submit a confirmation decision (allow/deny) for a pending tool-call approval.
 * Supports both standalone (directive card) and inline (per-chip) confirmations.
 */
export async function handleConfirmationSubmit(
  decision: ConfirmationDecision,
  toolCall?: ChatMessageToolCall,
): Promise<void> {
  const { pendingConfirmation, submittingByKind } =
    useInteractionStore.getState();
  const snapshot = toolCall?.pendingConfirmation ?? pendingConfirmation;
  if (!snapshot) {
    return;
  }
  // Guards double-submitting this prompt, not any prompt; see
  // `prompt-submission.ts` for why that is not "anything in flight".
  if (submittingByKind.confirmation === snapshot.requestId) {
    return;
  }
  useInteractionStore
    .getState()
    .claimSubmission("confirmation", snapshot.requestId);
  useChatSessionStore.getState().setError(null);

  const ctx = useStreamStore.getState().streamContext;
  if (!ctx) {
    useChatSessionStore
      .getState()
      .setError({ message: "No active session. Please try again." });
    useInteractionStore
      .getState()
      .releaseSubmission("confirmation", snapshot.requestId);
    return;
  }

  const mappedToolCallId =
    toolCall?.id ??
    useChatSessionStore
      .getState()
      .confirmationToolCallMap.get(snapshot.requestId);

  // Auto-select first pattern/scope when the request permits a durable rule.
  // Same predicate the cards render from, so the hint cannot be sent for a
  // request whose card withheld the option (or withheld for one that offered).
  const ruleHint =
    decision === "allow" && offersRuleOption(snapshot)
      ? {
          selectedPattern: snapshot.allowlistOptions![0]!.pattern,
          selectedScope:
            (snapshot.directoryScopeOptions?.[0]?.scope ??
              snapshot.scopeOptions?.[0]?.scope) ||
            "everywhere",
        }
      : undefined;

  try {
    const result = await submitConfirmation(
      ctx.assistantId,
      snapshot.requestId,
      decision,
      ruleHint,
    );

    if (!result.ok) {
      if (result.status === 404) {
        // Pending interaction already gone server-side — retire the stale
        // prompt instead of stranding the user on an un-actionable card.
        clearStaleConfirmation(snapshot, mappedToolCallId);
        return;
      }
      reportSubmissionFailure("confirmation", snapshot.requestId, result.error);
      useInteractionStore
        .getState()
        .releaseSubmission("confirmation", snapshot.requestId);
      return;
    }
    cleanupAfterConfirmationDecision(snapshot, mappedToolCallId, decision);
  } catch (err) {
    // Always recorded; only shown while its own prompt is the one on screen.
    captureError(err, { context: "submit_confirmation" });
    reportSubmissionFailure(
      "confirmation",
      snapshot.requestId,
      "Failed to submit confirmation. Please try again.",
    );
    useInteractionStore
      .getState()
      .releaseSubmission("confirmation", snapshot.requestId);
  }
}

/**
 * Allow the tool call AND open the rule editor to create a trust rule.
 * Resolves the confirmation first, then opens the editor in create mode
 * with a background LLM suggestion.
 */
export async function handleAllowAndCreateRule(
  toolCall?: ChatMessageToolCall,
): Promise<void> {
  const { pendingConfirmation, submittingByKind } =
    useInteractionStore.getState();
  const snapshot = toolCall?.pendingConfirmation ?? pendingConfirmation;
  if (!snapshot) {
    return;
  }
  // Guards double-submitting this prompt, not any prompt; see
  // `prompt-submission.ts` for why that is not "anything in flight".
  if (submittingByKind.confirmation === snapshot.requestId) {
    return;
  }
  const ctx = useStreamStore.getState().streamContext;
  if (!ctx) {
    useChatSessionStore
      .getState()
      .setError({ message: "No active session. Please try again." });
    return;
  }

  useInteractionStore
    .getState()
    .claimSubmission("confirmation", snapshot.requestId);
  // Same entry clear as every other submit path: the prompt is on screen and
  // the claim is synchronous, so a banner still up here is this prompt's own
  // stale one.
  useChatSessionStore.getState().setError(null);

  const mappedToolCallId =
    toolCall?.id ??
    useChatSessionStore
      .getState()
      .confirmationToolCallMap.get(snapshot.requestId);

  const editorContext: RuleEditorContext = {
    requestId: snapshot.requestId,
    toolName: snapshot.toolName ?? "",
    riskLevel: toRiskLevel(snapshot.riskLevel),
    allowlistOptions: snapshot.allowlistOptions ?? [],
    scopeOptions: snapshot.scopeOptions ?? [],
    directoryScopeOptions: snapshot.directoryScopeOptions ?? [],
    commandText: deriveCommandText(snapshot.input, snapshot.toolName ?? ""),
    commandDescription: snapshot.riskReason ?? snapshot.description ?? "",
  };

  const openCreateEditor = (context: RuleEditorContext) => {
    useRuleEditorStore.getState().openRuleEditor(context);
    fireSuggestion({
      assistantId: ctx.assistantId,
      toolName: snapshot.toolName ?? "",
      input: snapshot.input,
      riskLevel: snapshot.riskLevel,
      riskReason: snapshot.riskReason ?? snapshot.description,
      resolvedAllowlistOptions: snapshot.allowlistOptions ?? [],
      scopeOptions: snapshot.scopeOptions ?? [],
      directoryScopeOptions: snapshot.directoryScopeOptions ?? [],
    });
  };

  // The rule editor is this user's own request and the transcript patch names
  // its own requestId, so both stay outside every guard below: neither can
  // touch a newer prompt, and withholding the editor would swallow the click.

  try {
    const result = await submitConfirmation(
      ctx.assistantId,
      snapshot.requestId,
      "allow",
    );

    if (!result.ok) {
      // A 404 means the pending interaction is already gone server-side; the
      // user can still create a rule, so retire the prompt quietly rather than
      // surfacing a blocking "No pending interaction" error they can't act on.
      if (result.status === 404) {
        clearSubmissionFailure("confirmation", snapshot.requestId);
      } else {
        reportSubmissionFailure(
          "confirmation",
          snapshot.requestId,
          result.error,
        );
      }
      useInteractionStore
        .getState()
        .releaseSubmission("confirmation", snapshot.requestId);
      useInteractionStore
        .getState()
        .releaseInlineAnchorIfMatches(mappedToolCallId);
      patchTranscriptMessages((prev: DisplayMessage[]) =>
        clearConfirmationByRequestId(prev, snapshot.requestId),
      );
      openCreateEditor({ ...editorContext, requestId: "" });
      return;
    }

    if (stillOwnsSubmission("confirmation", snapshot.requestId)) {
      cleanupAfterConfirmationDecision(snapshot, mappedToolCallId, "allow");
    }

    openCreateEditor({ ...editorContext, requestId: "" });
  } catch (err) {
    captureError(err, { context: "allow_and_create_rule" });
    reportSubmissionFailure(
      "confirmation",
      snapshot.requestId,
      "Failed to submit confirmation, but you can still create a rule.",
    );
    useInteractionStore
      .getState()
      .releaseSubmission("confirmation", snapshot.requestId);
    useInteractionStore
      .getState()
      .releaseInlineAnchorIfMatches(mappedToolCallId);
    patchTranscriptMessages((prev: DisplayMessage[]) =>
      clearConfirmationByRequestId(prev, snapshot.requestId),
    );
    openCreateEditor({ ...editorContext, requestId: "" });
  }
}
