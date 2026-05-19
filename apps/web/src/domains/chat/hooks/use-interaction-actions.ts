/**
 * Encapsulates all interaction-prompt action handlers: secret, confirmation,
 * contact-request, question-response, surface-action, and rule-editor flows.
 *
 * Extracts ~530 lines of callback logic from `AssistantPageClient` into a
 * single hook with a clean return surface. The hook is framework-agnostic
 * aside from React's `useCallback` / `useState` — no Next.js imports.
 *
 * @see interaction-state-machine.ts  — reducer that drives prompt state
 * @see send-message-utils.ts         — pure helpers reused here
 */

import * as Sentry from "@sentry/react";
import { type Dispatch, type MutableRefObject, type SetStateAction, useCallback, useState } from "react";

import {
  type AllowlistOption,
  type ConfirmationDecision,
  type DirectoryScopeOption,
  type QuestionResponseEntry,
  type ScopeOption,
  submitConfirmation,
  submitContactPrompt,
  submitQuestionResponse,
  submitSecretResponse,
  submitSurfaceAction,
} from "@/domains/chat/lib/api.js";
import { addTrustRule } from "@/domains/trust-rules/api.js";
import type { DisplayMessage } from "@/domains/chat/lib/reconcile.js";
import type { InteractionState, InteractionEvent } from "@/domains/chat/lib/interaction-state-machine.js";
import type { ConversationListAction } from "@/domains/chat/lib/conversation-list-state.js";
import type { DomainEvent as TurnEvent } from "@/domains/chat/lib/turn-state-machine.js";

import { clearConfirmationByRequestId } from "@/domains/chat/hooks/send-message-utils.js";
import { deriveCommandText } from "@/domains/chat/utils/chat-utils.js";
import type { ChatError } from "@/domains/chat/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal stream context — just the assistantId needed for API calls. */
export interface StreamContext {
  assistantId: string;
  conversationKey: string;
}

/** Context for the trust-rule editor modal. */
export interface RuleEditorContext {
  requestId: string;
  toolName: string;
  riskLevel: string;
  allowlistOptions: AllowlistOption[];
  scopeOptions: ScopeOption[];
  directoryScopeOptions: DirectoryScopeOption[];
  commandText: string;
  commandDescription: string;
}

/** Shape for `handleOpenRuleEditorForToolCall`'s argument. */
export interface ToolCallRuleContext {
  toolName: string;
  riskLevel?: string;
  riskReason?: string;
  input?: Record<string, unknown>;
  allowlistOptions: AllowlistOption[];
  scopeOptions: ScopeOption[];
  directoryScopeOptions: DirectoryScopeOption[];
}

// ---------------------------------------------------------------------------
// Hook params
// ---------------------------------------------------------------------------

export interface UseInteractionActionsParams {
  interactionState: InteractionState;
  interactionStateRef: MutableRefObject<InteractionState>;
  dispatchInteraction: Dispatch<InteractionEvent>;
  dispatchConversationList: Dispatch<ConversationListAction>;
  dispatchTurn: Dispatch<TurnEvent>;
  setMessages: Dispatch<DisplayMessage[] | ((prev: DisplayMessage[]) => DisplayMessage[])>;
  setError: Dispatch<ChatError | null>;
  messagesRef: MutableRefObject<DisplayMessage[]>;
  streamContextRef: MutableRefObject<StreamContext | null>;
  activeConversationKeyRef: MutableRefObject<string | null>;
  confirmationToolCallMapRef: MutableRefObject<Map<string, string>>;
}

// ---------------------------------------------------------------------------
// Hook return
// ---------------------------------------------------------------------------

export interface UseInteractionActionsReturn {
  handleSecretSubmit: (value: string, delivery?: string) => Promise<void>;
  handleSecretCancel: () => void;
  handleContactPromptSubmit: (address: string, channelType: string) => Promise<void>;
  handleContactPromptCancel: () => void;
  handleConfirmationSubmit: (decision: ConfirmationDecision) => Promise<void>;
  handleAllowAndCreateRule: () => Promise<void>;
  handleOpenRuleEditorForToolCall: (context: ToolCallRuleContext) => void;
  handleSaveRule: (rule: { toolName: string; pattern: string; riskLevel: string; scope: string }) => Promise<void>;
  handleQuestionResponse: (responses: QuestionResponseEntry[]) => Promise<void>;
  handleSurfaceAction: (surfaceId: string, actionId: string, data?: Record<string, unknown>) => Promise<void>;
  showRuleEditor: boolean;
  setShowRuleEditor: Dispatch<boolean>;
  ruleEditorContext: RuleEditorContext | null;
  dismissRuleEditor: () => void;
  isSavingRule: boolean;
  unknownNudgeToolCallIds: Set<string>;
  setUnknownNudgeToolCallIds: Dispatch<SetStateAction<Set<string>>>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useInteractionActions({
  interactionState,
  interactionStateRef,
  dispatchInteraction,
  dispatchConversationList,
  dispatchTurn,
  setMessages,
  setError,
  messagesRef,
  streamContextRef,
  activeConversationKeyRef,
  confirmationToolCallMapRef,
}: UseInteractionActionsParams): UseInteractionActionsReturn {
  const {
    pendingSecret,
    isSubmittingSecret,
    pendingConfirmation,
    isSubmittingConfirmation,
    pendingContactRequest,
    isSubmittingContactRequest,
    pendingQuestion,
    isSubmittingQuestion,
  } = interactionState;

  const [showRuleEditor, setShowRuleEditor] = useState(false);
  const [ruleEditorContext, setRuleEditorContext] = useState<RuleEditorContext | null>(null);
  const [isSavingRule, setIsSavingRule] = useState(false);
  const [unknownNudgeToolCallIds, setUnknownNudgeToolCallIds] = useState<Set<string>>(new Set());

  // -------------------------------------------------------------------------
  // Secret handlers
  // -------------------------------------------------------------------------

  const handleSecretSubmit = useCallback(
    async (value: string, delivery: string = "store") => {
      if (!pendingSecret || isSubmittingSecret) return;
      dispatchInteraction({ type: "SUBMIT_SECRET_START" });
      setError(null);

      const ctx = streamContextRef.current;
      if (!ctx) {
        setError({ message: "No active session. Please try again." });
        dispatchInteraction({ type: "SUBMIT_SECRET_END" });
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
          setError({ message: result.error });
          dispatchInteraction({ type: "SUBMIT_SECRET_END" });
          return;
        }

        dispatchInteraction({ type: "SUBMIT_SECRET_END", saved: true });
        const convKey = activeConversationKeyRef.current;
        if (convKey) {
          dispatchConversationList({ type: "REMOVE_ATTENTION_KEY", key: convKey });
        }
        const savedRequestId = pendingSecret.requestId;
        setTimeout(() => {
          const current = interactionStateRef.current.pendingSecret;
          if (current?.requestId === savedRequestId) {
            dispatchInteraction({ type: "DISMISS_SECRET" });
          }
        }, 1500);
      } catch (err) {
        Sentry.captureException(err, { tags: { context: "submit_secret" } });
        setError({ message: "Failed to submit secret. Please try again." });
        dispatchInteraction({ type: "SUBMIT_SECRET_END" });
      }
    },
    [pendingSecret, isSubmittingSecret],
  );

  const handleSecretCancel = useCallback(() => {
    const ctx = streamContextRef.current;
    const requestId = interactionStateRef.current.pendingSecret?.requestId;
    if (ctx && requestId) {
      submitSecretResponse(ctx.assistantId, requestId, "", "none").catch(() => {});
    }
    dispatchInteraction({ type: "DISMISS_SECRET" });
    const convKey = activeConversationKeyRef.current;
    if (convKey) {
      dispatchConversationList({ type: "REMOVE_ATTENTION_KEY", key: convKey });
    }
    dispatchTurn({ type: "STREAM_ERROR" });
  }, []);

  // -------------------------------------------------------------------------
  // Contact prompt handlers
  // -------------------------------------------------------------------------

  const handleContactPromptSubmit = useCallback(
    async (address: string, channelType: string) => {
      if (!pendingContactRequest || isSubmittingContactRequest) return;
      dispatchInteraction({ type: "SUBMIT_CONTACT_REQUEST_START" });
      setError(null);

      const ctx = streamContextRef.current;
      if (!ctx) {
        setError({ message: "No active session. Please try again." });
        dispatchInteraction({ type: "SUBMIT_CONTACT_REQUEST_END" });
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
          setError({ message: result.error });
          dispatchInteraction({ type: "SUBMIT_CONTACT_REQUEST_END" });
          return;
        }

        dispatchInteraction({ type: "ACCEPT_CONTACT_REQUEST" });
        const savedRequestId = pendingContactRequest.requestId;
        setTimeout(() => {
          const current = interactionStateRef.current.pendingContactRequest;
          if (current?.requestId === savedRequestId) {
            dispatchInteraction({ type: "DISMISS_CONTACT_REQUEST" });
          }
        }, 1500);
      } catch (err) {
        Sentry.captureException(err, { tags: { context: "submit_contact_prompt" } });
        setError({ message: "Failed to save contact. Please try again." });
        dispatchInteraction({ type: "SUBMIT_CONTACT_REQUEST_END" });
      }
    },
    [pendingContactRequest, isSubmittingContactRequest, streamContextRef],
  );

  const handleContactPromptCancel = useCallback(() => {
    dispatchInteraction({ type: "DISMISS_CONTACT_REQUEST" });
    dispatchTurn({ type: "STREAM_ERROR" });
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
    (snapshot: NonNullable<typeof pendingConfirmation>, mappedToolCallId: string | undefined, decision: ConfirmationDecision) => {
      const confirmationDecisionValue = decision === "allow" ? "approved" : "denied";
      dispatchInteraction({ type: "DISMISS_CONFIRMATION" });
      dispatchInteraction({ type: "SET_INLINE_CONFIRMATION_TOOL_CALL_ID", toolCallId: null });
      const convKey = activeConversationKeyRef.current;
      if (convKey) {
        dispatchConversationList({ type: "REMOVE_ATTENTION_KEY", key: convKey });
      }

      // Clear inline confirmation from the matched tool call by requestId
      setMessages((prev: DisplayMessage[]) => {
        let anyChanged = false;
        const updated = prev.map((msg) => {
          if (!msg.toolCalls) return msg;
          let msgChanged = false;
          const updatedTcs = msg.toolCalls.map((tc) => {
            if (tc.pendingConfirmation?.requestId === snapshot.requestId) {
              msgChanged = true;
              return { ...tc, pendingConfirmation: null };
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
        const currentMessages = messagesRef.current;
        const msgIdx = currentMessages.findLastIndex(
          (m) => m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0,
        );
        if (msgIdx !== -1) {
          const msg = currentMessages[msgIdx];
          const tcIdx = msg?.toolCalls?.findLastIndex(
            (tc) => (tc.status === "completed" || tc.status === "error") && !tc.riskLevel,
          ) ?? -1;
          if (tcIdx !== -1) return msg!.toolCalls![tcIdx]!.id;
        }
        return null;
      })();

      // Stamp risk metadata on the correct tool call
      setMessages((prev: DisplayMessage[]) => {
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
                pendingConfirmation: null,
                riskLevel: snapshot.riskLevel,
                riskReason: snapshot.riskReason,
                allowlistOptions: snapshot.allowlistOptions,
                scopeOptions: snapshot.scopeOptions,
                directoryScopeOptions: snapshot.directoryScopeOptions,
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
          (tc) => (tc.status === "completed" || tc.status === "error") && !tc.riskLevel,
        );
        if (tcIdx === -1) return prev;
        const existingTc = msg.toolCalls[tcIdx];
        if (!existingTc) return prev;
        const updatedToolCalls = [...msg.toolCalls];
        updatedToolCalls[tcIdx] = {
          ...existingTc,
          pendingConfirmation: null,
          riskLevel: snapshot.riskLevel,
          riskReason: snapshot.riskReason,
          allowlistOptions: snapshot.allowlistOptions,
          scopeOptions: snapshot.scopeOptions,
          directoryScopeOptions: snapshot.directoryScopeOptions,
          confirmationDecision: confirmationDecisionValue,
        };
        const updated = [...prev];
        updated[msgIdx] = { ...msg, toolCalls: updatedToolCalls };
        return updated;
      });

      if (nudgeTcId) {
        setUnknownNudgeToolCallIds((ids) => new Set([...ids, nudgeTcId]));
      }

      confirmationToolCallMapRef.current.delete(snapshot.requestId);
      dispatchInteraction({ type: "SUBMIT_CONFIRMATION_END" });
    },
    [],
  );

  const handleConfirmationSubmit = useCallback(
    async (decision: ConfirmationDecision) => {
      const snapshot = pendingConfirmation;
      if (!pendingConfirmation || isSubmittingConfirmation) return;
      dispatchInteraction({ type: "SUBMIT_CONFIRMATION_START" });
      setError(null);

      const ctx = streamContextRef.current;
      if (!ctx) {
        setError({ message: "No active session. Please try again." });
        dispatchInteraction({ type: "SUBMIT_CONFIRMATION_END" });
        return;
      }

      const mappedToolCallId = snapshot ? confirmationToolCallMapRef.current.get(snapshot.requestId) : undefined;

      try {
        if (
          decision === "allow" &&
          pendingConfirmation.persistentDecisionsAllowed !== false &&
          (pendingConfirmation.allowlistOptions?.length ?? 0) > 0
        ) {
          const firstPattern = pendingConfirmation.allowlistOptions![0]!.pattern;
          const firstScope =
            (pendingConfirmation.directoryScopeOptions?.[0]?.scope ??
            pendingConfirmation.scopeOptions?.[0]?.scope) ||
            "everywhere";

          const result = await submitConfirmation(
            ctx.assistantId,
            pendingConfirmation.requestId,
            decision,
            { selectedPattern: firstPattern, selectedScope: firstScope },
          );

          if (!result.ok) {
            setError({ message: result.error });
            dispatchInteraction({ type: "SUBMIT_CONFIRMATION_END" });
            return;
          }
          cleanupAfterConfirmationDecision(snapshot!, mappedToolCallId, decision);
          return;
        }

        const result = await submitConfirmation(
          ctx.assistantId,
          pendingConfirmation.requestId,
          decision,
        );

        if (!result.ok) {
          setError({ message: result.error });
          dispatchInteraction({ type: "SUBMIT_CONFIRMATION_END" });
          return;
        }
        cleanupAfterConfirmationDecision(snapshot!, mappedToolCallId, decision);
      } catch (err) {
        Sentry.captureException(err, { tags: { context: "submit_confirmation" } });
        setError({ message: "Failed to submit confirmation. Please try again." });
        dispatchInteraction({ type: "SUBMIT_CONFIRMATION_END" });
      }
    },
    [pendingConfirmation, isSubmittingConfirmation, cleanupAfterConfirmationDecision],
  );

  // -------------------------------------------------------------------------
  // Question response handler
  // -------------------------------------------------------------------------

  const handleQuestionResponse = useCallback(
    async (responses: QuestionResponseEntry[]) => {
      const snapshot = pendingQuestion;
      if (!snapshot || isSubmittingQuestion) return;
      dispatchInteraction({ type: "SUBMIT_QUESTION_START" });
      setError(null);

      const ctx = streamContextRef.current;
      if (!ctx) {
        setError({ message: "No active session. Please try again." });
        dispatchInteraction({ type: "SUBMIT_QUESTION_END" });
        return;
      }

      try {
        const result = await submitQuestionResponse(
          ctx.assistantId,
          snapshot.requestId,
          { kind: "submit", responses },
        );
        if (!result.ok) {
          setError({ message: result.error });
          dispatchInteraction({ type: "SUBMIT_QUESTION_END" });
          return;
        }
        // Guard against an SSE-driven `question_request` that lands while
        // our POST is in flight: only clear the prompt if the snapshot we
        // submitted is still the current one.
        if (interactionStateRef.current.pendingQuestion?.requestId === snapshot.requestId) {
          dispatchInteraction({ type: "DISMISS_QUESTION" });
        } else {
          dispatchInteraction({ type: "SUBMIT_QUESTION_END" });
        }
      } catch (err) {
        Sentry.captureException(err, { tags: { context: "submit_question_response" } });
        setError({ message: "Failed to submit response. Please try again." });
        dispatchInteraction({ type: "SUBMIT_QUESTION_END" });
      }
    },
    [pendingQuestion, isSubmittingQuestion, dispatchInteraction],
  );

  // -------------------------------------------------------------------------
  // Allow & Create Rule flow
  // -------------------------------------------------------------------------

  const handleAllowAndCreateRule = useCallback(async () => {
    if (!pendingConfirmation || isSubmittingConfirmation) return;
    const ctx = streamContextRef.current;
    if (!ctx) {
      setError({ message: "No active session. Please try again." });
      return;
    }

    const snapshot = pendingConfirmation;
    dispatchInteraction({ type: "SUBMIT_CONFIRMATION_START" });

    const mappedToolCallId = confirmationToolCallMapRef.current.get(snapshot.requestId);

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

    try {
      const result = await submitConfirmation(
        ctx.assistantId,
        snapshot.requestId,
        "allow",
      );

      if (!result.ok) {
        setError({ message: result.error });
        dispatchInteraction({ type: "SUBMIT_CONFIRMATION_END" });
        dispatchInteraction({ type: "SET_INLINE_CONFIRMATION_TOOL_CALL_ID", toolCallId: null });
        setMessages((prev: DisplayMessage[]) => clearConfirmationByRequestId(prev, snapshot.requestId));
        setRuleEditorContext(editorContext);
        setShowRuleEditor(true);
        return;
      }

      cleanupAfterConfirmationDecision(snapshot, mappedToolCallId, "allow");

      setRuleEditorContext({ ...editorContext, requestId: "" });
      setShowRuleEditor(true);
    } catch (err) {
      Sentry.captureException(err, { tags: { context: "allow_and_create_rule" } });
      dispatchInteraction({ type: "SET_INLINE_CONFIRMATION_TOOL_CALL_ID", toolCallId: null });
      setMessages((prev: DisplayMessage[]) => clearConfirmationByRequestId(prev, snapshot.requestId));
      setRuleEditorContext(editorContext);
      setShowRuleEditor(true);
      setError({ message: "Failed to submit confirmation, but you can still create a rule." });
      dispatchInteraction({ type: "SUBMIT_CONFIRMATION_END" });
    }
  }, [pendingConfirmation, isSubmittingConfirmation, cleanupAfterConfirmationDecision]);

  const handleOpenRuleEditorForToolCall = useCallback(
    (context: ToolCallRuleContext) => {
      setRuleEditorContext({
        requestId: "",
        toolName: context.toolName,
        riskLevel: context.riskLevel ?? "medium",
        allowlistOptions: context.allowlistOptions,
        scopeOptions: context.scopeOptions,
        directoryScopeOptions: context.directoryScopeOptions,
        commandText: deriveCommandText(context.input, context.toolName),
        commandDescription: context.riskReason ?? "",
      });
      setShowRuleEditor(true);
    },
    [],
  );

  const handleSaveRule = useCallback(
    async (rule: { toolName: string; pattern: string; riskLevel: string; scope: string }) => {
      const ctx = streamContextRef.current;
      const context = ruleEditorContext;
      if (!ctx || !context) return;
      if (isSavingRule) return;

      if (!context.requestId) {
        setIsSavingRule(true);
        try {
          await addTrustRule(ctx.assistantId, {
            tool: rule.toolName,
            pattern: rule.pattern,
            risk: rule.riskLevel as "low" | "medium" | "high",
            description: `${rule.toolName} — ${rule.pattern}`,
            scope: rule.scope,
          });
        } catch (err) {
          Sentry.captureException(err, { tags: { context: "save_trust_rule_direct" } });
          setError({ message: "Failed to save trust rule. Please try again." });
        } finally {
          setIsSavingRule(false);
          setShowRuleEditor(false);
          setRuleEditorContext(null);
        }
        return;
      }

      setIsSavingRule(true);
      dispatchInteraction({ type: "SUBMIT_CONFIRMATION_START" });
      try {
        const result = await submitConfirmation(
          ctx.assistantId,
          context.requestId,
          "allow",
          { selectedPattern: rule.pattern, selectedScope: rule.scope },
        );

        if (!result.ok) {
          setShowRuleEditor(false);
          setRuleEditorContext(null);
          setError({ message: result.error });
          return;
        }
      } catch (err) {
        Sentry.captureException(err, { tags: { context: "save_trust_rule" } });
        setShowRuleEditor(false);
        setRuleEditorContext(null);
        setError({ message: "Failed to save trust rule. Please try again." });
        return;
      } finally {
        setIsSavingRule(false);
        dispatchInteraction({ type: "SUBMIT_CONFIRMATION_END" });
      }

      dispatchInteraction({ type: "DISMISS_CONFIRMATION_IF_MATCHES", requestId: context.requestId });
      dispatchInteraction({ type: "SET_INLINE_CONFIRMATION_TOOL_CALL_ID", toolCallId: null });
      confirmationToolCallMapRef.current.delete(context.requestId);
      setMessages((prev: DisplayMessage[]) => clearConfirmationByRequestId(prev, context.requestId));
      setShowRuleEditor(false);
      setRuleEditorContext(null);
    },
    [ruleEditorContext, isSavingRule],
  );

  // -------------------------------------------------------------------------
  // Surface action handler
  // -------------------------------------------------------------------------

  const handleSurfaceAction = useCallback(
    async (surfaceId: string, actionId: string, data?: Record<string, unknown>) => {
      const exists = messagesRef.current.some((m) =>
        m.surfaces?.some((s) => s.surfaceId === surfaceId),
      );
      if (!exists) {
        console.warn(`Surface action on unknown surface: ${surfaceId}`);
        return;
      }

      const ctx = streamContextRef.current;
      if (!ctx) {
        setError({ message: "No active session. Please try again." });
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
        Sentry.captureException(err, { tags: { context: "submit_surface_action" } });
        setError({ message: "Failed to submit. Please try again." });
        throw err;
      }

      if (!result.ok) {
        setError({ message: "Failed to submit. Please try again." });
        throw new Error("Surface action failed");
      }

      dispatchTurn({ type: "USER_SEND_REQUESTED" });

      const ONE_SHOT_SURFACE_TYPES = ["form", "confirmation", "file_upload", "card", "list", "table", "browser_view"];
      setMessages((prev: DisplayMessage[]) => {
        for (let i = prev.length - 1; i >= 0; i--) {
          const surface = prev[i]!.surfaces?.find((s) => s.surfaceId === surfaceId);
          if (!surface) continue;
          if (!ONE_SHOT_SURFACE_TYPES.includes(surface.surfaceType)) return prev;
          const matchedAction = surface.actions?.find((a) => a.id === actionId);
          const isCancellation =
            actionId === "cancel" || actionId === "dismiss" ||
            matchedAction?.style === "secondary";
          const updated = [...prev];
          updated[i] = {
            ...prev[i]!,
            surfaces: prev[i]!.surfaces?.map((s) =>
              s.surfaceId === surfaceId
                ? {
                    ...s,
                    completed: true,
                    completionSummary: isCancellation
                      ? "Cancelled"
                      : matchedAction?.label ?? undefined,
                  }
                : s,
            ),
          };
          return updated;
        }
        return prev;
      });
    },
    [],
  );

  const dismissRuleEditor = useCallback(() => {
    setShowRuleEditor(false);
    setRuleEditorContext(null);
  }, []);

  return {
    handleSecretSubmit,
    handleSecretCancel,
    handleContactPromptSubmit,
    handleContactPromptCancel,
    handleConfirmationSubmit,
    handleAllowAndCreateRule,
    handleOpenRuleEditorForToolCall,
    handleSaveRule,
    handleQuestionResponse,
    handleSurfaceAction,
    showRuleEditor,
    setShowRuleEditor,
    ruleEditorContext,
    dismissRuleEditor,
    isSavingRule,
    unknownNudgeToolCallIds,
    setUnknownNudgeToolCallIds,
  };
}
