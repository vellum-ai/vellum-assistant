/**
 * Encapsulates all interaction-prompt action handlers: secret, confirmation,
 * contact-request, question-response, surface-action, and rule-editor flows.
 *
 * Each handler calls the interaction store's named actions directly
 * (e.g. `submitSecretStart()`, `dismissConfirmation()`) instead of
 * dispatching event objects. Non-reactive reads use
 * `useInteractionStore.getState()` to avoid stale closures.
 *
 * @see domains/interactions/interaction-store.ts — Zustand store for prompt state
 * @see send-message-utils.ts — pure helpers reused here
 */

import { captureError } from "@/lib/sentry/capture-error";
import { useCallback } from "react";

import { addTrustRule, fetchTrustRules, suggestTrustRule, updateTrustRule } from "@/lib/trust-rules-api";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useStreamStore } from "@/domains/chat/stream-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useTurnStore } from "@/domains/chat/turn-store";
import { endTurn } from "@/domains/chat/turn-coordinator";
import { useRuleEditorStore } from "@/domains/chat/rule-editor-store";
import type { RuleEditorContext } from "@/domains/chat/rule-editor-store";

import {
  clearConfirmationByRequestId,
  completeSubmittedSurface,
} from "@/domains/chat/hooks/send-message-utils";
import { deriveCommandText } from "@/domains/chat/utils/chat";
import { isToolCallRunning } from "@/domains/chat/utils/tool-call-status";
import type { ConfirmationDecision } from "@/types/event-types";
import type { AllowlistOption, DirectoryScopeOption, PendingConfirmationState, ScopeOption } from "@/types/interaction-ui-types";
import type { TrustRuleItem } from "@/types/trust-rules";
import type { ChatMessageToolCall, QuestionResponseEntry } from "@/domains/chat/api/event-types";
import { submitConfirmation, submitContactPrompt, submitQuestionResponse, submitSecretResponse } from "@/domains/chat/api/interactions";
import { submitSurfaceAction } from "@/domains/chat/api/surfaces";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Credential-bearing input keys whose values are redacted before the command
 * text is sent to the suggestion LLM. Mirrors the macOS `sensitiveKeys` set
 * (ChatMessage.swift) so neither client leaks secrets into the prompt.
 */
const SENSITIVE_INPUT_KEYS = new Set([
  "value", "secret", "password", "token", "client_secret", "api_key",
  "authorization", "access_token", "refresh_token", "api_secret",
  "accesstoken", "refreshtoken", "apikey", "apisecret", "clientsecret",
  "x-api-key",
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_INPUT_KEYS.has(key.toLowerCase());
}

/**
 * Stringifies a tool-input value for the suggestion prompt. Strings pass
 * through; objects/arrays are JSON-encoded (so nested structures don't become
 * `"[object Object]"`) with sensitive keys redacted at any depth.
 */
function stringifyInputValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value, (key, val) =>
      key && isSensitiveKey(key) ? "[redacted]" : val,
    );
  } catch {
    return String(value);
  }
}

/**
 * Builds a full command text from tool call input for the suggestion endpoint.
 * Formats all key-value pairs rather than extracting just the primary field,
 * giving the LLM full context for pattern suggestion.
 */
function buildFullCommandText(input?: Record<string, unknown>): string {
  if (!input) {
    return "";
  }
  const entries = Object.entries(input).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );
  if (entries.length === 0) {
    return "";
  }
  if (entries.length === 1) {
    const [k, v] = entries[0];
    return isSensitiveKey(k) ? "[redacted]" : stringifyInputValue(v);
  }
  return entries
    .map(([k, v]) => `${k}: ${isSensitiveKey(k) ? "[redacted]" : stringifyInputValue(v)}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape for `handleOpenRuleEditorForToolCall`'s argument. */
export interface ToolCallRuleContext {
  toolName: string;
  riskLevel?: string;
  riskReason?: string;
  input?: Record<string, unknown>;
  allowlistOptions: AllowlistOption[];
  scopeOptions: ScopeOption[];
  directoryScopeOptions: DirectoryScopeOption[];
  matchedTrustRuleId?: string;
}

// ---------------------------------------------------------------------------
// Hook return
// ---------------------------------------------------------------------------

export interface UseInteractionActionsReturn {
  handleSecretSubmit: (value: string, delivery?: string) => Promise<void>;
  handleSecretCancel: () => void;
  handleContactPromptSubmit: (address: string, channelType: string) => Promise<void>;
  handleContactPromptCancel: () => void;
  handleConfirmationSubmit: (
    decision: ConfirmationDecision,
    toolCall?: ChatMessageToolCall,
  ) => Promise<void>;
  handleAllowAndCreateRule: (toolCall?: ChatMessageToolCall) => Promise<void>;
  handleOpenRuleEditorForToolCall: (context: ToolCallRuleContext) => void;
  handleSaveRule: (rule: { toolName: string; pattern: string; riskLevel: string; scope: string }) => Promise<void>;
  handleSaveAsNewRule: (rule: { toolName: string; pattern: string; riskLevel: string; scope: string }) => Promise<void>;
  handleQuestionResponse: (responses: QuestionResponseEntry[]) => Promise<void>;
  handleDismissPendingQuestion: () => void;
  handleSurfaceAction: (surfaceId: string, actionId: string, data?: Record<string, unknown>) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useInteractionActions(): UseInteractionActionsReturn {
  // -------------------------------------------------------------------------
  // Secret handlers
  // -------------------------------------------------------------------------

  const handleSecretSubmit = useCallback(
    async (value: string, delivery: string = "store") => {
      const { pendingSecret, isSubmittingSecret } = useInteractionStore.getState();
      if (!pendingSecret || isSubmittingSecret) return;
      useInteractionStore.getState().submitSecretStart();
      useChatSessionStore.getState().setError(null);

      const ctx = useStreamStore.getState().streamContext;
      if (!ctx) {
        useChatSessionStore.getState().setError({ message: "No active session. Please try again." });
        useInteractionStore.getState().submitSecretEnd();
        return;
      }

      try {
        const result = await submitSecretResponse(
          ctx.assistantId,
          pendingSecret.requestId,
          value,
          delivery,
        );
        if (!result.ok) {
          useChatSessionStore.getState().setError({ message: result.error });
          useInteractionStore.getState().submitSecretEnd();
          return;
        }

        useInteractionStore.getState().submitSecretEnd(true);
        const convKey = useConversationStore.getState().activeConversationId;
        if (convKey) {
          useConversationStore.getState().removeAttentionConversationId(convKey);
        }
        const savedRequestId = pendingSecret.requestId;
        setTimeout(() => {
          const current = useInteractionStore.getState().pendingSecret;
          if (current?.requestId === savedRequestId) {
            useInteractionStore.getState().dismissSecret();
          }
        }, 1500);
      } catch (err) {
        captureError(err, { context: "submit_secret" });
        useChatSessionStore.getState().setError({ message: "Failed to submit secret. Please try again." });
        useInteractionStore.getState().submitSecretEnd();
      }
    },
    [],
  );

  const handleSecretCancel = useCallback(() => {
    const ctx = useStreamStore.getState().streamContext;
    const requestId = useInteractionStore.getState().pendingSecret?.requestId;
    if (ctx && requestId) {
      submitSecretResponse(ctx.assistantId, requestId, "", "none").catch(() => {});
    }
    useInteractionStore.getState().dismissSecret();
    const convKey = useConversationStore.getState().activeConversationId;
    if (convKey) {
      useConversationStore.getState().removeAttentionConversationId(convKey);
    }
    endTurn({ conversationId: convKey, reason: "error" });
  }, []);

  // -------------------------------------------------------------------------
  // Contact prompt handlers
  // -------------------------------------------------------------------------

  const handleContactPromptSubmit = useCallback(
    async (address: string, channelType: string) => {
      const { pendingContactRequest, isSubmittingContactRequest } = useInteractionStore.getState();
      if (!pendingContactRequest || isSubmittingContactRequest) return;
      useInteractionStore.getState().submitContactRequestStart();
      useChatSessionStore.getState().setError(null);

      const ctx = useStreamStore.getState().streamContext;
      if (!ctx) {
        useChatSessionStore.getState().setError({ message: "No active session. Please try again." });
        useInteractionStore.getState().submitContactRequestEnd();
        return;
      }

      try {
        const result = await submitContactPrompt(
          ctx.assistantId,
          pendingContactRequest.requestId,
          address,
          channelType,
          pendingContactRequest.role,
        );
        if (!result.ok) {
          useChatSessionStore.getState().setError({ message: result.error });
          useInteractionStore.getState().submitContactRequestEnd();
          return;
        }

        useInteractionStore.getState().acceptContactRequest();
        const savedRequestId = pendingContactRequest.requestId;
        setTimeout(() => {
          const current = useInteractionStore.getState().pendingContactRequest;
          if (current?.requestId === savedRequestId) {
            useInteractionStore.getState().dismissContactRequest();
          }
        }, 1500);
      } catch (err) {
        captureError(err, { context: "submit_contact_prompt" });
        useChatSessionStore.getState().setError({ message: "Failed to save contact. Please try again." });
        useInteractionStore.getState().submitContactRequestEnd();
      }
    },
    [],
  );

  const handleContactPromptCancel = useCallback(() => {
    useInteractionStore.getState().dismissContactRequest();
    endTurn({
      conversationId: useConversationStore.getState().activeConversationId,
      reason: "error",
    });
  }, []);

  // -------------------------------------------------------------------------
  // Confirmation handlers
  // -------------------------------------------------------------------------

  /**
   * Clean up confirmation state after a successful decision. Stamps risk
   * metadata on the matched tool call, clears the pending confirmation from
   * inline-attached tool calls, handles unknown-risk nudge targets, and
   * removes the deterministic mapping entry.
   */
  const cleanupAfterConfirmationDecision = useCallback(
    (snapshot: PendingConfirmationState, mappedToolCallId: string | undefined, decision: ConfirmationDecision) => {
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
    },
    [],
  );

  const handleConfirmationSubmit = useCallback(
    async (decision: ConfirmationDecision, toolCall?: ChatMessageToolCall) => {
      // The prompt is sourced from the originating tool call when an inline
      // chip submits, falling back to the store for the standalone
      // (directive) card. This lets overlapping confirmations resolve
      // independently instead of all keying off the single store slot.
      const { pendingConfirmation, isSubmittingConfirmation } = useInteractionStore.getState();
      const snapshot = toolCall?.pendingConfirmation ?? pendingConfirmation;
      if (!snapshot) return;
      // The standalone card shares the global submitting flag; inline chips
      // track their own per-chip state and pass a toolCall, so they are not
      // blocked here when another confirmation is mid-submit.
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
    },
    [cleanupAfterConfirmationDecision],
  );

  // -------------------------------------------------------------------------
  // Question response handler
  // -------------------------------------------------------------------------

  const handleQuestionResponse = useCallback(
    async (responses: QuestionResponseEntry[]) => {
      const { pendingQuestion: snapshot, isSubmittingQuestion } = useInteractionStore.getState();
      if (!snapshot || isSubmittingQuestion) return;
      useInteractionStore.getState().submitQuestionStart();
      useChatSessionStore.getState().setError(null);

      const ctx = useStreamStore.getState().streamContext;
      if (!ctx) {
        useChatSessionStore.getState().setError({ message: "No active session. Please try again." });
        useInteractionStore.getState().submitQuestionEnd();
        return;
      }

      try {
        const result = await submitQuestionResponse(
          ctx.assistantId,
          snapshot.requestId,
          { kind: "submit", responses },
        );
        if (!result.ok) {
          useChatSessionStore.getState().setError({ message: result.error });
          useInteractionStore.getState().submitQuestionEnd();
          return;
        }
        // Guard against an SSE-driven `question_request` that lands while
        // our POST is in flight: only clear the prompt if the snapshot we
        // submitted is still the current one.
        if (useInteractionStore.getState().pendingQuestion?.requestId === snapshot.requestId) {
          useInteractionStore.getState().dismissQuestion();
        } else {
          useInteractionStore.getState().submitQuestionEnd();
        }
      } catch (err) {
        captureError(err, { context: "submit_question_response" });
        useChatSessionStore.getState().setError({ message: "Failed to submit response. Please try again." });
        useInteractionStore.getState().submitQuestionEnd();
      }
    },
    [],
  );

  const handleDismissPendingQuestion = useCallback(() => {
    const snapshot = useInteractionStore.getState().pendingQuestion;
    useInteractionStore.getState().dismissQuestion();
    if (!snapshot) return;
    const ctx = useStreamStore.getState().streamContext;
    if (!ctx) return;
    submitQuestionResponse(ctx.assistantId, snapshot.requestId, {
      kind: "close",
    })
      .then((result) => {
        if (!result.ok) {
          captureError(
            new Error(`question-response close failed: ${result.error}`),
            {
              context: "submit_question_response_close",
              extra: { status: result.status },
            },
          );
        }
      })
      .catch((err) => {
        captureError(err, { context: "submit_question_response_close" });
      });
  }, []);

  // -------------------------------------------------------------------------
  // Trust rule suggestion (shared by both rule-editor entry points)
  // -------------------------------------------------------------------------

  /**
   * Fires the best-effort LLM trust-rule suggestion in the background and
   * merges the result into the open rule-editor context. Aborts any in-flight
   * suggestion first so reopening the editor can't apply a stale one, and skips
   * the merge if the fetch was superseded/dismissed. Used by both the risk-badge
   * and the "Allow & Create Rule" confirmation entry points.
   */
  const fireSuggestion = useCallback(
    (params: {
      assistantId: string;
      toolName: string;
      input?: Record<string, unknown>;
      riskLevel?: string;
      riskReason?: string;
      resolvedAllowlistOptions: AllowlistOption[];
      scopeOptions: ScopeOption[];
      directoryScopeOptions: DirectoryScopeOption[];
      existingRule?: TrustRuleItem;
    }) => {
      const abortController = useRuleEditorStore.getState().newSuggestionController();

      const scopeOpts =
        params.resolvedAllowlistOptions.length > 0
          ? params.resolvedAllowlistOptions.map((o) => ({ pattern: o.pattern, label: o.label }))
          : params.scopeOptions.map((o) => ({ pattern: o.scope, label: o.label }));

      void (async () => {
        try {
          const suggestion = await suggestTrustRule(params.assistantId, {
            tool: params.toolName,
            command: buildFullCommandText(params.input),
            riskAssessment: {
              risk: params.riskLevel ?? "medium",
              reasoning: params.riskReason ?? "",
              reasonDescription: params.riskReason ?? "",
            },
            scopeOptions: scopeOpts,
            directoryScopeOptions: params.directoryScopeOptions.map((o) => ({ scope: o.scope, label: o.label })),
            intent: "auto_approve",
            existingRule: params.existingRule
              ? { id: params.existingRule.id, pattern: params.existingRule.pattern, risk: params.existingRule.risk }
              : undefined,
          });
          if (!abortController.signal.aborted) {
            useRuleEditorStore.getState().updateRuleEditorContext({ suggestion });
          }
        } catch {
          // Suggestion is best-effort — silently ignore failures.
        }
      })();
    },
    [],
  );

  // -------------------------------------------------------------------------
  // Allow & Create Rule flow
  // -------------------------------------------------------------------------

  const handleAllowAndCreateRule = useCallback(async (toolCall?: ChatMessageToolCall) => {
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
      riskLevel: snapshot.riskLevel ?? "medium",
      allowlistOptions: snapshot.allowlistOptions ?? [],
      scopeOptions: snapshot.scopeOptions ?? [],
      directoryScopeOptions: snapshot.directoryScopeOptions ?? [],
      commandText: deriveCommandText(snapshot.input, snapshot.toolName ?? ""),
      commandDescription: snapshot.riskReason ?? snapshot.description ?? "",
    };

    // Open the editor in create mode and pre-populate it with a background LLM
    // suggestion, matching macOS `fetchSuggestionAndOpenEditor`. The confirmation
    // snapshot carries no `matchedTrustRuleId`, so this path is always create-only.
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
  }, [cleanupAfterConfirmationDecision, fireSuggestion]);

  const handleOpenRuleEditorForToolCall = useCallback(
    (context: ToolCallRuleContext) => {
      const ctx = useStreamStore.getState().streamContext;
      if (!ctx) {
        return;
      }

      // Cancel any previous suggestion fetch.
      useRuleEditorStore.getState().abortSuggestion();

      // Only `riskAllowlistOptions` (minimatch globs) are valid save-path
      // patterns. Per the `tool_result` wire contract, `riskScopeOptions` are a
      // regex-flavored, display-only ladder and must NOT be persisted as trust
      // rules, so we never feed them into the "Apply to" list. When no saveable
      // ladder is present we leave this empty and let the modal's
      // buildApplyToOptions synthesize the fallback (raw command, or wildcard
      // for natural-language input).
      const resolvedAllowlistOptions: AllowlistOption[] =
        context.allowlistOptions.length > 0 ? context.allowlistOptions : [];

      const baseContext: RuleEditorContext = {
        requestId: "",
        toolName: context.toolName,
        riskLevel: context.riskLevel ?? "medium",
        allowlistOptions: resolvedAllowlistOptions,
        scopeOptions: context.scopeOptions,
        directoryScopeOptions: context.directoryScopeOptions,
        commandText: deriveCommandText(context.input, context.toolName),
        commandDescription: context.riskReason ?? "",
      };

      // Fetch matched rule (edit mode) then open modal immediately.
      // Suggestion fetch fires in the background after modal is open.
      const openModal = async () => {
        let existingRule: TrustRuleItem | undefined;
        if (context.matchedTrustRuleId) {
          try {
            const rules = await fetchTrustRules(ctx.assistantId, { tool: context.toolName });
            existingRule = rules.find((r) => r.id === context.matchedTrustRuleId);
            if (!existingRule) {
              const defaultRules = await fetchTrustRules(ctx.assistantId, { origin: "default", tool: context.toolName });
              existingRule = defaultRules.find((r) => r.id === context.matchedTrustRuleId);
            }
          } catch {
            // Failed to fetch matched rule — fall through to create mode.
          }
        }

        const editorContext: RuleEditorContext = { ...baseContext, existingRule };
        useRuleEditorStore.getState().openRuleEditor(editorContext);

        // Fire LLM suggestion in the background.
        fireSuggestion({
          assistantId: ctx.assistantId,
          toolName: context.toolName,
          input: context.input,
          riskLevel: context.riskLevel,
          riskReason: context.riskReason,
          resolvedAllowlistOptions,
          scopeOptions: context.scopeOptions,
          directoryScopeOptions: context.directoryScopeOptions,
          existingRule,
        });
      };

      openModal().catch((err) => captureError(err, { context: "open_rule_editor" }));
    },
    [fireSuggestion],
  );

  const handleSaveRule = useCallback(
    async (rule: { toolName: string; pattern: string; riskLevel: string; scope: string }) => {
      const ctx = useStreamStore.getState().streamContext;
      const { ruleEditorContext: context, isSavingRule: saving } = useRuleEditorStore.getState();
      if (!ctx || !context) {
        return;
      }
      if (saving) {
        return;
      }

      if (!context.requestId) {
        useRuleEditorStore.getState().setIsSavingRule(true);
        try {
          if (context.existingRule) {
            // Edit mode: update the existing rule's risk level.
            await updateTrustRule(ctx.assistantId, context.existingRule.id, {
              risk: rule.riskLevel as "low" | "medium" | "high",
            });
          } else {
            await addTrustRule(ctx.assistantId, {
              tool: rule.toolName,
              pattern: rule.pattern,
              risk: rule.riskLevel as "low" | "medium" | "high",
              description: `${rule.toolName} — ${rule.pattern}`,
              scope: rule.scope,
            });
          }
        } catch (err) {
          captureError(err, { context: "save_trust_rule_direct" });
          useChatSessionStore.getState().setError({ message: "Failed to save trust rule. Please try again." });
        } finally {
          useRuleEditorStore.getState().setIsSavingRule(false);
          useRuleEditorStore.getState().dismissRuleEditor();
        }
        return;
      }

      useRuleEditorStore.getState().setIsSavingRule(true);
      useInteractionStore.getState().submitConfirmationStart();
      try {
        const result = await submitConfirmation(
          ctx.assistantId,
          context.requestId,
          "allow",
          { selectedPattern: rule.pattern, selectedScope: rule.scope },
        );

        if (!result.ok) {
          useRuleEditorStore.getState().dismissRuleEditor();
          useChatSessionStore.getState().setError({ message: result.error });
          return;
        }
      } catch (err) {
        captureError(err, { context: "save_trust_rule" });
        useRuleEditorStore.getState().dismissRuleEditor();
        useChatSessionStore.getState().setError({ message: "Failed to save trust rule. Please try again." });
        return;
      } finally {
        useRuleEditorStore.getState().setIsSavingRule(false);
        useInteractionStore.getState().submitConfirmationEnd();
      }

      useInteractionStore.getState().dismissConfirmationIfMatches(context.requestId);
      useInteractionStore.getState().setInlineConfirmationToolCallId(null);
      useChatSessionStore.getState().deleteConfirmationToolCall(context.requestId);
      useChatSessionStore.getState().setMessages((prev: DisplayMessage[]) => clearConfirmationByRequestId(prev, context.requestId));
      useRuleEditorStore.getState().dismissRuleEditor();
    },
    [],
  );

  const handleSaveAsNewRule = useCallback(
    async (rule: { toolName: string; pattern: string; riskLevel: string; scope: string }) => {
      const ctx = useStreamStore.getState().streamContext;
      const { ruleEditorContext: context, isSavingRule: saving } = useRuleEditorStore.getState();
      if (!ctx || !context) {
        return;
      }
      if (saving) {
        return;
      }

      useRuleEditorStore.getState().setIsSavingRule(true);
      try {
        await addTrustRule(ctx.assistantId, {
          tool: rule.toolName,
          pattern: rule.pattern,
          risk: rule.riskLevel as "low" | "medium" | "high",
          description: `${rule.toolName} — ${rule.pattern}`,
          scope: rule.scope,
        });
      } catch (err) {
        captureError(err, { context: "save_as_new_trust_rule" });
        useChatSessionStore.getState().setError({ message: "Failed to save trust rule. Please try again." });
      } finally {
        useRuleEditorStore.getState().setIsSavingRule(false);
        useRuleEditorStore.getState().dismissRuleEditor();
      }
    },
    [],
  );

  // -------------------------------------------------------------------------
  // Surface action handler
  // -------------------------------------------------------------------------

  const handleSurfaceAction = useCallback(
    async (surfaceId: string, actionId: string, data?: Record<string, unknown>) => {
      const exists = useChatSessionStore.getState().messages.some((m) =>
        m.surfaces?.some((s) => s.surfaceId === surfaceId),
      );
      if (!exists) {
        console.warn(`Surface action on unknown surface: ${surfaceId}`);
        return;
      }

      const ctx = useStreamStore.getState().streamContext;
      if (!ctx) {
        useChatSessionStore.getState().setError({ message: "No active session. Please try again." });
        throw new Error("No active session");
      }

      let result: { ok: boolean };
      try {
        result = await submitSurfaceAction(
          ctx.assistantId,
          surfaceId,
          actionId,
          data,
        );
      } catch (err) {
        captureError(err, { context: "submit_surface_action" });
        useChatSessionStore.getState().setError({ message: "Failed to submit. Please try again." });
        throw err;
      }

      if (!result.ok) {
        useChatSessionStore.getState().setError({ message: "Failed to submit. Please try again." });
        throw new Error("Surface action failed");
      }

      useTurnStore.getState().requestSend();

      useChatSessionStore.getState().setMessages((prev: DisplayMessage[]) =>
        completeSubmittedSurface(prev, surfaceId, actionId),
      );
    },
    [],
  );

  return {
    handleSecretSubmit,
    handleSecretCancel,
    handleContactPromptSubmit,
    handleContactPromptCancel,
    handleConfirmationSubmit,
    handleAllowAndCreateRule,
    handleOpenRuleEditorForToolCall,
    handleSaveRule,
    handleSaveAsNewRule,
    handleQuestionResponse,
    handleDismissPendingQuestion,
    handleSurfaceAction,
  };
}
