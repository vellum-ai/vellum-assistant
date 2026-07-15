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
 * - `useChatBannerSlots` — nudge/queued banner assembly
 */

import { type Dispatch, type MutableRefObject, type ReactNode, type RefObject, type SetStateAction, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAcpRunRehydration } from "@/domains/chat/hooks/use-acp-run-rehydration";
import { useBackgroundTaskRehydration } from "@/domains/chat/hooks/use-background-task-rehydration";
import { useChatUIState } from "@/domains/chat/hooks/use-chat-ui-state";
import { useTranscriptData } from "@/domains/chat/hooks/use-transcript-data";
import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";
import { useChatEmptyState } from "@/domains/chat/hooks/use-chat-empty-state";
import { useComposerSubmit } from "@/domains/chat/hooks/use-composer-submit";
import { DiskPressureBannerSlot } from "@/domains/chat/components/disk-pressure-banner-slot";
import { useRuleEditorBridge } from "@/domains/chat/hooks/use-rule-editor-bridge";
import { useChatBannerSlots } from "@/domains/chat/hooks/use-chat-banner-slots";
import { QuoteReplyBubble } from "@/domains/chat/components/quote-reply-bubble";
import { TextSelectionPopover } from "@/domains/chat/components/text-selection-popover";
import { useNativeQuoteReply } from "@/domains/chat/hooks/use-native-quote-reply";
import { useQuoteReplyStore } from "@/domains/chat/quote-reply-store";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel";
import { isPopoutWindow } from "@/runtime/popout-window";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useChatAttachmentDropZone } from "@/domains/chat/components/chat-attachments/use-chat-attachment-drop-zone";
import { useVisionAttachmentGate } from "@/lib/backwards-compat/vision-attachment-gate";
import { useSupportsNewChatPlugins } from "@/lib/backwards-compat/use-supports-new-chat-plugins";
import { NewChatPluginsSection } from "@/domains/chat/components/new-chat-plugins/new-chat-plugins-section";
import { useComposerStore } from "@/domains/chat/composer-store";
import { ActiveProcessOverlay } from "@/domains/chat/process-registry/active-process-overlay";
import { PROCESS_KINDS } from "@/domains/chat/process-registry/registry";
import type { ProcessKind } from "@/domains/chat/process-registry/types";
import { SUBAGENT_DESCRIPTOR } from "@/domains/chat/process-registry/descriptors/subagent";
import { ACP_RUN_DESCRIPTOR } from "@/domains/chat/process-registry/descriptors/acp-run";
import { WORKFLOW_DESCRIPTOR } from "@/domains/chat/process-registry/descriptors/workflow";
import { BACKGROUND_TASK_DESCRIPTOR } from "@/domains/chat/process-registry/descriptors/background-task";
import { AnimatedRightDrawer } from "@/domains/chat/components/animated-right-drawer";
import { ChatBody } from "@/domains/chat/components/chat-body";
import { ChatComposer } from "@/domains/chat/components/chat-composer/chat-composer";
import { ChatRuleEditorModal } from "@/domains/chat/components/chat-rule-editor-modal";
import { ComposerNotices } from "@/domains/chat/components/composer-notices";
import { ComposerSettingsMenu } from "@/domains/chat/components/composer-settings-menu";
import { ContextWindowIndicator } from "@/domains/chat/components/context-window-indicator";
import { CreditsExhaustedBanner } from "@/domains/chat/components/credits-exhausted-banner";
import { MicPermissionPrimer } from "@/domains/chat/components/mic-permission-primer";
import { OnboardingChoiceCard } from "@/domains/chat/components/onboarding-choice-card";
import { ProviderBillingBanner } from "@/domains/chat/components/provider-billing-banner";
import { SendErrorModal } from "@/domains/chat/components/send-error-modal";
import { SuggestionDetailPanel } from "@/domains/chat/components/suggestion-detail-panel";
import type { ThreadSuggestion } from "@/domains/chat/suggestions/types";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet } from "@vellumai/design-library";
import { useEditMessage } from "@/domains/chat/hooks/use-edit-message";
import { useOnboardingChoice } from "@/domains/chat/hooks/use-onboarding-choice";
import { usePullRefresh } from "@/domains/chat/hooks/use-pull-refresh";
import type { TranscriptHandle, TranscriptProps } from "@/domains/chat/transcript/transcript";
import { useTranscriptScroll } from "@/domains/chat/transcript/use-transcript-scroll";
import { useIsNativePlatform } from "@/runtime/native-auth";
import {
  resolveDroppedDirectories,
  WEB_FOLDER_DROP_ERROR,
} from "@/domains/chat/components/chat-attachments/handle-folder-drop";
import { Button } from "@vellumai/design-library";
import { Link, useLocation, useNavigate } from "react-router";
import {
  getChatBillingBannerDecision,
  isManagedCredentialChatError,
  shouldShowGenericChatErrorNotice,
} from "@/domains/chat/utils/error-classification";
import { openUrlInPopupOrTab } from "@/domains/chat/utils/oauth-popup-links";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import type { DisplayAttachment, DisplayMessage } from "@/domains/chat/types/types";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import type { TranscriptItem } from "@/domains/chat/transcript/types";
import type { HistoryPaginationResult } from "@/domains/chat/transcript/use-history-pagination";
import type { UIContext } from "@/domains/chat/turn-selectors";
import { getDiskPressureChatBlockReason } from "@/assistant/disk-pressure";
import { useActiveProfileModel } from "@/domains/chat/hooks/use-active-profile-model";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import { useViewerStore } from "@/stores/viewer-store";
import { cmdEnterToSend } from "@/utils/composer-settings";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";
import { lifecycleService } from "@/assistant/lifecycle-service";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";

import type { UseDiskPressureMonitorResult } from "@/assistant/use-disk-pressure-monitor";
import { useAppNudges } from "@/domains/chat/hooks/use-app-nudges";
import { useGhostTextSuggestion } from "@/domains/chat/hooks/use-ghost-text-suggestion";
import { handleConfirmationSubmit, handleAllowAndCreateRule } from "@/domains/chat/confirmation-actions";
import { handleOpenRuleEditorForToolCall, handleSaveRule, handleSaveAsNewRule } from "@/domains/chat/rule-editor-actions";
import { handleSurfaceAction } from "@/domains/chat/surface-actions";
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
  /** Opens the "Summarize up to here" confirm dialog for a message. */
  onSummarizeUpToHere?: (messageId: string) => void;
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

/**
 * Builds the registry-driven row of active background-process overlays.
 *
 * Each descriptor's `useActiveIds()` is a zero-arg hook that resolves the
 * active conversation internally, so the hooks are called here at the
 * orchestrator level (where the conversation lives in context). They must be
 * called explicitly per-kind — the Rules of Hooks forbid iterating
 * `PROCESS_KINDS` with hooks — and the results are keyed by `descriptor.kind`,
 * so the overlay row order follows `PROCESS_KINDS` without positional coupling.
 *
 * `hasAny` lets the caller omit the row entirely when nothing is active, so the
 * absolutely-positioned container never mounts empty; the overlays themselves
 * also self-gate on their own ids.
 */
function useActiveProcessSlots() {
  const subagentIds = SUBAGENT_DESCRIPTOR.useActiveIds();
  const acpRunIds = ACP_RUN_DESCRIPTOR.useActiveIds();
  const workflowIds = WORKFLOW_DESCRIPTOR.useActiveIds();
  const backgroundTaskIds = BACKGROUND_TASK_DESCRIPTOR.useActiveIds();
  // Keyed by `descriptor.kind` (not array position) so reordering
  // `PROCESS_KINDS` can't silently feed an overlay the wrong kind's ids.
  const idsByKind: Record<ProcessKind, string[]> = {
    subagent: subagentIds,
    "acp-run": acpRunIds,
    workflow: workflowIds,
    "background-task": backgroundTaskIds,
  };
  const hasAny = Object.values(idsByKind).some((ids) => ids.length > 0);
  const overlays = PROCESS_KINDS.map((descriptor) => (
    <ActiveProcessOverlay
      key={descriptor.kind}
      descriptor={descriptor}
      ids={idsByKind[descriptor.kind]}
    />
  ));
  return { overlays, hasAny };
}

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
  onSummarizeUpToHere,
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
  const location = useLocation();
  const navigate = useNavigate();
  const statusBannerVisible = !isPopoutWindow(location.search);

  // -------------------------------------------------------------------------
  // Derived UI state (provides assistantId, activeConversationId,
  // activeConversation alongside turn/interaction flags — single subscription
  // point for these fundamental identity values)
  // -------------------------------------------------------------------------
  const {
    uiContext,
    isIdle,
    showThinking,
    isAssistantBusy,
    isSendDisabledFromTurn,
    thinkingLabel,
    liveAssistantMessageId,
    activeConversationIsProcessing,
    assistantId,
    activeConversationId,
    activeConversation,
  } = useChatUIState();

  // Edit/recall + undo require a PROVEN-native conversation: while the row is
  // unresolved (activeConversation undefined) or channel-origin, the undo path
  // would delete imported channel history, so treat those as not-native.
  const isNativeConversation =
    activeConversation != null && !isChannelConversation(activeConversation);

  // Gated to daemons that accept the per-chat plugin set (web is always-latest).
  const supportsNewChatPlugins = useSupportsNewChatPlugins();

  // -------------------------------------------------------------------------
  // Composer — `ChatComposer` and `ComposerDraftNotices` self-source every
  // composer-store slice they render (draft text, attachments, draft notices),
  // so this orchestrator subscribes to NONE of it: typing or attaching never
  // re-renders the transcript. The only composer-store touch left here is the
  // vision-gated *write* below (queueing dropped/attached files), which depends
  // on the active model and so can't move into the composer.
  // -------------------------------------------------------------------------
  const addChatAttachmentFiles = useCallback(
    (files: FileList | File[]) => useComposerStore.getState().addFiles(files, assistantId),
    [assistantId],
  );
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  const assistantName = useAssistantIdentityStore.use.name();
  const chatPullToRefreshEnabled = useClientFeatureFlagStore.use.chatPullToRefreshEnabled();

  // -------------------------------------------------------------------------
  // Store reads — per-conversation state
  // -------------------------------------------------------------------------
  const messages = useTranscriptMessages();
  const error = useChatSessionStore.use.error();
  const notice = useChatSessionStore.use.notice();
  const isLoadingHistory = useChatSessionStore.use.isLoadingHistory();
  const contextWindowUsage = useChatSessionStore.use.contextWindowUsage();
  const compactionCircuitOpenUntil = useChatSessionStore.use.compactionCircuitOpenUntil();
  const transcriptPagination = useChatSessionStore.use.transcriptPagination();

  // -------------------------------------------------------------------------
  // Store reads — viewer
  // -------------------------------------------------------------------------
  const mainView = useViewerStore.use.mainView();
  const openedAppState = useViewerStore.use.openedAppState();
  const isAppMinimized = useViewerStore.use.isAppMinimized();

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
    handleOpenTextInsertionSettings,
    showPrimer,
    handleVoiceBeforeStart,
    handleVoiceTranscript,
    setVoiceInterim,
    handlePrimerContinue,
    handlePrimerCancel,
    handleRetryMicPermission,
    handleOpenMicSettings,
  } = useVoiceInput({ assistantId, inputRef });



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

  const { overlays: activeProcessOverlays, hasAny: hasActiveProcess } =
    useActiveProcessSlots();

  // Rehydrate ACP runs from the daemon on conversation load so completed and
  // in-progress runs reappear after a refresh / reconnect.
  useAcpRunRehydration(assistantId, activeConversationId);

  // Rehydrate still-running background tasks from the daemon so they reappear
  // as active entries after a refresh.
  useBackgroundTaskRehydration(activeConversationId);

  const onSubagentClick = useCallback((id: string) => {
    useViewerStore.getState().openSubagentDetail(id);
  }, []);

  const onStopSubagent = useCallback(
    (subagentId: string) => void useSubagentStore.getState().abortSubagent(subagentId),
    [],
  );

  const onWorkflowClick = useCallback((runId: string) => {
    useViewerStore.getState().openWorkflowDetail(runId);
  }, []);

  const onStopWorkflow = useCallback(
    (runId: string) => void useWorkflowStore.getState().abortRun(runId),
    [],
  );

  const pushToAiSettings = useCallback(() => {
    void navigate(routes.settings.ai);
  }, [navigate]);

  const checkAssistant = useCallback(() => lifecycleService.checkAssistant(), []);

  const handleDismissUnknownNudge = useCallback(
    (toolCallId: string) => useInteractionStore.getState().removeUnknownNudgeToolCallId(toolCallId),
    [],
  );

  const handleSurfaceActionCallback = useCallback(
    (surfaceId: string, action: string, input: unknown) => {
      return handleSurfaceAction(surfaceId, action, input as Record<string, unknown> | undefined);
    },
    [],
  );

  const handleForkConversationCallback = useCallback(
    (messageId: string) => { void handleForkConversation(messageId); },
    [handleForkConversation],
  );

  const handleDismissApiKeyError = useCallback(
    () => useChatSessionStore.getState().setError(null),
    [],
  );

  const handleCompactionCircuitExpired = useCallback(
    () => useChatSessionStore.getState().setCompactionCircuitOpenUntil(null),
    [],
  );

  const handleMaintenanceExited = useCallback(
    () => void checkAssistant(),
    [checkAssistant],
  );

  // -------------------------------------------------------------------------
  // Quote & Reply — transcript container ref for text selection detection
  // -------------------------------------------------------------------------
  const transcriptContainerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = transcriptRef.current?.getScrollElement() ?? null;
    transcriptContainerRef.current = el;
  });
  useNativeQuoteReply(transcriptContainerRef);

  // Clear staged quotes and dismiss the reply bubble when the active
  // conversation changes to prevent quotes from one conversation leaking
  // into another.
  useEffect(() => {
    const store = useQuoteReplyStore.getState();
    if (store.stagedQuotes.length > 0 || store.replyBubble) {
      store.clearStagedQuotes();
      store.closeReplyBubble();
    }
  }, [activeConversationId]);

  const handleClearContext = useCallback(
    () => void sendMessage("/clean"),
    [sendMessage],
  );

  // -------------------------------------------------------------------------
  // Feature flags
  // -------------------------------------------------------------------------
  const queueSteering = useAssistantFeatureFlagStore.use.queueSteering();

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

  const renderOnboardingChoice = useCallback(() => (
    <OnboardingChoiceCard
      onSelectSpecific={handleSelectSpecific}
      onSubmitTasks={handleSubmitTasks}
    />
  ), [handleSelectSpecific, handleSubmitTasks]);

  // -------------------------------------------------------------------------
  // Edit-message recall (up-arrow)
  // -------------------------------------------------------------------------
  const { editingMessageId, isEditing, startEditing, cancelEditing } = useEditMessage(messages);

  const handleRecallLastMessage = useCallback(() => {
    const content = startEditing();
    if (content !== null) useComposerStore.getState().setInput(content);
  }, [startEditing]);

  const handleCancelEdit = useCallback(() => {
    cancelEditing();
    useComposerStore.getState().setInput("");
  }, [cancelEditing]);

  // Clear stale edit-recall state when the active conversation changes: ChatMainPanel
  // is not keyed by conversation, so an edit started in one thread would otherwise
  // leak into the next and drive its send down the undo path.
  useEffect(() => {
    cancelEditing();
  }, [activeConversationId, cancelEditing]);

  // -------------------------------------------------------------------------
  // Nudges + ghost text
  // -------------------------------------------------------------------------
  const nudges = useAppNudges(messages, conversations.length, liveAssistantMessageId, activeConversationId);

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
    messages,
    showThinking,
    turnActive: isAssistantBusy,
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
    diskPressureInputDisabled;

  const sendDisabled = isSendDisabledFromTurn || typingDisabled;

  const handleQuoteAddedToChat = useCallback(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [inputRef]);

  const isEmptyConversation =
    !!activeConversationId &&
    !isLoadingHistory &&
    messages.length === 0 &&
    // A turn already in flight (e.g. the onboarding auto-greet, or any send whose
    // first token hasn't landed) is NOT an empty conversation — showing the
    // "start a conversation" empty state here flashes it for a beat before the
    // streaming reply materializes (notably across the onboarding draft→real
    // conversation switch, which resets the snapshot mid-turn).
    !activeConversationIsProcessing &&
    !isAssistantBusy &&
    !(assistantState.kind === "active" && assistantState.maintenanceMode?.enabled);

  const showDoctorAction =
    assistantState.kind === "active" && !assistantState.isLocal;
  const doctorAction = showDoctorAction ? (
    <Button asChild variant="outlined" size="compact">
      <Link to={`${routes.settings.debug}?tab=doctor`}>
        Go to Doctor
      </Link>
    </Button>
  ) : undefined;

  // Blocked automatic opens (see `handleOpenUrl`) carry the URL in
  // `actionUrl`; the button click is a real user gesture, so the re-open
  // always succeeds and the banner clears itself.
  const buildOpenUrlAction = (
    actionUrl: string | undefined,
    clear: () => void,
  ) =>
    actionUrl ? (
      <Button
        variant="outlined"
        size="compact"
        onClick={() => {
          if (openUrlInPopupOrTab(actionUrl)) {
            clear();
          }
        }}
      >
        Open page
      </Button>
    ) : undefined;

  const genericChatError = shouldShowGenericChatErrorNotice(error) && error
    ? {
        message: error.message,
        tone: "error" as const,
        actions:
          buildOpenUrlAction(error.actionUrl, () =>
            useChatSessionStore.getState().setError(null),
          ) ?? doctorAction,
      }
    : null;
  const hasGenericChatError = genericChatError !== null;
  const genericChatNotice =
    shouldShowGenericChatErrorNotice(notice) && notice
      ? {
          message: notice.message,
          tone: "warning" as const,
          actions:
            buildOpenUrlAction(notice.actionUrl, () =>
              useChatSessionStore.getState().setNotice(null),
            ) ??
            (isManagedCredentialChatError(notice) ? doctorAction : undefined),
        }
      : null;
  const genericChatBanner = genericChatError ?? genericChatNotice;

  const handleDismissChatError = useCallback(() => {
    // Clears the inline `genericChatError` Notice. The modal variant has
    // its own close handler because it also restores the draft input.
    if (hasGenericChatError) {
      useChatSessionStore.getState().setError(null);
    } else {
      useChatSessionStore.getState().setNotice(null);
    }
  }, [hasGenericChatError]);

  const sendErrorModalNode =
    error?.displayAs === "modal" ? (
      <SendErrorModal
        open
        message={error.message}
        onClose={() => {
          if (typeof error.restoreContent === "string") {
            useComposerStore.getState().setInput(error.restoreContent);
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

  // While a conversation's row hasn't loaded (a draft, or one opened by URL
  // mid-load), its profile lives in the composer stash, not on a server row —
  // feed it in so attachment/vision gating reflects the profile the first
  // message will actually use rather than the global default.
  const pendingDraftProfiles = useConversationStore.use.pendingDraftProfiles();
  const activeDraftProfile =
    !activeConversation && activeConversationId
      ? pendingDraftProfiles.get(activeConversationId) ?? undefined
      : undefined;
  const activeProfileModel = useActiveProfileModel(
    assistantId,
    activeConversation?.conversationId,
    activeDraftProfile,
  );
  const activeModelSupportsVision = activeProfileModel?.supportsVision ?? true;
  const visionGateActive = useVisionAttachmentGate();

  const isInMaintenanceWithNoMessages =
    !isLoadingHistory &&
    messages.length === 0 &&
    assistantState.kind === "active" &&
    assistantState.maintenanceMode?.enabled === true;

  // -------------------------------------------------------------------------
  // Attachment drop zone
  // -------------------------------------------------------------------------
  const handleDroppedFiles = useCallback(
    (files: FileList | File[]) => {
      const arr = Array.from(files);
      const allowed = !visionGateActive || activeModelSupportsVision
        ? arr
        : arr.filter((f) => !f.type.startsWith("image/"));
      if (allowed.length < arr.length) {
        useComposerStore.setState({
          attachmentLastError:
            "The current model doesn't support image input. Switch to a vision-capable model to attach images.",
        });
      }
      if (allowed.length > 0) addChatAttachmentFiles(allowed);
    },
    [addChatAttachmentFiles, activeModelSupportsVision, visionGateActive],
  );
  const handleDroppedDirectories = useCallback((directories: File[]) => {
    const { resolvedPaths, unresolvedCount } =
      resolveDroppedDirectories(directories);
    if (resolvedPaths.length > 0) {
      useComposerStore.getState().addPathReferences(resolvedPaths);
    }
    if (unresolvedCount > 0) {
      useComposerStore.setState({
        attachmentLastError: WEB_FOLDER_DROP_ERROR,
      });
    }
  }, []);
  const {
    isDragOver: isAttachmentDragOver,
    dropHandlers: attachmentDropHandlers,
  } = useChatAttachmentDropZone({
    onFiles: handleDroppedFiles,
    onDirectories: handleDroppedDirectories,
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
  // Composer submit (extracted hook — fixes fake FormEvent pattern)
  // -------------------------------------------------------------------------
  const { submitMessage, handleFormSubmit } = useComposerSubmit({
    sendMessage,
    inputRef,
    scrollToLatest: scrollCoordinator.scrollToLatest,
    isEditing,
    editingMessageId,
    cancelEditing,
    canUndoEdit: isNativeConversation,
    sendDisabled,
    typingDisabled,
    assistantId,
    activeConversationId,
  });

  const handleSelectStarter = useCallback((starter: { prompt: string }) => {
    useComposerStore.getState().setInput(starter.prompt);
    void submitMessage(starter.prompt);
  }, [submitMessage]);

  // -------------------------------------------------------------------------
  // New-thread suggestion drawer (behind the flag, empty-state only)
  // -------------------------------------------------------------------------
  const newThreadSuggestionsEnabled =
    useClientFeatureFlagStore.use.newThreadSuggestions();
  // Called unconditionally — the desktop drawer vs mobile sheet choice below
  // branches on this, but the hook must run on every render.
  const isMobile = useIsMobile();
  const [selectedSuggestion, setSelectedSuggestion] =
    useState<ThreadSuggestion | null>(null);

  // Clear any open suggestion detail when the active conversation changes or the
  // thread leaves the empty state. Keying on `activeConversationId` covers the
  // empty→empty switch (id changes while `isEmptyConversation` stays true), which
  // the non-empty transition alone would miss — otherwise the stale drawer/sheet
  // could submit the previous selection into the newly active thread, since
  // ChatMainPanel is not keyed by conversation. Setting null on a fresh empty
  // conversation is harmless because no card is selected yet.
  useEffect(() => {
    setSelectedSuggestion(null);
  }, [activeConversationId, isEmptyConversation]);

  // Close, and Save-for-later, both just dismiss the drawer: persisting saved
  // suggestions is not implemented yet.
  const handleCloseSuggestion = useCallback(() => setSelectedSuggestion(null), []);

  const handleConfirmSuggestion = useCallback(
    (s: ThreadSuggestion) => {
      // Seed the composer before submitting (mirrors handleSelectStarter) so a
      // blocked send leaves the prompt in the composer to retry, rather than
      // silently dropping it when the drawer closes.
      handleSelectStarter({ prompt: s.prompt });
      setSelectedSuggestion(null);
    },
    [handleSelectStarter],
  );

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
    belowFoldSlot,
    dockStartersToBottom,
    renderAvatar,
    emptyStatePlaceholder,
  } = useChatEmptyState({
    assistantId,
    conversationId: activeConversationId,
    isEmptyConversation,
    avatar,
    mainView,
    openedAppState,
    isAssistantBusy,
    onSelectStarter: handleSelectStarter,
    onSelectSuggestion: newThreadSuggestionsEnabled
      ? setSelectedSuggestion
      : undefined,
  });

  // -------------------------------------------------------------------------
  // Banner slots (nudge, queued)
  // -------------------------------------------------------------------------
  const { mainBannerSlot, mainQueuedDrawerSlot } = useChatBannerSlots({
    nudges,
    queuedMessages,
    onCancelQueuedMessage: handleCancelQueuedMessage,
    onCancelAllQueued: handleCancelAllQueued,
    onSteerMessage: handleSteerMessage,
    onEditQueueTail: handleEditQueueTail,
    queueSteering,
  });

  // -------------------------------------------------------------------------
  // Billing composer banner
  // -------------------------------------------------------------------------
  const errorBillingBannerDecision = getChatBillingBannerDecision(error);
  const noticeBillingBannerDecision = getChatBillingBannerDecision(notice);
  const billingBannerDecision =
    errorBillingBannerDecision ?? noticeBillingBannerDecision;

  // -------------------------------------------------------------------------
  // JSX construction
  // -------------------------------------------------------------------------
  const chatTranscriptProps: TranscriptProps = {
    items: transcriptItems,
    conversationId: activeConversationId,
    assistantDisplayName: assistantName?.trim() || undefined,
    onOpenRuleEditor: handleOpenRuleEditorForToolCall,
    onOpenApp: handleOpenApp,
    onOpenDocument: handleOpenDocument,
    assistantId,
    unknownNudgeToolCallIds,
    onDismissUnknownNudge: handleDismissUnknownNudge,
    onSurfaceAction: handleSurfaceActionCallback,
    onConfirmationSubmit: handleConfirmationSubmit,
    onAllowAndCreateRule: handleAllowAndCreateRule,
    onForkConversation: handleForkConversationCallback,
    onSummarizeUpToHere,
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
    onWorkflowClick,
    onStopWorkflow,
    renderOnboardingChoice,
  };

  const cmdEnterMode = cmdEnterToSend.useValue();

  // Explicit props (no spread bundle): the contract is visible here, and the
  // composer self-sources its own store state, so nothing high-frequency is
  // threaded through. `ChatBody` renders this node as-is.
  const composerNode = (
    <ChatComposer
      cmdEnterMode={cmdEnterMode}
      placeholder={
        isEmptyConversation ? emptyStatePlaceholder : "What would you like to do?"
      }
      onSubmit={handleFormSubmit}
      inputRef={inputRef}
      typingDisabled={typingDisabled}
      sendDisabled={sendDisabled}
      onAddAttachmentFiles={handleDroppedFiles}
      voiceInputRef={voiceInputRef}
      voiceInterim={voiceInterim ?? undefined}
      onVoiceTranscript={handleVoiceTranscript}
      onVoiceInterimTranscript={setVoiceInterim}
      onVoiceError={setVoiceError}
      onVoiceBeforeStart={handleVoiceBeforeStart}
      onStopGenerating={handleStopGenerating}
      isAssistantBusy={isAssistantBusy}
      assistantId={assistantId}
      // Routing-truth id (NOT `activeConversation?.conversationId`, which is
      // transiently undefined until the row loads and always undefined for
      // drafts): live-voice session ownership compares against this, and the
      // session should attach to the thread the user is looking at — draft
      // ids included (the runtime accepts client-generated conversation ids).
      conversationId={activeConversationId}
      onRecallLastMessage={isIdle && isNativeConversation ? handleRecallLastMessage : undefined}
      onCancelEdit={isEditing ? handleCancelEdit : undefined}
      textareaMaxHeightPx={isEmptyConversation ? 320 : undefined}
      suggestion={suggestion}
      hasBillingBanner={billingBannerDecision !== null}
      thresholdPickerSlot={
        assistantId ? (
          <ComposerSettingsMenu
            assistantId={assistantId}
            conversationId={activeConversation?.conversationId}
          />
        ) : undefined
      }
      contextWindowIndicatorSlot={
        <ContextWindowIndicator
          usage={contextWindowUsage}
          assistantName={assistantName}
          onClearContext={
            activeConversation?.conversationId && !sendDisabled
              ? handleClearContext
              : undefined
          }
        />
      }
      noticesAboveFormSlot={
        <ComposerNotices
          voiceError={voiceError}
          onClearVoiceError={clearVoiceError}
          onRetryMicPermission={handleRetryMicPermission}
          onOpenMicSettings={handleOpenMicSettings}
          onOpenTextInsertionSettings={handleOpenTextInsertionSettings}
          billingBannerSlot={
            billingBannerDecision === "managed_credits" ? (
              <CreditsExhaustedBanner
                onAddFunds={() => setShowAddCreditsModal(true)}
              />
            ) : billingBannerDecision === "provider_billing" ? (
              <ProviderBillingBanner onOpenSettings={pushToAiSettings} />
            ) : null
          }
          diskPressureBanner={diskPressureBannerSlot}
          showMissingApiKeyBanner={
            error?.code === "PROVIDER_NOT_CONFIGURED"
          }
          onOpenAiSettings={pushToAiSettings}
          onDismissApiKeyError={handleDismissApiKeyError}
          compactionCircuitOpenUntil={compactionCircuitOpenUntil}
          onCompactionCircuitExpired={handleCompactionCircuitExpired}
          showMaintenanceBanner={
            assistantState.kind === "active" &&
            assistantState.maintenanceMode?.enabled === true
          }
          showMaintenanceExitAction={!statusBannerVisible}
          assistantId={assistantId}
          onMaintenanceExited={handleMaintenanceExited}
        />
      }
    />
  );

  const chatBodyScrollAreaPropsBase = {
    isLoadingHistory,
    messageCount: messages.length,
    showEmptyState: isEmptyConversation,
    emptyStateProps: chatEmptyStateProps,
    transcriptRef,
    transcriptProps: chatTranscriptProps,
  };

  const newChatPluginsSlot =
    isEmptyConversation && supportsNewChatPlugins && assistantId ? (
      <NewChatPluginsSection assistantId={assistantId} />
    ) : undefined;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  const editingConversationId = useConversationStore.use.editingConversationId();
  const isSidePanel = mainView === "app-editing" && !!openedAppState && !!editingConversationId;
  const variant = isSidePanel ? "side-panel" : "main";

  // Mobile-only: while the app overlay is minimized to its bottom strip, the
  // strip covers the bottom of the chat. Reserve its height so the composer
  // sits above it. The guard mirrors the strip's mount condition — the strip
  // renders only while `mainView === "app"`, and navigation can leave
  // `isAppMinimized`/`openedAppState` set after it unmounts. The strip peeks
  // `--app-strip-h` above the safe area, and the chat shell already pads for
  // the safe area itself, so only the strip height needs reserving.
  const appStripBottomInset =
    isMobile && mainView === "app" && isAppMinimized && openedAppState
      ? "var(--app-strip-h, 64px)"
      : undefined;

  const chatBody = (
    <ChatBody
      variant={variant}
      bottomInset={appStripBottomInset}
      scrollAreaProps={{
        ...chatBodyScrollAreaPropsBase,
        showMaintenanceRecoveryCard: isSidePanel ? false : isInMaintenanceWithNoMessages,
      }}
      composerSlot={composerNode}
      pluginPillsSlot={newChatPluginsSlot}
      dragHandlers={attachmentDropHandlers}
      isAttachmentDragOver={isAttachmentDragOver}
      showScrollToLatest={
        scrollCoordinator.showScrollToLatest && messages.length > 0
      }
      onScrollToLatest={handleScrollToLatest}
      isAssistantBusy={isAssistantBusy}
      refreshFeedback={refreshFeedback}
      onDismissRefreshFeedback={handleDismissRefreshFeedback}
      onRetryRefresh={handleRetryRefreshFromPill}
      genericChatError={genericChatBanner}
      onDismissChatError={handleDismissChatError}
      bannerSlot={isSidePanel ? undefined : mainBannerSlot}
      queuedDrawerSlot={isSidePanel ? undefined : mainQueuedDrawerSlot}
      startersSlot={startersSlot}
      belowFoldSlot={belowFoldSlot}
      dockStartersToBottom={dockStartersToBottom}
      activeProcessOverlaysSlot={
        hasActiveProcess ? activeProcessOverlays : undefined
      }
    />
  );

  const suggestionDetailPanel = selectedSuggestion ? (
    <SuggestionDetailPanel
      suggestion={selectedSuggestion}
      onClose={handleCloseSuggestion}
      onConfirm={handleConfirmSuggestion}
    />
  ) : null;

  // Behind the flag the picked suggestion's detail rides alongside the chat.
  //
  // Desktop: an animated right-hand drawer. The wrapper is gated on the flag
  // (and desktop), NOT on `isEmptyConversation`, so the `chatBody` subtree keeps
  // the same tree position across the empty→active transition and never
  // remounts — preserving composer focus/textarea state through the first send.
  // Suggestion cards only render in the empty state, so `selectedSuggestion` is
  // null in active conversations and the drawer simply sits closed there.
  //
  // Mobile: `AnimatedRightDrawer` is a desktop split that overflows narrow
  // viewports, so the chat renders normally and the detail floats above it in a
  // `BottomSheet` instead.
  //
  // Flag off (either viewport): the chat renders exactly as before — no wrapper.
  let mainContent: ReactNode = chatBody;
  if (newThreadSuggestionsEnabled && !isMobile) {
    mainContent = (
      <AnimatedRightDrawer
        open={Boolean(selectedSuggestion)}
        storageKey="vellum:suggestion-drawer-width"
        left={chatBody}
        right={suggestionDetailPanel}
      />
    );
  } else if (newThreadSuggestionsEnabled && isMobile) {
    mainContent = (
      <>
        {chatBody}
        <BottomSheet.Root
          open={Boolean(selectedSuggestion)}
          onOpenChange={(next) => {
            if (!next) handleCloseSuggestion();
          }}
        >
          {/* `SuggestionDetailPanel` brings its own visible heading + scroll-
              body + footer, so it sits directly inside `Content` (no
              BottomSheet.Body). The taller cap plus the panel's `h-full` give it
              a bounded height inside the sheet's flex column so its body scrolls.
              Radix Dialog still needs a Title for screen readers; the panel's
              heading isn't a Dialog.Title, so a visually-hidden one mirrors it
              (matches composer-settings-menu's pattern). */}
          <BottomSheet.Content
            aria-describedby={undefined}
            className="h-[80dvh] max-h-[80dvh]"
          >
            <BottomSheet.Header className="sr-only">
              <BottomSheet.Title>
                {selectedSuggestion?.detail.heading ?? "Suggestion"}
              </BottomSheet.Title>
            </BottomSheet.Header>
            {suggestionDetailPanel}
          </BottomSheet.Content>
        </BottomSheet.Root>
      </>
    );
  }

  return (
    <>
      {mainContent}
      <MicPermissionPrimer
        open={showPrimer}
        onContinue={handlePrimerContinue}
        onCancel={handlePrimerCancel}
      />
      {sendErrorModalNode}
      {ruleEditorModalNode}
      <TextSelectionPopover containerRef={transcriptContainerRef} />
      <QuoteReplyBubble onAddToChat={handleQuoteAddedToChat} />
    </>
  );
}

/** @deprecated Use {@link ChatMainPanel} — kept for migration. */
export const ChatRouteContent = ChatMainPanel;
