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
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useStreamStore } from "@/domains/chat/stream-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useRuleEditorStore } from "@/domains/chat/rule-editor-store";
import type { RuleEditorContext } from "@/domains/chat/rule-editor-store";
import { clearConfirmationByRequestId } from "@/domains/chat/utils/send-message-utils";
import { deriveCommandText } from "@/domains/chat/utils/chat";
import { toRiskLevel } from "@/domains/chat/utils/risk";
import { isToolCallRunning } from "@/domains/chat/utils/tool-call-status";
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
  const confirmationDecisionValue = decision === "allow" ? "approved" : "denied";
  useInteractionStore.getState().dismissConfirmation();
  useInteractionStore.getState().setInlineConfirmationToolCallId(null);
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

  useChatSessionStore.getState().setMessages((prev: DisplayMessage[]) => {
    // Resolve stamp target: explicit mapping or heuristic fallback
    let stampTargetId = mappedToolCallId;
    if (!stampTargetId) {
      for (let i = prev.length - 1; i >= 0; i--) {
        const msg = prev[i];
        if (msg?.role !== "assistant" || !msg.toolCalls?.length) continue;
        const tc = msg.toolCalls.findLast(
          (tc) => !isToolCallRunning(tc) && !tc.riskLevel,
        );
        if (tc) { stampTargetId = tc.id; break; }
      }
    }

    // Compute nudge target from pre-stamp state (riskLevel not yet applied)
    if (snapshot.riskLevel?.toLowerCase() === "unknown") {
      nudgeTcId = stampTargetId ?? null;
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
  useInteractionStore.getState().submitConfirmationEnd();
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
  const { pendingConfirmation, isSubmittingConfirmation } = useInteractionStore.getState();
  const snapshot = toolCall?.pendingConfirmation ?? pendingConfirmation;
  if (!snapshot) return;
  if (!toolCall && isSubmittingConfirmation) return;
  useInteractionStore.getState().submitConfirmationStart();
  useChatSessionStore.getState().setError(null);

  const ctx = useStreamStore.getState().streamContext;
  if (!ctx) {
    useChatSessionStore.getState().setError({ message: "No active session. Please try again." });
    useInteractionStore.getState().submitConfirmationEnd();
    return;
  }

  const mappedToolCallId =
    toolCall?.id ??
    useChatSessionStore.getState().confirmationToolCallMap.get(snapshot.requestId);

  // Auto-select first pattern/scope when persistent decisions are allowed
  const ruleHint =
    decision === "allow" &&
    snapshot.persistentDecisionsAllowed !== false &&
    (snapshot.allowlistOptions?.length ?? 0) > 0
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
      useChatSessionStore.getState().setError({ message: result.error });
      useInteractionStore.getState().submitConfirmationEnd();
      return;
    }
    cleanupAfterConfirmationDecision(snapshot, mappedToolCallId, decision);
  } catch (err) {
    captureError(err, { context: "submit_confirmation" });
    useChatSessionStore.getState().setError({ message: "Failed to submit confirmation. Please try again." });
    useInteractionStore.getState().submitConfirmationEnd();
  }
}

/**
 * Allow the tool call AND open the rule editor to create a trust rule.
 * Resolves the confirmation first, then opens the editor in create mode
 * with a background LLM suggestion.
 */
export async function handleAllowAndCreateRule(toolCall?: ChatMessageToolCall): Promise<void> {
  const { pendingConfirmation, isSubmittingConfirmation } = useInteractionStore.getState();
  const snapshot = toolCall?.pendingConfirmation ?? pendingConfirmation;
  if (!snapshot) return;
  if (!toolCall && isSubmittingConfirmation) return;
  const ctx = useStreamStore.getState().streamContext;
  if (!ctx) {
    useChatSessionStore.getState().setError({ message: "No active session. Please try again." });
    return;
  }

  useInteractionStore.getState().submitConfirmationStart();

  const mappedToolCallId =
    toolCall?.id ??
    useChatSessionStore.getState().confirmationToolCallMap.get(snapshot.requestId);

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

  try {
    const result = await submitConfirmation(
      ctx.assistantId,
      snapshot.requestId,
      "allow",
    );

    if (!result.ok) {
      useChatSessionStore.getState().setError({ message: result.error });
      useInteractionStore.getState().submitConfirmationEnd();
      useInteractionStore.getState().setInlineConfirmationToolCallId(null);
      useChatSessionStore.getState().setMessages((prev: DisplayMessage[]) => clearConfirmationByRequestId(prev, snapshot.requestId));
      openCreateEditor({ ...editorContext, requestId: "" });
      return;
    }

    cleanupAfterConfirmationDecision(snapshot, mappedToolCallId, "allow");

    openCreateEditor({ ...editorContext, requestId: "" });
  } catch (err) {
    captureError(err, { context: "allow_and_create_rule" });
    useInteractionStore.getState().setInlineConfirmationToolCallId(null);
    useChatSessionStore.getState().setMessages((prev: DisplayMessage[]) => clearConfirmationByRequestId(prev, snapshot.requestId));
    openCreateEditor({ ...editorContext, requestId: "" });
    useChatSessionStore.getState().setError({ message: "Failed to submit confirmation, but you can still create a rule." });
    useInteractionStore.getState().submitConfirmationEnd();
  }
}
