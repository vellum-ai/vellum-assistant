/**
 * Chat main panel — thin orchestrator that calls focused hooks and
 * renders {@link ChatBody} with all chat-specific UI slots (banners,
 * composer, interaction prompts, modals).
 *
 * Layout routing (side panels, resizable splits) lives in
 * `ChatContentLayout`, which renders this component inside the
 * appropriate panel arrangement based on `mainView`.
 *
 * Hook delegation:
 * - `useChatUIState` — turn/interaction/conversation-derived UI flags
 * - `useTranscriptData` — message sanitisation → transcript items
 * - `useChatEmptyState` — greeting, starters, avatar
 * - `useComposerSubmit` — submit logic, focus management
 * - `DiskPressureBannerSlot` — localStorage-backed dismiss/suppress
 * - `useRuleEditorBridge` — viewer-store → rule-editor bridge
 * - `useChatBannerSlots` — nudge/queued/slack banner assembly
 */

import { type Dispatch, type MutableRefObject, type ReactNode, type RefObject, type SetStateAction, useCallback, useEffect, useLayoutEffect, useMemo } from "react";

import { useChatUIState } from "@/domains/chat/hooks/use-chat-ui-state";
import { useTranscriptData } from "@/domains/chat/hooks/use-transcript-data";
import { useChatEmptyState } from "@/domains/chat/hooks/use-chat-empty-state";
import { useComposerSubmit } from "@/domains/chat/hooks/use-composer-submit";
import { DiskPressureBannerSlot } from "@/domains/chat/components/disk-pressure-banner-slot";
import { useRuleEditorBridge } from "@/domains/chat/hooks/use-rule-editor-bridge";
import { useChatBannerSlots } from "@/domains/chat/hooks/use-chat-banner-slots";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useChatAttachmentDropZone } from "@/domains/chat/components/chat-attachments/use-chat-attachment-drop-zone";
import { useComposerStore, selectUploadingCount, selectUploadedIds } from "@/domains/chat/composer-store";
import { ChatBody } from "@/domains/chat/components/chat-body";
import { ChatRuleEditorModal } from "@/domains/chat/components/chat-rule-editor-modal";
import { ComposerNotices } from "@/domains/chat/components/composer-notices";
import { ComposerSettingsMenu } from "@/domains/chat/components/composer-settings-menu";
import { ContextWindowIndicator } from "@/domains/chat/components/context-window-indicator";
import { CreditsExhaustedBanner } from "@/domains/chat/components/credits-exhausted-banner";
import { MicPermissionPrimer } from "@/domains/chat/components/mic-permission-primer";
import { OnboardingChoiceCard } from "@/domains/chat/components/onboarding-choice-card";
import { ProviderBillingBanner } from "@/domains/chat/components/provider-billing-banner";
import { SendErrorModal } from "@/domains/chat/components/send-error-modal";
import { useEditMessage } from "@/domains/chat/hooks/use-edit-message";
import { useOnboardingChoice } from "@/domains/chat/hooks/use-onboarding-choice";
import { usePullRefresh } from "@/domains/chat/hooks/use-pull-refresh";
import type { TranscriptHandle, TranscriptProps } from "@/domains/chat/transcript/transcript";
import { useTranscriptScroll } from "@/domains/chat/transcript/use-transcript-scroll";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { Button, Notice } from "@vellumai/design-library";
import { Link, useNavigate } from "react-router";
import { getChatBillingBannerDecision, shouldShowGenericChatErrorNotice } from "@/domains/chat/utils/error-classification";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import type { DisplayAttachment, DisplayMessage } from "@/domains/chat/utils/reconcile";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import type { TranscriptItem } from "@/domains/chat/transcript/types";
import type { HistoryPaginationResult } from "@/domains/chat/transcript/use-history-pagination";
import type { UIContext } from "@/domains/chat/turn-selectors";
import { getDiskPressureChatBlockReason } from "@/assistant/disk-pressure";
import { useActiveProfileModel } from "@/domains/chat/hooks/use-active-profile-model";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel";
import { useViewerStore } from "@/stores/viewer-store";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";
import { lifecycleService } from "@/assistant/lifecycle-service";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { UseDiskPressureMonitorResult } from "@/assistant/use-disk-pressure-monitor";
import { useActiveConversation } from "@/domains/chat/hooks/use-active-conversation";
import { useAppNudges } from "@/domains/chat/hooks/use-app-nudges";
import { useGhostTextSuggestion } from "@/domains/chat/hooks/use-ghost-text-suggestion";
import { useInteractionActions } from "@/domains/chat/hooks/use-interaction-actions";
import { useRuleEditorStore } from "@/domains/chat/rule-editor-store";
import { useOpenAppFromChat } from "@/domains/chat/hooks/use-open-app-from-chat";
import { useVoiceInput } from "@/domains/chat/hooks/use-voice-input";
import { useConversationListQuery } from "@/hooks/conversation-queries";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useConversationStore } from "@/stores/conversation-store";

// ---------------------------------------------------------------------------
// Props — only values that cannot be owned locally
// ---------------------------------------------------------------------------

export interface ChatMainPanelProps {
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

/** @deprecated Use {@link ChatMainPanelProps} — kept as a re-export for migration. */
export type ChatRouteContentProps = ChatMainPanelProps;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChatMainPanel({
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
}: ChatMainPanelProps) {
  const navigate = useNavigate();

  // -------------------------------------------------------------------------
  // Store reads — composer
  // -------------------------------------------------------------------------
  const input = useComposerStore.use.input();
  const setInput = useComposerStore.use.setInput();
  const restoredDraftConversationId = useComposerStore.use.restoredDraftConversationId();
  const chatAttachments = useComposerStore.use.attachments();
  const attachmentLastError = useComposerStore.use.attachmentLastError();
  const removeChatAttachment = useComposerStore.use.removeAttachment();
  const dismissChatAttachmentError = useComposerStore.use.dismissAttachmentError();
  const attachmentsUploadingCount = useMemo(() => selectUploadingCount(chatAttachments), [chatAttachments]);
  const attachmentUploadedIds = useMemo(() => selectUploadedIds(chatAttachments), [chatAttachments]);

  // -------------------------------------------------------------------------
  // Store reads — identity, lifecycle, feature flags
  // -------------------------------------------------------------------------
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const addChatAttachmentFiles = useCallback(
    (files: FileList | File[]) => useComposerStore.getState().addFiles(files, assistantId),
    [assistantId],
  );
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  const assistantName = useAssistantIdentityStore.use.name();
  const chatPullToRefreshEnabled = useClientFeatureFlagStore.use.chatPullToRefreshEnabled();
  const doctorEnabled = useClientFeatureFlagStore.use.doctor();

  // -------------------------------------------------------------------------
  // Store reads — per-conversation state
  // -------------------------------------------------------------------------
  const messages = useChatSessionStore.use.messages();
  const error = useChatSessionStore.use.error();
  const isLoadingHistory = useChatSessionStore.use.isLoadingHistory();
  const contextWindowUsage = useChatSessionStore.use.contextWindowUsage();
  const compactionCircuitOpenUntil = useChatSessionStore.use.compactionCircuitOpenUntil();
  const transcriptPagination = useChatSessionStore.use.transcriptPagination();

  // -------------------------------------------------------------------------
  // Store reads — conversation, viewer
  // -------------------------------------------------------------------------
  const activeConversationId = useConversationStore.use.activeConversationId();
  const mainView = useViewerStore.use.mainView();
  const openedAppState = useViewerStore.use.openedAppState();

  // Active conversation (TanStack Query — deduped with ActiveChatView's call)
  const activeConversation = useActiveConversation(assistantId, activeConversationId, true);
  const isChannelReadonly = isChannelConversation(activeConversation);

  // Conversation count (for nudges — TanStack Query deduped)
  const { conversations } = useConversationListQuery(assistantId, true);

  // -------------------------------------------------------------------------
  // UI-scoped hooks
  // -------------------------------------------------------------------------
  const avatar = useAssistantAvatar(assistantId);

  const {
    voiceInputRef,
    voiceInterim,
    voiceError,
    clearVoiceError,
    setVoiceError,
    showPrimer,
    handleVoiceBeforeStart,
    handleVoiceTranscript,
    setVoiceInterim,
    handlePrimerContinue,
    handlePrimerCancel,
    handleRetryMicPermission,
  } = useVoiceInput({ assistantId, inputRef, setInput });

  const {
    handleConfirmationSubmit,
    handleAllowAndCreateRule,
    handleOpenRuleEditorForToolCall,
    handleSaveRule,
    handleSaveAsNewRule,
    handleSurfaceAction,
  } = useInteractionActions();

  const showRuleEditor = useRuleEditorStore.use.showRuleEditor();
  const ruleEditorContext = useRuleEditorStore.use.ruleEditorContext();
  const isSavingRule = useRuleEditorStore.use.isSavingRule();
  const unknownNudgeToolCallIds = useInteractionStore.use.unknownNudgeToolCallIds();

  const handleOpenApp = useOpenAppFromChat();

  // -------------------------------------------------------------------------
  // Action callbacks
  // -------------------------------------------------------------------------
  const handleOpenDocument = useCallback((surfaceId: string) => {
    haptic.light();
    if (assistantId) void useViewerStore.getState().loadDocument(assistantId, surfaceId);
  }, [assistantId]);

  const onSubagentClick = useCallback((id: string) => {
    useViewerStore.getState().openSubagentDetail(id);
  }, []);

  const onStopSubagent = useCallback(
    (subagentId: string) => void useSubagentStore.getState().abortSubagent(subagentId),
    [],
  );

  const pushToAiSettings = useCallback(() => {
    void navigate(routes.settings.ai);
  }, [navigate]);

  const checkAssistant = useCallback(() => lifecycleService.checkAssistant(), []);

  // -------------------------------------------------------------------------
  // Feature flags
  // -------------------------------------------------------------------------
  const queueSteering = useAssistantFeatureFlagStore.use.queueSteering();

  // -------------------------------------------------------------------------
  // Derived UI state + transcript data (extracted hooks)
  // -------------------------------------------------------------------------
  const {
    uiContext,
    isIdle,
    showThinking,
    isAssistantStreaming,
    canStopGenerating,
    isSendDisabledFromTurn,
    thinkingLabel,
    liveAssistantMessageId,
    activeConversationIsProcessing,
  } = useChatUIState();

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
  // Nudges + ghost text
  // -------------------------------------------------------------------------
  const nudges = useAppNudges(messages, conversations.length, liveAssistantMessageId);

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

  // -------------------------------------------------------------------------
  // Transcript data (sanitise + build items)
  // -------------------------------------------------------------------------
  const { sanitizedMessages, transcriptItems } = useTranscriptData({
    showThinking,
    thinkingLabel,
    showOnboardingChoice,
  });

  // --- Ref writes (connect hook outputs to ActiveChatView's debug refs) ---
  useEffect(() => {
    uiContextRef.current = uiContext;
    return () => {
      uiContextRef.current = null;
    };
  }, [uiContextRef, uiContext]);

  useLayoutEffect(() => { sanitizedMessagesRef.current = sanitizedMessages; });
  useLayoutEffect(() => { transcriptItemsRef.current = transcriptItems; });

  // -------------------------------------------------------------------------
  // Remaining derived values
  // -------------------------------------------------------------------------
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

  const sendDisabled = isSendDisabledFromTurn || typingDisabled;

  const isEmptyConversation =
    !!activeConversationId &&
    !isLoadingHistory &&
    messages.length === 0 &&
    !(assistantState.kind === "active" && assistantState.maintenanceMode?.enabled);

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

  const sendErrorModalNode =
    error?.displayAs === "modal" ? (
      <SendErrorModal
        open
        message={error.message}
        onClose={() => {
          if (typeof error.restoreContent === "string") {
            setInput(error.restoreContent);
          }
          useChatSessionStore.getState().setError(null);
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
        onDismiss={useRuleEditorStore.getState().dismissRuleEditor}
      />
    ) : null;

  const canSendAttachments =
    attachmentsUploadingCount === 0 && attachmentUploadedIds.length > 0;

  const activeProfileModel = useActiveProfileModel(
    assistantId,
    activeConversation?.conversationId,
  );
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
      useComposerStore.getState().saveDraft(activeConversationId, currentInput);
    }
    setRefreshEpoch((prev) => prev + 1);
  }, [activeConversationId, inputRef, setRefreshEpoch]);

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
  // Scroll coordination
  // -------------------------------------------------------------------------
  const scrollCoordinator = useTranscriptScroll({
    transcriptRef,
    items: transcriptItems,
    conversationId: activeConversationId,
    hasMore: transcriptPagination.hasMore,
    isLoadingOlder: transcriptPagination.isLoadingOlder,
    onLoadOlder: historyPagination.fetchOlderPage,
  });

  const handleScrollToLatest = useCallback(() => {
    scrollCoordinator.scrollToLatest({ behavior: "smooth" });
  }, [scrollCoordinator]);

  // -------------------------------------------------------------------------
  // Draft notice auto-dismiss
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!showRestoredDraftNotice) return;
    const id = window.setTimeout(() => {
      useComposerStore.getState().clearRestoredDraftNotice();
    }, 5000);
    return () => window.clearTimeout(id);
  }, [showRestoredDraftNotice]);

  useEffect(() => {
    if (
      restoredDraftConversationId !== null &&
      restoredDraftConversationId !== activeConversationId
    ) {
      useComposerStore.getState().clearRestoredDraftNotice();
    }
  }, [activeConversationId, restoredDraftConversationId]);

  // -------------------------------------------------------------------------
  // Composer submit (extracted hook — fixes fake FormEvent pattern)
  // -------------------------------------------------------------------------
  const { submitMessage, handleFormSubmit } = useComposerSubmit({
    sendMessage,
    inputRef,
    scrollToLatest: scrollCoordinator.scrollToLatest,
    isEditing,
    editingMessageId,
    cancelEditing,
    sendDisabled,
    typingDisabled,
    assistantId,
    activeConversationId,
  });

  const handleSelectStarter = useCallback((starter: { prompt: string }) => {
    setInput(starter.prompt);
    void submitMessage(starter.prompt);
  }, [setInput, submitMessage]);

  // -------------------------------------------------------------------------
  // Rule editor bridge (viewer-store seq → rule editor open)
  // -------------------------------------------------------------------------
  useRuleEditorBridge(messages, handleOpenRuleEditorForToolCall);

  // -------------------------------------------------------------------------
  // Disk pressure banner (localStorage-backed dismiss/suppress)
  // -------------------------------------------------------------------------
  const diskPressureBannerSlot = (
    <DiskPressureBannerSlot
      diskPressure={diskPressure}
      assistantId={assistantId}
      assistantStateKind={assistantState.kind}
    />
  );

  // -------------------------------------------------------------------------
  // Empty state (greeting, starters, avatar)
  // -------------------------------------------------------------------------
  const {
    emptyStateProps: chatEmptyStateProps,
    startersSlot,
    renderAvatar,
    emptyStatePlaceholder,
  } = useChatEmptyState({
    assistantId,
    isEmptyConversation,
    avatar,
    mainView,
    openedAppState,
    isAssistantStreaming,
    activeConversationIsProcessing,
    onSelectStarter: handleSelectStarter,
  });

  // -------------------------------------------------------------------------
  // Banner slots (nudge, queued, slack)
  // -------------------------------------------------------------------------
  const { mainBannerSlot, mainQueuedDrawerSlot, slackReadonlyBannerSlot } = useChatBannerSlots({
    nudges,
    queuedMessages,
    onCancelQueuedMessage: handleCancelQueuedMessage,
    onCancelAllQueued: handleCancelAllQueued,
    onSteerMessage: handleSteerMessage,
    onEditQueueTail: handleEditQueueTail,
    queueSteering,
    activeConversation,
    sanitizedMessages,
    assistantId,
  });

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
  // JSX construction
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
            onDismiss={() => useComposerStore.getState().clearRestoredDraftNotice()}
          >
            Draft restored from your previous session.
          </Notice>
        </div>
      )}
    </>
  );

  const chatTranscriptProps: TranscriptProps = {
    items: transcriptItems,
    conversationId: activeConversationId,
    assistantDisplayName: assistantName?.trim() || undefined,
    onOpenRuleEditor: handleOpenRuleEditorForToolCall,
    onOpenApp: handleOpenApp,
    onOpenDocument: handleOpenDocument,
    assistantId,
    unknownNudgeToolCallIds,
    onDismissUnknownNudge: (toolCallId) =>
      useInteractionStore.getState().removeUnknownNudgeToolCallId(toolCallId),
    onSurfaceAction: (surfaceId, action, input) => {
      void handleSurfaceAction(
        surfaceId,
        action,
        input as Record<string, unknown> | undefined,
      );
    },
    onConfirmationSubmit: handleConfirmationSubmit,
    onAllowAndCreateRule: handleAllowAndCreateRule,
    onForkConversation: (messageId) => {
      void handleForkConversation(messageId);
    },
    onInspectMessage: handleInspectMessage,
    renderAvatar,
    onPullRefresh: handlePullRefresh,
    pullRefreshEnabled: chatPullToRefreshEnabled && touchSupported,
    scrollCoordinatorState: {
      showScrollToLatest: scrollCoordinator.showScrollToLatest,
      shouldLoadOlder: false,
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
    diskPressureBanner: diskPressureBannerSlot,
    showMissingApiKeyBanner:
      error?.code === "PROVIDER_NOT_CONFIGURED" ||
      error?.code === "MANAGED_KEY_INVALID",
    onOpenAiSettings: pushToAiSettings,
    onDismissApiKeyError: () => useChatSessionStore.getState().setError(null),
    compactionCircuitOpenUntil,
    onCompactionCircuitExpired: () => useChatSessionStore.getState().setCompactionCircuitOpenUntil(null),
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
    onSubmit: handleFormSubmit,
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
    onRecallLastMessage: isIdle ? () => {
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

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  const editingConversationId = useConversationStore.use.editingConversationId();
  const isSidePanel = mainView === "app-editing" && !!openedAppState && !!editingConversationId;
  const variant = isSidePanel ? "side-panel" : "main";

  return (
    <>
      <ChatBody
        variant={variant}
        scrollAreaProps={{
          ...chatBodyScrollAreaPropsBase,
          showMaintenanceRecoveryCard: isSidePanel ? false : isInMaintenanceWithNoMessages,
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
        bannerSlot={isSidePanel ? undefined : mainBannerSlot}
        queuedDrawerSlot={isSidePanel ? undefined : mainQueuedDrawerSlot}
        readonlyBannerSlot={slackReadonlyBannerSlot}
        startersSlot={startersSlot}
      />
      <MicPermissionPrimer
        open={showPrimer}
        onContinue={handlePrimerContinue}
        onCancel={handlePrimerCancel}
      />
      {sendErrorModalNode}
      {ruleEditorModalNode}
    </>
  );
}

/** @deprecated Use {@link ChatMainPanel} — kept for migration. */
export const ChatRouteContent = ChatMainPanel;
