/**
 * Chat route content — renders the chat body, document panel,
 * app-editing side panel, and all chat-specific UI slots inside `ChatLayout`.
 *
 * Reads per-conversation state from Zustand stores directly and owns
 * UI-scoped hooks (avatar, disk pressure, nudges, voice input, interaction
 * actions, ghost text) so the parent (`ActiveChatView`) stays focused on
 * orchestration (SSE, reconciliation, send message, conversation loading).
 */

import { captureError } from "@/lib/sentry/capture-error";
import { type Dispatch, type FormEvent, lazy, type MutableRefObject, type ReactNode, type RefObject, type SetStateAction, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { LazyBoundary } from "@/components/lazy-boundary";

import { AppViewerContainer } from "@/components/app-viewer-container";
import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { DiscordNudgeBanner } from "@/components/nudges/discord-nudge-banner";
import { GitHubNudgeBanner } from "@/components/nudges/github-nudge-banner";
import { IOSAppBanner } from "@/components/nudges/ios-app-banner";
import { MacOSAppBanner } from "@/components/nudges/macos-app-banner";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useChatAttachmentDropZone } from "@/domains/chat/components/chat-attachments/use-chat-attachment-drop-zone";
import type { ChatAttachment } from "@/domains/chat/components/chat-attachments/use-chat-attachments";
import { ChatBody } from "@/domains/chat/components/chat-body";
import type { ChatEmptyStateProps } from "@/domains/chat/components/chat-empty-state";
import { ChatRuleEditorModal } from "@/domains/chat/components/chat-rule-editor-modal";
import { ComposerNotices } from "@/domains/chat/components/composer-notices";
import { ComposerSettingsMenu } from "@/domains/chat/components/composer-settings-menu";
import { ConfirmationPromptCard } from "@/domains/chat/components/confirmation-prompt-card";
import { ContactPromptCard } from "@/domains/chat/components/contact-prompt-card";
import { ContextWindowIndicator } from "@/domains/chat/components/context-window-indicator";
import { ConversationStarterGrid } from "@/domains/chat/components/conversation-starter-grid";
import { CreditsExhaustedBanner } from "@/domains/chat/components/credits-exhausted-banner";
import { DocumentViewerContainer } from "@/domains/chat/components/document-viewer-container";
import { OnboardingChoiceCard } from "@/domains/chat/components/onboarding-choice-card";
import { ProviderBillingBanner } from "@/domains/chat/components/provider-billing-banner";
import { QuestionPromptCard } from "@/domains/chat/components/question-prompt-card";
import { QueuedMessagesDrawer } from "@/domains/chat/components/queued-messages-drawer";
import { SecretPromptCard } from "@/domains/chat/components/secret-prompt-card";
import { SendErrorModal } from "@/domains/chat/components/send-error-modal";
import { SlackChannelFooter } from "@/domains/chat/components/slack-channel-footer";
import { liveAssistantRowId } from "@/domains/chat/hooks/stream-message-updaters";
import { useConversationStarters } from "@/domains/chat/hooks/use-conversation-starters";
import { useEditMessage } from "@/domains/chat/hooks/use-edit-message";
import { useOnboardingChoice } from "@/domains/chat/hooks/use-onboarding-choice";
import { usePullRefresh } from "@/domains/chat/hooks/use-pull-refresh";
import type { TranscriptHandle, TranscriptProps } from "@/domains/chat/transcript/transcript";
import { useTranscriptScroll } from "@/domains/chat/transcript/use-transcript-scroll";
import { hasAnyInteractiveSurface, hasPendingAssistantResponse, toolCallToRuleContext } from "@/domains/chat/utils/chat";
import { conversationsByIdUndoPost, subagentsByIdAbortPost } from "@/generated/daemon/sdk.gen";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { getLocalBool, removeLocalSetting, setLocalBool } from "@/utils/local-settings";
import { Button, Notice, ResizablePanel } from "@vellumai/design-library";
import { Loader2 } from "lucide-react";
const SubagentDetailPanel = lazy(() =>
  import("@/domains/chat/components/subagent-detail-panel").then((m) => ({
    default: m.SubagentDetailPanel,
  })),
);
const ToolDetailPanel = lazy(() =>
  import("@/domains/chat/components/tool-detail-panel").then((m) => ({
    default: m.ToolDetailPanel,
  })),
);

import { Link, useNavigate } from "react-router";

import { useEmptyStateGreeting } from "@/domains/chat/hooks/use-empty-state-greeting";
import { buildEditAppGreeting, buildEditAppStarters } from "@/domains/chat/utils/edit-app-empty-state";
import { pickRandomPlaceholder } from "@/domains/chat/utils/empty-state-constants";
import { getChatBillingBannerDecision, shouldShowGenericChatErrorNotice } from "@/domains/chat/utils/error-classification";

import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import type { DisplayAttachment, DisplayMessage } from "@/domains/chat/utils/reconcile";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useDeployStore } from "@/stores/deploy-store";

import { buildTranscriptItems } from "@/domains/chat/transcript/build-items";
import type { TranscriptItem } from "@/domains/chat/transcript/types";
import type { HistoryPaginationResult } from "@/domains/chat/transcript/use-history-pagination";
import {
    canStopGeneration,
    getThinkingStatusText,
    isSendDisabled,
    shouldShowThinkingIndicator,
    type UIContext,
} from "@/domains/chat/turn-selectors";
import { sanitizeDisplayMessages } from "@/domains/chat/utils/sanitize-display-messages";
import { getSlackConversationDisplay } from "@/domains/chat/utils/slack-conversation-display";

import { getDiskPressureChatBlockReason } from "@/assistant/disk-pressure";
import { DiskPressureBanner, type DiskPressureBannerMode } from "@/components/disk-pressure-banner";
import { submitQuestionResponse } from "@/domains/chat/api/interactions";
import { useActiveProfileModel } from "@/domains/chat/hooks/use-active-profile-model";
import { useStreamStore } from "@/domains/chat/stream-store";
import { type TurnState, useTurnStore } from "@/domains/chat/turn-store";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel";
import { useViewerStore } from "@/stores/viewer-store";
import { haptic } from "@/utils/haptics";
import { isPointerCoarse } from "@/utils/pointer";
import { routes } from "@/utils/routes";

import { lifecycleService } from "@/assistant/lifecycle-service";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { useAssistantSelectionStore } from "@/assistant/selection-store";
import type { UseDiskPressureMonitorResult } from "@/assistant/use-disk-pressure-monitor";
import { useActiveConversation } from "@/domains/chat/hooks/use-active-conversation";
import { useAppNudges } from "@/domains/chat/hooks/use-app-nudges";
import { useGhostTextSuggestion } from "@/domains/chat/hooks/use-ghost-text-suggestion";
import { useInteractionActions } from "@/domains/chat/hooks/use-interaction-actions";
import { useOpenAppFromChat } from "@/domains/chat/hooks/use-open-app-from-chat";
import { useVoiceInput } from "@/domains/chat/hooks/use-voice-input";
import { useConversationListQuery } from "@/hooks/conversation-queries";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useEditApp } from "@/hooks/use-edit-app";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useConversationStore } from "@/stores/conversation-store";

// ---------------------------------------------------------------------------
// Props — only values that cannot be owned locally
// ---------------------------------------------------------------------------

export interface ChatRouteContentProps {
  // Send message (orchestration owns the SSE / queue lifecycle)
  sendMessage: (content: string, attachments?: DisplayAttachment[]) => Promise<void>;
  handleStopGenerating: () => Promise<void>;
  queuedMessages: DisplayMessage[];
  handleCancelQueuedMessage: (messageId: string) => void;
  handleCancelAllQueued: () => void;
  handleSteerMessage: (messageId: string) => void;
  handleEditQueueTail: () => void;

  // Conversation secondary actions (orchestration dependency)
  handleForkConversation: (throughMessageId: string) => Promise<void>;
  handleInspectMessage?: (messageId: string) => void;

  // History pagination (from useConversationLoader in ActiveChatView)
  historyPagination: HistoryPaginationResult;

  // Draft input (shared — keydown handler + deep link consumer in ActiveChatView)
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  saveDraft: (key: string, text: string) => void;
  clearDraft: (key: string) => void;
  restoredDraftConversationId: string | null;
  setRestoredDraftConversationId: Dispatch<SetStateAction<string | null>>;

  // Attachments (shared — reset called by switchConversation in orchestration)
  chatAttachments: ChatAttachment[];
  attachmentsUploadingCount: number;
  attachmentUploadedIds: string[];
  attachmentLastError: string | null;
  addChatAttachmentFiles: (files: File[] | FileList) => void;
  removeChatAttachment: (id: string) => void;
  resetChatAttachments: () => void;
  dismissChatAttachmentError: () => void;

  // Disk pressure (single instance lives in ActiveChatView; passed down to
  // avoid duplicate polling intervals and bus subscriptions)
  diskPressure: UseDiskPressureMonitorResult;

  // Upward signals to ActiveChatView local state
  setShowAddCreditsModal: Dispatch<SetStateAction<boolean>>;
  setRefreshEpoch: Dispatch<SetStateAction<number>>;

  // Shared refs (owned by ActiveChatView for debug API / keydown handler)
  inputRef: RefObject<HTMLTextAreaElement | null>;
  sanitizedMessagesRef: MutableRefObject<DisplayMessage[]>;
  transcriptItemsRef: MutableRefObject<TranscriptItem[]>;
  transcriptRef: RefObject<TranscriptHandle | null>;
  uiContextRef: MutableRefObject<UIContext | null>;

  // Onboarding (local state in ActiveChatView)
  onboardingTasksEmpty: boolean;
  didOnboarding: boolean;
  onboardingConversationId: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChatRouteContent({
  sendMessage,
  handleStopGenerating,
  queuedMessages,
  handleCancelQueuedMessage,
  handleCancelAllQueued,
  handleSteerMessage,
  handleEditQueueTail,
  handleForkConversation,
  handleInspectMessage,
  historyPagination,
  input,
  setInput,
  saveDraft,
  clearDraft,
  restoredDraftConversationId,
  setRestoredDraftConversationId,
  chatAttachments,
  attachmentsUploadingCount,
  attachmentUploadedIds,
  attachmentLastError,
  addChatAttachmentFiles,
  removeChatAttachment,
  resetChatAttachments,
  dismissChatAttachmentError,
  diskPressure,
  setShowAddCreditsModal,
  setRefreshEpoch,
  inputRef,
  sanitizedMessagesRef,
  transcriptItemsRef,
  transcriptRef,
  uiContextRef,
  onboardingTasksEmpty,
  didOnboarding,
  onboardingConversationId,
}: ChatRouteContentProps) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  // -------------------------------------------------------------------------
  // Store reads — identity, lifecycle, feature flags
  // -------------------------------------------------------------------------
  const assistantId = useAssistantSelectionStore.use.activeAssistantId();
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  const assistantName = useAssistantIdentityStore.use.name();
  const chatPullToRefreshEnabled = useClientFeatureFlagStore.use.chatPullToRefreshEnabled();
  const deployToVercel = useAssistantFeatureFlagStore.use.deployToVercel();
  const doctorEnabled = useClientFeatureFlagStore.use.doctor();

  // -------------------------------------------------------------------------
  // Store reads — per-conversation state
  // -------------------------------------------------------------------------
  const messages = useChatSessionStore.use.messages();
  const error = useChatSessionStore.use.error();
  const setError = useChatSessionStore.use.setError();
  const isLoadingHistory = useChatSessionStore.use.isLoadingHistory();
  const contextWindowUsage = useChatSessionStore.use.contextWindowUsage();
  const compactionCircuitOpenUntil = useChatSessionStore.use.compactionCircuitOpenUntil();
  const setCompactionCircuitOpenUntil = useChatSessionStore.use.setCompactionCircuitOpenUntil();
  const transcriptPagination = useChatSessionStore.use.transcriptPagination();

  // -------------------------------------------------------------------------
  // Store reads — conversation, viewer
  // -------------------------------------------------------------------------
  const activeConversationId = useConversationStore.use.activeConversationId();
  const editingConversationId = useConversationStore.use.editingConversationId();
  const processingConversationIds = useConversationStore.use.processingConversationIds();
  const mainView = useViewerStore.use.mainView();
  const openedAppState = useViewerStore.use.openedAppState();
  const openedDocumentState = useViewerStore.use.openedDocumentState();
  const activeSubagentId = useViewerStore.use.activeSubagentId();
  const subagentById = useSubagentStore((s) => s.byId);

  // Active conversation (TanStack Query — deduped with ActiveChatView's call)
  const activeConversation = useActiveConversation(assistantId, activeConversationId, true);
  const isChannelReadonly = isChannelConversation(activeConversation);

  // Conversation count (for nudges — TanStack Query deduped)
  const { conversations } = useConversationListQuery(assistantId, true);

  // -------------------------------------------------------------------------
  // UI-scoped hooks (moved from ActiveChatView — no prop relay needed)
  // -------------------------------------------------------------------------
  const avatar = useAssistantAvatar(assistantId);
  const { components: avatarComponents, traits: avatarTraits, customImageUrl: avatarImageUrl } = avatar;



  const {
    voiceInputRef,
    voiceInterim,
    voiceError,
    clearVoiceError,
    setVoiceError,
    handleVoiceBeforeStart,
    handleVoiceTranscript,
    setVoiceInterim,
    handleRetryMicPermission,
  } = useVoiceInput({ assistantId, inputRef, setInput });

  const {
    handleSecretSubmit,
    handleSecretCancel,
    handleContactPromptSubmit,
    handleContactPromptCancel,
    handleConfirmationSubmit,
    handleAllowAndCreateRule,
    handleOpenRuleEditorForToolCall,
    handleSaveRule,
    handleSaveAsNewRule,
    showRuleEditor,
    ruleEditorContext,
    dismissRuleEditor,
    isSavingRule,
    handleQuestionResponse,
    handleSurfaceAction,
    unknownNudgeToolCallIds,
    setUnknownNudgeToolCallIds,
  } = useInteractionActions();

  const handleOpenApp = useOpenAppFromChat();

  // -------------------------------------------------------------------------
  // App / document / subagent action callbacks
  // -------------------------------------------------------------------------
  const handleOpenDocument = useCallback((surfaceId: string) => {
    haptic.light();
    if (assistantId) void useViewerStore.getState().loadDocument(assistantId, surfaceId);
  }, [assistantId]);

  const handleCloseDocument = useCallback(() => {
    useViewerStore.getState().closeDocument();
  }, []);

  const handleCloseApp = useCallback(() => {
    useViewerStore.getState().closeApp();
    useConversationStore.getState().setEditingConversationId(null);
  }, []);

  const handleCloseEditPanel = useCallback(() => {
    useConversationStore.getState().setEditingConversationId(null);
    useViewerStore.getState().exitAppEditing();
  }, []);

  const editApp = useEditApp();
  const handleEditApp = useCallback(() => {
    const oas = useViewerStore.getState().openedAppState;
    if (oas) editApp(oas);
  }, [editApp]);

  const handleShareApp = useCallback(() => {
    const app = useViewerStore.getState().openedAppState;
    if (app && assistantId) void useDeployStore.getState().shareApp(assistantId, app.appId, app.name);
  }, [assistantId]);

  const handleDeployApp = useCallback(() => {
    const app = useViewerStore.getState().openedAppState;
    if (app && assistantId) void useDeployStore.getState().deployApp(assistantId, app.appId, app.name, app.html);
  }, [assistantId]);

  const onSubagentClick = useCallback((id: string) => {
    useViewerStore.getState().openSubagentDetail(id);
  }, []);

  const onCloseSubagentDetail = useCallback(() => {
    useViewerStore.getState().closeSubagentDetail();
  }, []);

  const onStopSubagent = useCallback(async (subagentId: string) => {
    if (!assistantId || !activeConversationId) return;
    try {
      await subagentsByIdAbortPost({
        path: { assistant_id: assistantId, id: subagentId },
        body: { conversationId: activeConversationId },
        throwOnError: true,
      });
    } catch {
      // Best-effort abort
    }
  }, [assistantId, activeConversationId]);

  const onRequestSubagentDetail = useCallback((subagentId: string) => {
    if (!assistantId) return;
    void useSubagentStore.getState().fetchDetailIfNeeded(assistantId, subagentId);
  }, [assistantId]);

  const pushToAiSettings = useCallback(() => {
    void navigate(routes.settings.ai);
  }, [navigate]);

  const checkAssistant = useCallback(() => lifecycleService.checkAssistant(), []);

  // -------------------------------------------------------------------------
  // Turn state (read from Zustand store)
  // -------------------------------------------------------------------------
  const phase = useTurnStore.use.phase();
  const pendingQueuedCount = useTurnStore.use.pendingQueuedCount();
  const activeToolCallCount = useTurnStore.use.activeToolCallCount();
  const activeTurnId = useTurnStore.use.activeTurnId();
  const lastTerminalReason = useTurnStore.use.lastTerminalReason();
  const statusText = useTurnStore.use.statusText();
  const liveWebActivity = useTurnStore.use.liveWebActivity();
  const autoRoutedProfileLabel = useTurnStore.use.autoRoutedProfileLabel();
  const turnState: TurnState = { phase, pendingQueuedCount, activeToolCallCount, activeTurnId, lastTerminalReason, statusText, liveWebActivity, autoRoutedProfileLabel };

  // -------------------------------------------------------------------------
  // Deploy / share state (from Zustand store)
  // -------------------------------------------------------------------------

  const isSharing = useDeployStore.use.isSharing();
  const isDeploying = useDeployStore.use.isDeploying();

  // -------------------------------------------------------------------------
  // Tool-call detail drawer (from Zustand viewer store)
  // -------------------------------------------------------------------------

  const activeToolDetail = useViewerStore.use.activeToolDetail();
  const closeToolDetail = useViewerStore.use.closeToolDetail();

  /** Open the rule editor for the tool call shown in the detail panel. */
  const handleToolDetailRiskBadgeClick = useCallback(() => {
    if (!activeToolDetail) {
      return;
    }
    const tc = messages
      .flatMap((m) => m.toolCalls ?? [])
      .find((t) => t.id === activeToolDetail.toolCallId);
    if (!tc) {
      return;
    }
    handleOpenRuleEditorForToolCall(toolCallToRuleContext(tc));
  }, [activeToolDetail, messages, handleOpenRuleEditorForToolCall]);

  // The mobile tool-detail overlay lives in a separate portal subtree
  // (`MobileChatOverlays`) and can't reach the rule-editor state owned here, so
  // it signals through the viewer store. Open the editor whenever the request
  // seq advances past the last one we handled.
  const ruleEditorRequestSeq = useViewerStore.use.ruleEditorRequestSeq();
  const handledRuleEditorSeqRef = useRef(ruleEditorRequestSeq);
  useEffect(() => {
    if (ruleEditorRequestSeq === handledRuleEditorSeqRef.current) {
      return;
    }
    handledRuleEditorSeqRef.current = ruleEditorRequestSeq;
    handleToolDetailRiskBadgeClick();
  }, [ruleEditorRequestSeq, handleToolDetailRiskBadgeClick]);

  // -------------------------------------------------------------------------
  // Feature flags
  // -------------------------------------------------------------------------

  const queueSteering = useAssistantFeatureFlagStore.use.queueSteering();

  // -------------------------------------------------------------------------
  // Interaction state (from Zustand store)
  // -------------------------------------------------------------------------

  const pendingSecret = useInteractionStore.use.pendingSecret();
  const pendingConfirmation = useInteractionStore.use.pendingConfirmation();
  const pendingContactRequest = useInteractionStore.use.pendingContactRequest();
  const pendingQuestion = useInteractionStore.use.pendingQuestion();
  const isSubmittingSecret = useInteractionStore.use.isSubmittingSecret();
  const isSubmittingConfirmation = useInteractionStore.use.isSubmittingConfirmation();
  const isSubmittingContactRequest = useInteractionStore.use.isSubmittingContactRequest();
  const isSubmittingQuestion = useInteractionStore.use.isSubmittingQuestion();
  const contactRequestAccepted = useInteractionStore.use.contactRequestAccepted();
  const secretSaved = useInteractionStore.use.secretSaved();
  const inlineConfirmationToolCallId = useInteractionStore.use.inlineConfirmationToolCallId();
  const inlineConfirmationAttached = inlineConfirmationToolCallId !== null;

  // -------------------------------------------------------------------------
  // Onboarding choice card
  // -------------------------------------------------------------------------

  const isNative = useIsNativePlatform();
  const {
    showOnboardingChoice,
    handleSubmitTasks,
    handleSelectSpecific,
    dismiss: _dismissOnboardingChoice,
  } = useOnboardingChoice({
    isNative,
    didOnboarding,
    messages,
    onboardingTasksEmpty,
    activeConversationId,
    onboardingConversationId,
    sendMessage,
  });

  // -------------------------------------------------------------------------
  // Edit-message recall (up-arrow)
  // -------------------------------------------------------------------------

  const { editingMessageId, isEditing, startEditing, cancelEditing } = useEditMessage(messages);

  // -------------------------------------------------------------------------
  // Derived values
  // -------------------------------------------------------------------------

  const hasUncompletedVisibleSurface = useMemo(
    () => hasAnyInteractiveSurface(messages),
    [messages],
  );

  // Derive "is this conversation processing?" as an OR of the local
  // optimistic set (driven by `useSendMessage` and the SSE start
  // handlers) and the server's cached snapshot (`isProcessing` on the
  // conversation row, mirroring the daemon's `Conversation.isProcessing()`).
  //
  // Either signal is sufficient to light the avatar progress badge.
  // They converge via terminal SSE handlers (which clear the local set
  // AND patch the cached snapshot via `patchConversation`) and the
  // next list/detail GET refreshing the server snapshot. The OR also
  // makes us robust to pre-0.8.7 daemons that omit `isProcessing` on
  // the wire — the fallback to the local set still drives the badge.
  const activeConversationIsProcessing =
    (activeConversationId != null &&
      processingConversationIds.has(activeConversationId)) ||
    !!activeConversation?.isProcessing;

  const activeConversationHasPendingAssistantResponse = useMemo(
    () => hasPendingAssistantResponse(messages),
    [messages],
  );

  const liveAssistantMessageId = useMemo(
    () => liveAssistantRowId(messages, activeConversationIsProcessing),
    [messages, activeConversationIsProcessing],
  );
  const hasStreamingAssistantMessage = liveAssistantMessageId != null;

  // Nudges (depends on liveAssistantMessageId)
  const nudges = useAppNudges(messages, conversations.length, liveAssistantMessageId);

  // Ghost text suggestion (depends on liveAssistantMessageId)
  const lastCompleteAssistantMsgId = useMemo<string | null>(() => {
    const last = messages[messages.length - 1];
    return last &&
      last.role === "assistant" &&
      last.id !== liveAssistantMessageId
      ? last.id ?? null
      : null;
  }, [messages, liveAssistantMessageId]);

  const suggestion = useGhostTextSuggestion({
    assistantId,
    conversationId: activeConversationId,
    lastCompleteAssistantMsgId,
  });

  const uiContext: UIContext = useMemo(
    () => ({
      hasStreamingAssistantMessage,
      hasPendingSecret: !!pendingSecret,
      hasPendingConfirmation: !!pendingConfirmation,
      hasPendingQuestion: !!pendingQuestion,
      hasPendingContactRequest: !!pendingContactRequest,
      hasUncompletedVisibleSurface,
      activeConversationIsProcessing,
      hasPendingAssistantResponse: activeConversationHasPendingAssistantResponse,
    }),
    [
      hasStreamingAssistantMessage,
      pendingSecret,
      pendingConfirmation,
      pendingQuestion,
      pendingContactRequest,
      hasUncompletedVisibleSurface,
      activeConversationIsProcessing,
      activeConversationHasPendingAssistantResponse,
    ],
  );

  // Publish the rendered context (in an effect, after commit — never mutate a
  // ref during render) so the debug API reports on-screen state instead of a
  // separate recomputation (see useChatDebugRegistration). Clear it on unmount
  // so the debug API falls back to its empty default instead of reporting the
  // last rendered frame (which could claim a badge is processing) while no chat
  // content is on screen.
  useEffect(() => {
    uiContextRef.current = uiContext;
    return () => {
      uiContextRef.current = null;
    };
  }, [uiContextRef, uiContext]);

  const showThinking = shouldShowThinkingIndicator(turnState, uiContext);
  const isAssistantStreaming =
    showThinking || hasStreamingAssistantMessage;
  const canStopGenerating = canStopGeneration(turnState, uiContext);

  const diskPressureChatBlockReason = getDiskPressureChatBlockReason({
    monitorEnabled: diskPressure.mode !== null,
    hasResolvedStatus: diskPressure.hasResolvedStatus,
    status: diskPressure.status,
  });
  const diskPressureInputDisabled = diskPressureChatBlockReason !== null;

  const typingDisabled =
    isLoadingHistory ||
    (assistantState.kind === "active" && !!assistantState.maintenanceMode?.enabled) ||
    diskPressureInputDisabled ||
    isChannelReadonly;

  const sendDisabled =
    isSendDisabled(turnState, uiContext) || typingDisabled;

  const isEmptyConversation =
    !!activeConversationId &&
    !isLoadingHistory &&
    messages.length === 0 &&
    !(assistantState.kind === "active" && assistantState.maintenanceMode?.enabled);

  // Conversation starters power the empty-state chips only. Gate the fetch
  // by `isEmptyConversation` so non-empty chats stop polling the daemon for
  // data that's never rendered.
  const { starters: conversationStarters } = useConversationStarters(
    isEmptyConversation ? assistantId : null,
  );

  const genericChatError = shouldShowGenericChatErrorNotice(error) && error
    ? {
        message: error.message,
        actions: doctorEnabled ? (
          <Button asChild variant="outlined" size="compact">
            <Link to={`${routes.settings.debug}?tab=doctor`}>
              Go to Doctor
            </Link>
          </Button>
        ) : undefined,
      }
    : null;

  // Modal-mode errors (e.g. secret_blocked from a fresh new-conversation
  // POST) interrupt with a dialog and restore the user's text back into the
  // composer on dismiss so they can edit and resend without retyping.
  const sendErrorModalNode =
    error?.displayAs === "modal" ? (
      <SendErrorModal
        open
        message={error.message}
        onClose={() => {
          if (typeof error.restoreContent === "string") {
            setInput(error.restoreContent);
          }
          setError(null);
        }}
      />
    ) : null;

  const ruleEditorModalNode =
    showRuleEditor && ruleEditorContext ? (
      <ChatRuleEditorModal
        context={ruleEditorContext}
        isSaving={isSavingRule}
        onSave={handleSaveRule}
        onSaveAsNew={handleSaveAsNewRule}
        onDismiss={dismissRuleEditor}
      />
    ) : null;

  const canSendAttachments =
    attachmentsUploadingCount === 0 && attachmentUploadedIds.length > 0;

  // Vision capability gate for the AttachFileButton. The daemon's
  // chat-completions adapter does not strip image parts, so providers
  // without vision (MiniMax, Fireworks Kimi, several OpenRouter models)
  // return confusing errors when the UI sends an image. The daemon's
  // config API is the source of truth — fall back to the permissive
  // client-side helper only when the daemon hasn't surfaced the flag.
  const activeProfileModel = useActiveProfileModel(
    assistantId,
    activeConversation?.conversationId,
  );
  // `modelSupportsVision` from `assistant/model-capabilities` would pull the
  // entire LLM model catalog (~12 kB) into the chat-critical bundle just to
  // return `true` as a permissive fallback. The daemon's `supportsVision` is
  // the source of truth; fail-open here when it isn't surfaced yet.
  const activeModelSupportsVision = activeProfileModel?.supportsVision ?? true;

  const showUploadBlockedNotice =
    attachmentsUploadingCount > 0 &&
    (input.trim().length > 0 || attachmentUploadedIds.length > 0);

  const showRestoredDraftNotice =
    restoredDraftConversationId !== null &&
    restoredDraftConversationId === activeConversationId;

  const isInMaintenanceWithNoMessages =
    !isLoadingHistory &&
    messages.length === 0 &&
    assistantState.kind === "active" &&
    assistantState.maintenanceMode?.enabled === true;

  // -------------------------------------------------------------------------
  // Child-owned refs
  // -------------------------------------------------------------------------

  const shouldFocusInputRef = useRef(false);

  // -------------------------------------------------------------------------
  // Attachment drop zone
  // -------------------------------------------------------------------------

  const {
    isDragOver: isAttachmentDragOver,
    dropHandlers: attachmentDropHandlers,
  } = useChatAttachmentDropZone({
    onFiles: addChatAttachmentFiles,
    disabled: typingDisabled || !assistantId,
  });

  // -------------------------------------------------------------------------
  // Refresh conversation (destructive)
  // -------------------------------------------------------------------------

  const onRefreshEpoch = useCallback(() => {
    if (activeConversationId) {
      const currentInput = inputRef.current?.value ?? "";
      saveDraft(activeConversationId, currentInput);
    }
    setRefreshEpoch((prev) => prev + 1);
  }, [activeConversationId, inputRef, saveDraft, setRefreshEpoch]);

  // -------------------------------------------------------------------------
  // Pull-to-refresh
  // -------------------------------------------------------------------------

  const {
    refreshFeedback,
    touchSupported,
    handlePullRefresh,
    handleDismissRefreshFeedback,
    handleRetryRefreshFromPill,
  } = usePullRefresh({
    activeConversationId,
    invalidateHistory: historyPagination.invalidate,
    onRefreshEpoch,
  });

  // -------------------------------------------------------------------------
  // Load older messages
  // -------------------------------------------------------------------------

  const loadOlder = useCallback(() => {
    historyPagination.fetchOlderPage();
  }, [historyPagination.fetchOlderPage]);

  // -------------------------------------------------------------------------
  // Transcript items (projection of chat state onto flat list)
  // -------------------------------------------------------------------------

  const thinkingLabel = getThinkingStatusText(turnState);

  // Single render-boundary cleanup pass. `sanitizeDisplayMessages` houses
  // every "this shouldn't be necessary, but is" hack we apply before the
  // transcript renders (timestamp sort, blank/phantom row filter, duplicate
  // trailing assistant drop). See `sanitize-display-messages.ts` for the
  // rationale and removal triggers for each sub-step.
  const sanitizedMessages = useMemo(
    () => sanitizeDisplayMessages(messages),
    [messages],
  );

  useLayoutEffect(() => { sanitizedMessagesRef.current = sanitizedMessages; });

  const transcriptItems = useMemo(
    () =>
      buildTranscriptItems({
        messages: sanitizedMessages,
        pendingSecret: pendingSecret
          ? { requestId: pendingSecret.requestId }
          : null,
        pendingConfirmation: pendingConfirmation && !inlineConfirmationAttached
          ? { requestId: pendingConfirmation.requestId }
          : null,
        pendingContactRequest: pendingContactRequest
          ? {
              requestId: pendingContactRequest.requestId,
              channel: pendingContactRequest.channel,
              placeholder: pendingContactRequest.placeholder,
              label: pendingContactRequest.label,
              description: pendingContactRequest.description,
              role: pendingContactRequest.role,
            }
          : null,
        isThinking: showThinking,
        thinkingLabel,
        autoRoutedProfileLabel,
        errorNotice: null,
        showOnboardingChoice,
      }),
    [
      sanitizedMessages,
      pendingSecret,
      pendingConfirmation,
      inlineConfirmationAttached,
      pendingContactRequest,
      showThinking,
      thinkingLabel,
      autoRoutedProfileLabel,
      showOnboardingChoice,
    ],
  );

  useLayoutEffect(() => { transcriptItemsRef.current = transcriptItems; });

  // -------------------------------------------------------------------------
  // Scroll coordination
  // -------------------------------------------------------------------------

  const scrollCoordinator = useTranscriptScroll({
    transcriptRef,
    items: transcriptItems,
    conversationId: activeConversationId,
    hasMore: transcriptPagination.hasMore,
    isLoadingOlder: transcriptPagination.isLoadingOlder,
    onLoadOlder: loadOlder,
  });

  const handleScrollToLatest = useCallback(() => {
    scrollCoordinator.scrollToLatest({ behavior: "smooth" });
  }, [scrollCoordinator]);

  // -------------------------------------------------------------------------
  // Focus effect
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!typingDisabled && !sendDisabled && shouldFocusInputRef.current) {
      shouldFocusInputRef.current = false;
      inputRef.current?.focus();
    }
  }, [typingDisabled, sendDisabled, inputRef]);

  // -------------------------------------------------------------------------
  // Draft notice auto-dismiss
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!showRestoredDraftNotice) return;
    const id = window.setTimeout(() => {
      setRestoredDraftConversationId(null);
    }, 5000);
    return () => window.clearTimeout(id);
  }, [showRestoredDraftNotice, setRestoredDraftConversationId]);

  useEffect(() => {
    if (
      restoredDraftConversationId !== null &&
      restoredDraftConversationId !== activeConversationId
    ) {
      setRestoredDraftConversationId(null);
    }
  }, [activeConversationId, restoredDraftConversationId, setRestoredDraftConversationId]);

  // -------------------------------------------------------------------------
  // Composer submit
  // -------------------------------------------------------------------------

  const handleSubmit = useCallback(async (e: FormEvent, inputOverride?: string) => {
    e.preventDefault();
    const trimmed = (inputOverride ?? input).trim();
    if (sendDisabled) return;
    if (!trimmed && attachmentUploadedIds.length === 0) return;
    if (attachmentsUploadingCount > 0) return;
    const attachmentsToSend: DisplayAttachment[] = chatAttachments
      .filter(
        (att): att is Extract<typeof att, { kind: "uploaded" }> => att.kind === "uploaded",
      )
      .map((att) => ({
        id: att.id,
        filename: att.filename,
        mimeType: att.mimeType,
        sizeBytes: att.sizeBytes,
        previewUrl: att.previewUrl ?? null,
      }));
    setInput("");
    // (The ghost-text suggestion clears automatically — once the user
    // message lands in `messages` the suggestion query key derives
    // `lastCompleteAssistantMsgId = null` and the cached value is no
    // longer matched. See `useGhostTextSuggestion`. — LUM-2009)
    if (activeConversationId) {
      clearDraft(activeConversationId);
    }
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
    resetChatAttachments();
    if (!isPointerCoarse()) {
      shouldFocusInputRef.current = true;
    }
    haptic.medium();
    // Engage the auto-pin window so the new turn lands at the bottom
    // — even if the user had scrolled up while composing — and so the
    // initial response render (which expands LatestTurnRow via
    // useViewportMinHeight) stays anchored at the latest message.
    scrollCoordinator.scrollToLatest({ behavior: "auto" });
    if (isEditing && editingMessageId && assistantId && activeConversationId) {
      cancelEditing();
      try {
        await conversationsByIdUndoPost({
          path: { assistant_id: assistantId, id: activeConversationId },
        });
      } catch {
        // If undo fails, still send the message as a new one
      }
    }
    await sendMessage(trimmed, attachmentsToSend);
  }, [input, sendDisabled, attachmentUploadedIds.length, attachmentsUploadingCount, activeConversationId, chatAttachments, resetChatAttachments, sendMessage, setInput, clearDraft, inputRef, scrollCoordinator, isEditing, editingMessageId, assistantId, cancelEditing]);

  const handleSelectStarter = (starter: { prompt: string }) => {
    setInput(starter.prompt);
    void handleSubmit(
      { preventDefault: () => {} } as unknown as FormEvent,
      starter.prompt,
    );
  };

  // -------------------------------------------------------------------------
  // Dismiss pending question
  // -------------------------------------------------------------------------

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
  // Empty state placeholder (stable per mount)
  // -------------------------------------------------------------------------

  const emptyStatePlaceholder = useMemo(() => pickRandomPlaceholder(), []);

  const emptyStateGreeting = useEmptyStateGreeting(assistantId);

  // -------------------------------------------------------------------------
  // Disk pressure banner
  // -------------------------------------------------------------------------

  // `dismissed` clears when disk pressure exits the warning state; `suppressed`
  // is the "Don't show again" choice and persists across state transitions.
  const dismissedKey = assistantId
    ? `vellum:diskPressureDismissed:${assistantId}`
    : null;
  const suppressedKey = assistantId
    ? `vellum:diskPressureSuppressed:${assistantId}`
    : null;

  const [warningDismissed, setWarningDismissed] = useState(() => {
    if (!dismissedKey) return false;
    return getLocalBool(dismissedKey, false);
  });
  const [warningSuppressed, setWarningSuppressed] = useState(() => {
    if (!suppressedKey) return false;
    return getLocalBool(suppressedKey, false);
  });

  const dismissWarning = useCallback(
    (permanent: boolean) => {
      if (permanent) {
        if (suppressedKey) {
          setLocalBool(suppressedKey, true);
        }
        setWarningSuppressed(true);
        return;
      }
      if (dismissedKey) {
        setLocalBool(dismissedKey, true);
      }
      setWarningDismissed(true);
    },
    [dismissedKey, suppressedKey],
  );

  // Clear the per-episode dismiss on state change; the suppressed flag is
  // intentionally not cleared here so "Don't show again" actually sticks.
  useEffect(() => {
    const st = diskPressure.status?.state;
    if (st && st !== "warning" && warningDismissed) {
      if (dismissedKey) {
        removeLocalSetting(dismissedKey);
      }
      setWarningDismissed(false);
    }
  }, [diskPressure.status?.state, warningDismissed, dismissedKey]);

  const renderDiskPressureBanner = useCallback((): ReactNode => {
    if (!diskPressure.status) return null;
    const mode = diskPressure.mode === "inactive" ? null : (diskPressure.mode as DiskPressureBannerMode | null);
    if (!mode) return null;
    if (mode === "warning" && (warningDismissed || warningSuppressed)) return null;
    return (
      <DiskPressureBanner
        status={diskPressure.status}
        mode={mode}
        isAcknowledging={diskPressure.isAcknowledging}
        acknowledgeError={diskPressure.acknowledgeError?.message ?? null}
        onAcknowledge={() => void diskPressure.acknowledge()}
        onDismissWarning={dismissWarning}
        onReviewWorkspaceData={() => void navigate(routes.workspace)}
        // Only platform-hosted assistants (kind === "active") have a billing plan to upgrade.
        // No dedicated hosting-topology store exists yet, so we read from the assistantState prop.
        onUpgradeStorage={assistantState.kind === "active" ? () => void navigate(`${routes.settings.billing}?adjust_plan=1`) : null}
      />
    );
  }, [diskPressure, navigate, assistantState.kind, warningDismissed, warningSuppressed, dismissWarning]);

  // -------------------------------------------------------------------------
  // Billing composer banner
  // -------------------------------------------------------------------------

  const billingBannerDecision = getChatBillingBannerDecision(error);

  const renderBillingComposerBanner = (): ReactNode => {
    if (billingBannerDecision === "managed_credits") {
      return (
        <CreditsExhaustedBanner
          onAddFunds={() => setShowAddCreditsModal(true)}
        />
      );
    }
    if (billingBannerDecision === "provider_billing") {
      return (
        <ProviderBillingBanner
          onOpenSettings={pushToAiSettings}
        />
      );
    }
    return null;
  };

  // -------------------------------------------------------------------------
  // JSX construction variables
  // -------------------------------------------------------------------------

  const textStateNoticesJsx = (
    <>
      {showUploadBlockedNotice && (
        <div className="mb-2">
          <Notice tone="info">
            {attachmentsUploadingCount === 1
              ? "Waiting for the attachment to finish uploading before sending."
              : `Waiting for ${attachmentsUploadingCount} attachments to finish uploading before sending.`}
          </Notice>
        </div>
      )}
      {showRestoredDraftNotice && (
        <div className="mb-2">
          <Notice
            tone="info"
            onDismiss={() => setRestoredDraftConversationId(null)}
          >
            Draft restored from your previous session.
          </Notice>
        </div>
      )}
    </>
  );

  // When the chat is rendered for editing an opened app, override the empty
  // state greeting + starters so the first impression is app-specific. Each
  // starter's `prompt` embeds the app reference so the assistant knows which
  // app to load on the first message.
  const editingApp =
    mainView === "app-editing" && openedAppState
      ? { name: openedAppState.name, dirName: openedAppState.dirName }
      : null;

  const chatEmptyStateProps: ChatEmptyStateProps = {
    avatarSlot:
      avatarComponents || avatarImageUrl ? (
        <ChatAvatar
          components={avatarComponents}
          traits={avatarTraits}
          customImageUrl={avatarImageUrl}
          size={40}
          interactive
          isProcessing={activeConversationIsProcessing}
        />
      ) : null,
    greeting: editingApp ? buildEditAppGreeting(editingApp) : emptyStateGreeting,
  };

  /**
   * Conversation-starter chips rendered below the composer on the empty
   * state. Passed as a `startersSlot` to {@link ChatBody} so the chips
   * appear after the composer while the greeting + composer + starters
   * center as one visual group (LUM-1566).
   */
  const emptyStateStarters = editingApp
    ? buildEditAppStarters(editingApp)
    : conversationStarters;

  const startersSlot =
    isEmptyConversation && emptyStateStarters.length > 0 ? (
      <div className="mt-4">
        <ConversationStarterGrid
          starters={emptyStateStarters}
          onSelect={handleSelectStarter}
        />
      </div>
    ) : undefined;

  // Stable callback so the latest-turn avatar slot isn't rebuilt on every
  // transcript render. Paired with `memo(ChatAvatar)`, the avatar re-renders
  // only when its inputs actually change (avatar data, or the streaming /
  // processing flags) rather than on each parent render.
  const renderAvatar = useMemo(
    () =>
      avatarComponents || avatarImageUrl
        ? () => (
            <ChatAvatar
              components={avatarComponents}
              traits={avatarTraits}
              customImageUrl={avatarImageUrl}
              size={56}
              interactive
              isStreaming={isAssistantStreaming}
              isProcessing={activeConversationIsProcessing}
            />
          )
        : undefined,
    [
      avatarComponents,
      avatarImageUrl,
      avatarTraits,
      isAssistantStreaming,
      activeConversationIsProcessing,
    ],
  );

  const chatTranscriptProps: TranscriptProps = {
    items: transcriptItems,
    conversationId: activeConversationId,
    assistantDisplayName: assistantName?.trim() || undefined,
    expandedToolCallIds: useChatSessionStore.getState().expandedToolCallIds,
    onOpenRuleEditor: handleOpenRuleEditorForToolCall,
    onOpenApp: handleOpenApp,
    onOpenDocument: handleOpenDocument,
    assistantId,
    unknownNudgeToolCallIds,
    onDismissUnknownNudge: (toolCallId) =>
      setUnknownNudgeToolCallIds((ids) => {
        const next = new Set(ids);
        next.delete(toolCallId);
        return next;
      }),
    onSurfaceAction: (surfaceId, action, input) => {
      void handleSurfaceAction(
        surfaceId,
        action,
        input as Record<string, unknown> | undefined,
      );
    },
    onSecretSubmit: () => {},
    onConfirmationDecision: () => {},
    isSubmittingConfirmation,
    onConfirmationSubmit: handleConfirmationSubmit,
    onAllowAndCreateRule:
      pendingConfirmation?.persistentDecisionsAllowed !== false &&
      (pendingConfirmation?.allowlistOptions?.length ?? 0) > 0
        ? handleAllowAndCreateRule
        : undefined,
    pendingConfirmationToolCallId: inlineConfirmationToolCallId ?? undefined,
    onRetryError: () => setError(null),
    onForkConversation: (messageId) => {
      void handleForkConversation(messageId);
    },
    onInspectMessage: handleInspectMessage,
    renderPendingSecret: () =>
      pendingSecret ? (
        <SecretPromptCard
          secret={pendingSecret}
          isSubmitting={isSubmittingSecret}
          saved={secretSaved}
          onSave={(val) => handleSecretSubmit(val, "store")}
          onSendOnce={(val) => handleSecretSubmit(val, "transient_send")}
          onCancel={handleSecretCancel}
        />
      ) : null,
    renderPendingConfirmation: () =>
      pendingConfirmation ? (
        <ConfirmationPromptCard
          confirmation={pendingConfirmation}
          isSubmitting={isSubmittingConfirmation}
          onSubmit={handleConfirmationSubmit}
          onAllowAndCreateRule={
            pendingConfirmation.persistentDecisionsAllowed !== false &&
            (pendingConfirmation.allowlistOptions?.length ?? 0) > 0
              ? handleAllowAndCreateRule
              : undefined
          }
        />
      ) : null,
    renderPendingContactRequest: () =>
      pendingContactRequest ? (
        <ContactPromptCard
          contactRequest={pendingContactRequest}
          isSubmitting={isSubmittingContactRequest}
          accepted={contactRequestAccepted}
          onSubmit={handleContactPromptSubmit}
          onCancel={handleContactPromptCancel}
        />
      ) : null,
    renderAvatar,
    onPullRefresh: handlePullRefresh,
    pullRefreshEnabled: chatPullToRefreshEnabled && touchSupported,
    scrollCoordinatorState: {
      showScrollToLatest: scrollCoordinator.showScrollToLatest,
      shouldLoadOlder: false, // Not exposed by scroll coordinator; safe default
    },
    onSubagentClick,
    onStopSubagent,
    renderOnboardingChoice: () => (
      <OnboardingChoiceCard
        onSelectSpecific={handleSelectSpecific}
        onSubmitTasks={handleSubmitTasks}
      />
    ),
  };

  const sharedComposerNoticeProps = {
    billingBannerSlot: renderBillingComposerBanner(),
    diskPressureBanner: renderDiskPressureBanner(),
    showMissingApiKeyBanner:
      error?.code === "PROVIDER_NOT_CONFIGURED" ||
      error?.code === "MANAGED_KEY_INVALID",
    onOpenAiSettings: pushToAiSettings,
    onDismissApiKeyError: () => setError(null),
    compactionCircuitOpenUntil,
    onCompactionCircuitExpired: () => setCompactionCircuitOpenUntil(null),
    showMaintenanceBanner:
      assistantState.kind === "active" &&
      assistantState.maintenanceMode?.enabled === true,
    assistantId,
    onMaintenanceExited: () => void checkAssistant(),
  };

  const chatBodyComposerProps = {
    input,
    setInput,
    placeholder: isEmptyConversation
      ? emptyStatePlaceholder
      : "What would you like to do?",
    onSubmit: (e: FormEvent) => void handleSubmit(e),
    inputRef,
    typingDisabled,
    sendDisabled,
    attachmentsUploadingCount,
    canSendAttachments,
    chatAttachments,
    onAddAttachmentFiles: addChatAttachmentFiles,
    onRemoveAttachment: removeChatAttachment,
    voiceInputRef,
    voiceInterim: voiceInterim ?? undefined,
    onVoiceTranscript: (rawText: string) => handleVoiceTranscript(rawText),
    onVoiceInterimTranscript: setVoiceInterim,
    onVoiceError: setVoiceError,
    onVoiceBeforeStart: handleVoiceBeforeStart,
    onStopGenerating: handleStopGenerating,
    canStopGenerating,
    assistantId,
    conversationId: activeConversation?.conversationId,
    modelSupportsVision: activeModelSupportsVision,
    onRecallLastMessage: phase === "idle" ? () => {
      const content = startEditing();
      if (content !== null) {
        setInput(content);
      }
    } : undefined,
    onCancelEdit: isEditing ? () => {
      cancelEditing();
      setInput("");
    } : undefined,
    textareaMaxHeightPx: isEmptyConversation ? 320 : undefined,
    thresholdPickerSlot: assistantId ? (
      <ComposerSettingsMenu
        assistantId={assistantId}
        conversationId={activeConversation?.conversationId}
      />
    ) : undefined,
    contextWindowIndicatorSlot: (
      <ContextWindowIndicator
        usage={contextWindowUsage}
        assistantName={assistantName}
        onClearContext={
          activeConversation?.conversationId && !sendDisabled
            ? () => void sendMessage("/clean")
            : undefined
        }
      />
    ),
    noticesAboveFormSlot: (
      <ComposerNotices
        {...sharedComposerNoticeProps}
        attachmentLastError={attachmentLastError}
        onDismissAttachmentError={dismissChatAttachmentError}
        voiceError={voiceError}
        onClearVoiceError={clearVoiceError}
        onRetryMicPermission={handleRetryMicPermission}
        textStateNoticesSlot={textStateNoticesJsx}
      />
    ),
    suggestion,
    hasBillingBanner: billingBannerDecision !== null,
  };

  const chatBodyScrollAreaPropsBase = {
    isLoadingHistory,
    messageCount: messages.length,
    showEmptyState: isEmptyConversation,
    emptyStateProps: chatEmptyStateProps,
    transcriptRef,
    transcriptProps: chatTranscriptProps,
  };

  const mainBannerSlot = nudges.showBanner ? (
    <div className="pointer-events-auto w-full px-3 pb-2 sm:px-6">
      {nudges.isOnIOS ? (
        <IOSAppBanner
          onDownload={nudges.nudge.handleDownload}
          onDismiss={nudges.nudge.handleBannerDismiss}
        />
      ) : (
        <MacOSAppBanner
          onDownload={nudges.nudge.handleDownload}
          onDismiss={nudges.nudge.handleBannerDismiss}
        />
      )}
    </div>
  ) : nudges.showGitHubBanner ? (
    <div className="pointer-events-auto w-full px-3 pb-2 sm:px-6">
      <GitHubNudgeBanner
        onStar={nudges.githubNudge.handleStar}
        onDismiss={nudges.githubNudge.handleBannerDismiss}
      />
    </div>
  ) : nudges.showDiscordBanner ? (
    <div className="pointer-events-auto w-full px-3 pb-2 sm:px-6">
      <DiscordNudgeBanner
        onJoin={nudges.discordNudge.handleJoin}
        onDismiss={nudges.discordNudge.handleBannerDismiss}
      />
    </div>
  ) : null;

  const mainQueuedDrawerSlot = (
    <QueuedMessagesDrawer
      queuedMessages={queuedMessages}
      onCancelMessage={handleCancelQueuedMessage}
      onCancelAll={handleCancelAllQueued}
      onSteer={handleSteerMessage}
      showSteer={queueSteering}
      onEditTail={handleEditQueueTail}
    />
  );

  const questionPromptSlot = pendingQuestion ? (
    <div className="mb-2">
      <QuestionPromptCard
        key={pendingQuestion.requestId}
        requestId={pendingQuestion.requestId}
        entries={pendingQuestion.entries}
        isSubmitting={isSubmittingQuestion}
        onSubmitAll={handleQuestionResponse}
        onClose={handleDismissPendingQuestion}
      />
    </div>
  ) : null;

  const slackReadonlyBannerDisplay =
    activeConversation?.originChannel === "slack"
      ? getSlackConversationDisplay({
          conversation: activeConversation,
          messages: sanitizedMessages,
        })
      : null;
  const slackReadonlyBannerSlot = slackReadonlyBannerDisplay ? (
    <SlackChannelFooter
      assistantId={assistantId ?? undefined}
      conversation={activeConversation}
      messages={sanitizedMessages}
    />
  ) : null;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (mainView === "app-editing" && openedAppState && editingConversationId) {
    return (
      <ResizablePanel
        storageKey="appEditPanelWidth"
        defaultRightWidth={400}
        minLeftWidth={300}
        minRightWidth={400}
        left={
          <ChatBody
            variant="side-panel"
            scrollAreaProps={{
              ...chatBodyScrollAreaPropsBase,
              showMaintenanceRecoveryCard: false,
            }}
            composerProps={chatBodyComposerProps}
            dragHandlers={attachmentDropHandlers}
            isAttachmentDragOver={isAttachmentDragOver}
            showScrollToLatest={
              scrollCoordinator.showScrollToLatest && messages.length > 0
            }
            onScrollToLatest={handleScrollToLatest}
            isStreaming={isAssistantStreaming}
            refreshFeedback={refreshFeedback}
            onDismissRefreshFeedback={handleDismissRefreshFeedback}
            onRetryRefresh={handleRetryRefreshFromPill}
            genericChatError={genericChatError}
            isChannelReadonly={isChannelReadonly}
            canStopGenerating={canStopGenerating}
            questionPromptSlot={questionPromptSlot}
            readonlyBannerSlot={slackReadonlyBannerSlot}
            startersSlot={startersSlot}
          />
        }
        right={
          <AppViewerContainer
            appId={openedAppState.appId}
            appName={openedAppState.name}
            html={openedAppState.html}
            assistantId={assistantId ?? ""}
            onClose={handleCloseApp}
            onEdit={handleCloseEditPanel}
            onShare={handleShareApp}
            isSharing={isSharing}
            onDeploy={deployToVercel ? handleDeployApp : undefined}
            isDeploying={isDeploying}
            isEditing
          />
        }
      />
    );
  }

  // Desktop full-width app viewer (non-editing). Mobile uses the portal-based
  // MobileAppOverlay instead — this branch is desktop-only.
  if (mainView === "app" && !isMobile) {
    if (!openedAppState) {
      return (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-[var(--content-tertiary)]" />
        </div>
      );
    }
    return (
      <AppViewerContainer
        appId={openedAppState.appId}
        appName={openedAppState.name}
        html={openedAppState.html}
        assistantId={assistantId ?? ""}
        onClose={handleCloseApp}
        onEdit={handleEditApp}
        onShare={handleShareApp}
        isSharing={isSharing}
        onDeploy={deployToVercel ? handleDeployApp : undefined}
        isDeploying={isDeploying}
      />
    );
  }

  // Default: main chat content (with optional document panel)
  const chatContent = (
    <ChatBody
      variant="main"
      scrollAreaProps={{
        ...chatBodyScrollAreaPropsBase,
        showMaintenanceRecoveryCard: isInMaintenanceWithNoMessages,
      }}
      composerProps={chatBodyComposerProps}
      dragHandlers={attachmentDropHandlers}
      isAttachmentDragOver={isAttachmentDragOver}
      showScrollToLatest={
        scrollCoordinator.showScrollToLatest && messages.length > 0
      }
      onScrollToLatest={handleScrollToLatest}
      isStreaming={isAssistantStreaming}
      refreshFeedback={refreshFeedback}
      onDismissRefreshFeedback={handleDismissRefreshFeedback}
      onRetryRefresh={handleRetryRefreshFromPill}
      genericChatError={genericChatError}
      isChannelReadonly={isChannelReadonly}
      canStopGenerating={canStopGenerating}
      bannerSlot={mainBannerSlot}
      queuedDrawerSlot={mainQueuedDrawerSlot}
      questionPromptSlot={questionPromptSlot}
      readonlyBannerSlot={slackReadonlyBannerSlot}
      startersSlot={startersSlot}
    />
  );

  if (mainView === "document" && !isMobile && openedDocumentState && assistantId) {
    return (
      <>
        <ResizablePanel
          storageKey="documentPanelWidth"
          defaultRightWidth={400}
          minLeftWidth={300}
          minRightWidth={400}
          left={chatContent}
          right={
            <DocumentViewerContainer
              documentName={openedDocumentState.documentName}
              content={openedDocumentState.content}
              onClose={handleCloseDocument}
              assistantId={assistantId}
              surfaceId={openedDocumentState.surfaceId}
              conversationId={openedDocumentState.conversationId}
              onSubmitFeedback={() => {
                const prompt = `Please review and address my comments on "${openedDocumentState.documentName}".`;
                navigate(
                  `${routes.conversation(openedDocumentState.conversationId)}?prompt=${encodeURIComponent(prompt)}`,
                );
              }}
            />
          }
        />
        {sendErrorModalNode}
        {ruleEditorModalNode}
      </>
    );
  }

  if (mainView === "subagent-detail" && activeSubagentId && !isMobile) {
    const activeEntry = subagentById[activeSubagentId];
    if (activeEntry) {
      return (
        <>
          <ResizablePanel
            storageKey="subagentDetailPanelWidth"
            defaultRightWidth={400}
            minLeftWidth={300}
            minRightWidth={400}
            left={chatContent}
            right={
              <LazyBoundary>
                <SubagentDetailPanel
                  entry={activeEntry}
                  onClose={onCloseSubagentDetail}
                  onStop={onStopSubagent}
                  onRequestDetail={onRequestSubagentDetail}
                />
              </LazyBoundary>
            }
          />
          {sendErrorModalNode}
          {ruleEditorModalNode}
        </>
      );
    }
  }

  if (mainView === "tool-detail" && activeToolDetail && !isMobile) {
    return (
      <>
        <ResizablePanel
          storageKey="toolDetailPanelWidth"
          defaultRightWidth={400}
          minLeftWidth={300}
          minRightWidth={400}
          left={chatContent}
          right={
            <LazyBoundary>
              <ToolDetailPanel
                detail={activeToolDetail}
                onClose={closeToolDetail}
                onRiskBadgeClick={handleToolDetailRiskBadgeClick}
              />
            </LazyBoundary>
          }
        />
        {sendErrorModalNode}
        {ruleEditorModalNode}
      </>
    );
  }

  return (
    <>
      {chatContent}
      {sendErrorModalNode}
      {ruleEditorModalNode}
    </>
  );
}
