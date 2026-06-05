/**
 * Chat route content — renders `ChatBody` with all chat-specific UI slots
 * (banners, composer, interaction prompts, modals).
 *
 * Layout routing (side panels, resizable splits) lives in
 * `ChatContentLayout`, which renders this component inside the
 * appropriate panel arrangement based on `mainView`.
 *
 * Reads per-conversation state from Zustand stores directly and owns
 * UI-scoped hooks (avatar, disk pressure, nudges, voice input, interaction
 * actions, ghost text) so the parent (`ActiveChatView`) stays focused on
 * orchestration (SSE, reconciliation, send message, conversation loading).
 */

import { type Dispatch, type FormEvent, type MutableRefObject, type ReactNode, type RefObject, type SetStateAction, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useChatUIState } from "@/domains/chat/hooks/use-chat-ui-state";
import { useTranscriptData } from "@/domains/chat/hooks/use-transcript-data";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { DiscordNudgeBanner } from "@/components/nudges/discord-nudge-banner";
import { GitHubNudgeBanner } from "@/components/nudges/github-nudge-banner";
import { IOSAppBanner } from "@/components/nudges/ios-app-banner";
import { MacOSAppBanner } from "@/components/nudges/macos-app-banner";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useChatAttachmentDropZone } from "@/domains/chat/components/chat-attachments/use-chat-attachment-drop-zone";
import { useComposerStore, selectUploadingCount, selectUploadedIds } from "@/domains/chat/composer-store";
import { ChatBody } from "@/domains/chat/components/chat-body";
import type { ChatEmptyStateProps } from "@/domains/chat/components/chat-empty-state";
import { ChatRuleEditorModal } from "@/domains/chat/components/chat-rule-editor-modal";
import { ComposerNotices } from "@/domains/chat/components/composer-notices";
import { ComposerSettingsMenu } from "@/domains/chat/components/composer-settings-menu";

import { ContextWindowIndicator } from "@/domains/chat/components/context-window-indicator";
import { ConversationStarterGrid } from "@/domains/chat/components/conversation-starter-grid";
import { CreditsExhaustedBanner } from "@/domains/chat/components/credits-exhausted-banner";
import { OnboardingChoiceCard } from "@/domains/chat/components/onboarding-choice-card";
import { ProviderBillingBanner } from "@/domains/chat/components/provider-billing-banner";

import { QueuedMessagesDrawer } from "@/domains/chat/components/queued-messages-drawer";

import { SendErrorModal } from "@/domains/chat/components/send-error-modal";
import { SlackChannelFooter } from "@/domains/chat/components/slack-channel-footer";

import { useConversationStarters } from "@/domains/chat/hooks/use-conversation-starters";
import { useEditMessage } from "@/domains/chat/hooks/use-edit-message";
import { useOnboardingChoice } from "@/domains/chat/hooks/use-onboarding-choice";
import { usePullRefresh } from "@/domains/chat/hooks/use-pull-refresh";
import type { TranscriptHandle, TranscriptProps } from "@/domains/chat/transcript/transcript";
import { useTranscriptScroll } from "@/domains/chat/transcript/use-transcript-scroll";
import { toolCallToRuleContext } from "@/domains/chat/utils/chat";
import { conversationsByIdUndoPost } from "@/generated/daemon/sdk.gen";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { getLocalBool, removeLocalSetting, setLocalBool } from "@/utils/local-settings";
import { Button, Notice } from "@vellumai/design-library";

import { Link, useNavigate } from "react-router";

import { useEmptyStateGreeting } from "@/domains/chat/hooks/use-empty-state-greeting";
import { buildEditAppGreeting, buildEditAppStarters } from "@/domains/chat/utils/edit-app-empty-state";
import { pickRandomPlaceholder } from "@/domains/chat/utils/empty-state-constants";
import { getChatBillingBannerDecision, shouldShowGenericChatErrorNotice } from "@/domains/chat/utils/error-classification";

import { useInteractionStore } from "@/domains/chat/interaction-store";
import type { DisplayAttachment, DisplayMessage } from "@/domains/chat/utils/reconcile";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

import type { TranscriptItem } from "@/domains/chat/transcript/types";
import type { HistoryPaginationResult } from "@/domains/chat/transcript/use-history-pagination";
import type { UIContext } from "@/domains/chat/turn-selectors";
import { getSlackConversationDisplay } from "@/domains/chat/utils/slack-conversation-display";

import { getDiskPressureChatBlockReason } from "@/assistant/disk-pressure";
import { DiskPressureBanner, type DiskPressureBannerMode } from "@/components/disk-pressure-banner";

import { useActiveProfileModel } from "@/domains/chat/hooks/use-active-profile-model";

import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useTurnStore } from "@/domains/chat/turn-store";
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
  // --- Composer store (replaces 14 prop-drilled values) ---
  const input = useComposerStore.use.input();
  const setInput = useComposerStore.use.setInput();
  const saveDraft = useComposerStore.use.saveDraft();
  const clearDraft = useComposerStore.use.clearDraft();
  const restoredDraftConversationId = useComposerStore.use.restoredDraftConversationId();
  const clearRestoredDraftNotice = useComposerStore.use.clearRestoredDraftNotice();
  const chatAttachments = useComposerStore.use.attachments();
  const attachmentLastError = useComposerStore.use.attachmentLastError();
  const addFilesRaw = useComposerStore.use.addFiles();
  const removeChatAttachment = useComposerStore.use.removeAttachment();
  const resetChatAttachments = useComposerStore.use.resetAttachments();
  const dismissChatAttachmentError = useComposerStore.use.dismissAttachmentError();
  const attachmentsUploadingCount = useMemo(() => selectUploadingCount(chatAttachments), [chatAttachments]);
  const attachmentUploadedIds = useMemo(() => selectUploadedIds(chatAttachments), [chatAttachments]);
  const navigate = useNavigate();
  // -------------------------------------------------------------------------
  // Store reads — identity, lifecycle, feature flags
  // -------------------------------------------------------------------------
  const assistantId = useAssistantSelectionStore.use.activeAssistantId();
  const addChatAttachmentFiles = useCallback(
    (files: FileList | File[]) => addFilesRaw(files, assistantId),
    [addFilesRaw, assistantId],
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
  const mainView = useViewerStore.use.mainView();
  const openedAppState = useViewerStore.use.openedAppState();

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
  // App / document / subagent action callbacks
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
  // Turn state — only `phase` is read directly (recall-last-message guard).
  // All other turn derivations (thinking indicator, send-disabled,
  // stop-generation) live in `useChatUIState`.
  // -------------------------------------------------------------------------
  const phase = useTurnStore.use.phase();

  // -------------------------------------------------------------------------
  // Tool-call rule editor (signalled via viewer store seq counter)
  // -------------------------------------------------------------------------

  /** Open the rule editor for the tool call shown in the detail panel. */
  const handleToolDetailRiskBadgeClick = useCallback(() => {
    const detail = useViewerStore.getState().activeToolDetail;
    if (!detail) return;
    const tc = messages
      .flatMap((m) => m.toolCalls ?? [])
      .find((t) => t.id === detail.toolCallId);
    if (!tc) return;
    handleOpenRuleEditorForToolCall(toolCallToRuleContext(tc));
  }, [messages, handleOpenRuleEditorForToolCall]);

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
  // Derived UI state + transcript data (extracted from inline derivations)
  // -------------------------------------------------------------------------

  const {
    uiContext,
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
  // Nudges + ghost text (depend on liveAssistantMessageId from useChatUIState)
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
        onDismiss={useRuleEditorStore.getState().dismissRuleEditor}
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

  const loadOlder = historyPagination.fetchOlderPage;

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
      clearRestoredDraftNotice();
    }, 5000);
    return () => window.clearTimeout(id);
  }, [showRestoredDraftNotice, clearRestoredDraftNotice]);

  useEffect(() => {
    if (
      restoredDraftConversationId !== null &&
      restoredDraftConversationId !== activeConversationId
    ) {
      clearRestoredDraftNotice();
    }
  }, [activeConversationId, restoredDraftConversationId, clearRestoredDraftNotice]);

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

  const handleSelectStarter = useCallback((starter: { prompt: string }) => {
    setInput(starter.prompt);
    void handleSubmit(
      { preventDefault: () => {} } as unknown as FormEvent,
      starter.prompt,
    );
  }, [setInput, handleSubmit]);

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
            onDismiss={() => clearRestoredDraftNotice()}
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
    // Store-owned so card/thinking expansion survives the transcript remount
    // when the tool-detail drawer opens/closes (otherwise clicking a pill
    // would collapse the activity card).
    expandedCardIds: useChatSessionStore.getState().expandedCardIds,
    expandedThinkingKeys: useChatSessionStore.getState().expandedThinkingKeys,
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
    onRetryError: () => setError(null),
    onForkConversation: (messageId) => {
      void handleForkConversation(messageId);
    },
    onInspectMessage: handleInspectMessage,
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

  // Determine variant: app-editing mode renders as a compact side panel.
  // Must match ChatContentLayout's three-way guard (mainView + openedAppState
  // + editingConversationId) so the variant stays consistent with the layout.
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
      {sendErrorModalNode}
      {ruleEditorModalNode}
    </>
  );
}
