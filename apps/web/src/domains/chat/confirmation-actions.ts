/**
 * Confirmation-prompt interaction handlers.
 *
 * Stateless imperative functions — no React hooks, no component state.
 * Coordinates the allow/deny/allow-and-create-rule lifecycle for
 * tool-call confirmation prompts.
 */

import { captureError } from "@/lib/sentry/capture-error";

import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useStreamStore } from "@/domains/chat/stream-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useRuleEditorStore } from "@/domains/chat/rule-editor-store";
import type { RuleEditorContext } from "@/domains/chat/rule-editor-store";
import { clearConfirmationByRequestId } from "@/domains/chat/hooks/send-message-utils";
import { deriveCommandText } from "@/domains/chat/utils/chat";
import { toRiskLevel } from "@/domains/chat/utils/risk";
import { isToolCallRunning } from "@/domains/chat/utils/tool-call-status";
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

  // Clear inline confirmation from the matched tool call by requestId
  useChatSessionStore.getState().setMessages((prev: DisplayMessage[]) => {
    let anyChanged = false;
    const updated = prev.map((msg) => {
      if (!msg.toolCalls) return msg;
      let msgChanged = false;
      const updatedTcs = msg.toolCalls.map((tc) => {
        if (tc.pendingConfirmation?.requestId === snapshot.requestId) {
          msgChanged = true;
          return { ...tc, pendingConfirmation: undefined };
        }
        return tc;
      });
      if (msgChanged) {
        anyChanged = true;
        return { ...msg, toolCalls: updatedTcs };
      }
      return msg;
    });
    return anyChanged ? updated : prev;
  });

  // Compute nudge target BEFORE the stamp updater
  const nudgeTcId = (() => {
    if (snapshot.riskLevel?.toLowerCase() !== "unknown") return null;
    if (mappedToolCallId) return mappedToolCallId;
    const currentMessages = useChatSessionStore.getState().messages;
    const msgIdx = currentMessages.findLastIndex(
      (m) => m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0,
    );
    if (msgIdx !== -1) {
      const msg = currentMessages[msgIdx];
      const tcIdx = msg?.toolCalls?.findLastIndex(
        (tc) => !isToolCallRunning(tc) && !tc.riskLevel,
      ) ?? -1;
      if (tcIdx !== -1) return msg!.toolCalls![tcIdx]!.id;
    }
    return null;
  })();

  // Stamp risk metadata on the correct tool call
  useChatSessionStore.getState().setMessages((prev: DisplayMessage[]) => {
    if (mappedToolCallId) {
      for (let i = prev.length - 1; i >= 0; i--) {
        const msg = prev[i];
        if (!msg?.toolCalls) continue;
        const tcIdx = msg.toolCalls.findIndex((tc) => tc.id === mappedToolCallId);
        if (tcIdx !== -1) {
          const existingTc = msg.toolCalls[tcIdx]!;
          const updatedToolCalls = [...msg.toolCalls];
          updatedToolCalls[tcIdx] = {
            ...existingTc,
            pendingConfirmation: undefined,
            riskLevel: snapshot.riskLevel,
            riskReason: snapshot.riskReason,
            riskAllowlistOptions: snapshot.allowlistOptions,
            scopeOptions: snapshot.scopeOptions,
            riskDirectoryScopeOptions: snapshot.directoryScopeOptions,
            confirmationDecision: confirmationDecisionValue,
          };
          const updated = [...prev];
          updated[i] = { ...msg, toolCalls: updatedToolCalls };
          return updated;
        }
      }
    }
    const msgIdx = prev.findLastIndex(
      (m) => m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0,
    );
    if (msgIdx === -1) return prev;
    const msg = prev[msgIdx];
    if (!msg?.toolCalls) return prev;
    const tcIdx = msg.toolCalls.findLastIndex(
      (tc) => !isToolCallRunning(tc) && !tc.riskLevel,
    );
    if (tcIdx === -1) return prev;
    const existingTc = msg.toolCalls[tcIdx];
    if (!existingTc) return prev;
    const updatedToolCalls = [...msg.toolCalls];
    updatedToolCalls[tcIdx] = {
      ...existingTc,
      pendingConfirmation: undefined,
      riskLevel: snapshot.riskLevel,
      riskReason: snapshot.riskReason,
      riskAllowlistOptions: snapshot.allowlistOptions,
      scopeOptions: snapshot.scopeOptions,
      riskDirectoryScopeOptions: snapshot.directoryScopeOptions,
      confirmationDecision: confirmationDecisionValue,
    };
    const updated = [...prev];
    updated[msgIdx] = { ...msg, toolCalls: updatedToolCalls };
    return updated;
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

  try {
    if (
      decision === "allow" &&
      snapshot.persistentDecisionsAllowed !== false &&
      (snapshot.allowlistOptions?.length ?? 0) > 0
    ) {
      const firstPattern = snapshot.allowlistOptions![0]!.pattern;
      const firstScope =
        (snapshot.directoryScopeOptions?.[0]?.scope ??
        snapshot.scopeOptions?.[0]?.scope) ||
        "everywhere";

      const result = await submitConfirmation(
        ctx.assistantId,
        snapshot.requestId,
        decision,
        { selectedPattern: firstPattern, selectedScope: firstScope },
      );

      if (!result.ok) {
        useChatSessionStore.getState().setError({ message: result.error });
        useInteractionStore.getState().submitConfirmationEnd();
        return;
      }
      cleanupAfterConfirmationDecision(snapshot, mappedToolCallId, decision);
      return;
    }

    const result = await submitConfirmation(
      ctx.assistantId,
      snapshot.requestId,
      decision,
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
      openCreateEditor(editorContext);
      return;
    }

    cleanupAfterConfirmationDecision(snapshot, mappedToolCallId, "allow");

    openCreateEditor({ ...editorContext, requestId: "" });
  } catch (err) {
    captureError(err, { context: "allow_and_create_rule" });
    useInteractionStore.getState().setInlineConfirmationToolCallId(null);
    useChatSessionStore.getState().setMessages((prev: DisplayMessage[]) => clearConfirmationByRequestId(prev, snapshot.requestId));
    openCreateEditor(editorContext);
    useChatSessionStore.getState().setError({ message: "Failed to submit confirmation, but you can still create a rule." });
    useInteractionStore.getState().submitConfirmationEnd();
  }
}
