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

import {
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { markBoot } from "@/lib/telemetry/boot-telemetry";
import { useAcpRunRehydration } from "@/domains/chat/hooks/use-acp-run-rehydration";
import { useBackgroundTaskRehydration } from "@/domains/chat/hooks/use-background-task-rehydration";
import { useChatUIState } from "@/domains/chat/hooks/use-chat-ui-state";
import { useTranscriptData } from "@/domains/chat/hooks/use-transcript-data";
import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";
import { useChatEmptyState } from "@/domains/chat/hooks/use-chat-empty-state";
import { useComposerSubmit } from "@/domains/chat/hooks/use-composer-submit";
import { useDraftSecretDetection } from "@/domains/chat/hooks/use-draft-secret-detection";
import type { SendChatMessageOptions } from "@/domains/chat/hooks/use-send-message";
import {
  DiskPressureBannerSlot,
  useDiskPressureBannerVisibility,
} from "@/domains/chat/components/disk-pressure-banner-slot";
import { ResourcePressureBannerSlot } from "@/domains/chat/components/resource-pressure-banner-slot";
import { useRuleEditorBridge } from "@/domains/chat/hooks/use-rule-editor-bridge";
import { useChatBannerSlots } from "@/domains/chat/hooks/use-chat-banner-slots";
import { QuoteReplyBubble } from "@/domains/chat/components/quote-reply-bubble";
import { TextSelectionPopover } from "@/domains/chat/components/text-selection-popover";
import { useNativeQuoteReply } from "@/domains/chat/hooks/use-native-quote-reply";
import { useQuoteReplyStore } from "@/domains/chat/quote-reply-store";
import { useChannelReferenceStore } from "@/domains/chat/channel-sidecar/channel-reference-store";
import {
  useChannelSidecar,
  useChannelSidecarFlag,
} from "@/domains/chat/channel-sidecar/use-channel-sidecar";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel";
import { resolveComposerPlaceholder } from "@/domains/chat/utils/composer-placeholder";
import { isPopoutWindow } from "@/runtime/popout-window";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { isImageAttachment } from "@/domains/chat/components/chat-attachments/utils";
import { useChatAttachmentDropZone } from "@/domains/chat/components/chat-attachments/use-chat-attachment-drop-zone";
import { useVisionAttachmentGate } from "@/lib/backwards-compat/vision-attachment-gate";
import { useSupportsNewChatPlugins } from "@/lib/backwards-compat/use-supports-new-chat-plugins";
import { recordCommit } from "@/lib/commit-pressure";
import { copyToClipboard } from "@/lib/copy-to-clipboard";
import { useSwitchPaintMeasurement } from "@/lib/telemetry/switch-telemetry";
import { NewChatPluginsSection } from "@/domains/chat/components/new-chat-plugins/new-chat-plugins-section";
import { useComposerStore } from "@/domains/chat/composer-store";
import { ActiveProcessOverlay } from "@/domains/chat/process-registry/active-process-overlay";
import {
  OVERLAY_PROCESS_KINDS,
  POPOUT_OVERLAY_PROCESS_KINDS,
} from "@/domains/chat/process-registry/registry";
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
import { OrphanedHistoryNotice } from "@/domains/chat/components/orphaned-history-notice";
import { ComposerSecretNotice } from "@/domains/chat/components/composer-secret-notice";
import { ComposerSettingsMenu } from "@/domains/chat/components/composer-settings-menu";
import { ContextWindowIndicator } from "@/domains/chat/components/context-window-indicator";
import { DailyLimitBanner } from "@/domains/chat/components/daily-limit-banner";
import { LowBalanceBanner } from "@/domains/chat/components/low-balance-banner";
import { MicPermissionPrimer } from "@/domains/chat/components/mic-permission-primer";
import { OnboardingChoiceCard } from "@/domains/chat/components/onboarding-choice-card";
import { ProviderBillingBanner } from "@/domains/chat/components/provider-billing-banner";
import { SendErrorModal } from "@/domains/chat/components/send-error-modal";
import { StoreCredentialDialog } from "@/domains/chat/components/store-credential-dialog";
import { SuggestionDetailPanel } from "@/domains/chat/components/suggestion-detail-panel";
import type { DetectedSecret } from "@vellumai/service-contracts/secret-detection";
import type { ThreadSuggestion } from "@/domains/chat/suggestions/types";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTranslation } from "@/i18n";
import { BottomSheet } from "@vellumai/design-library";
import { useEditMessage } from "@/domains/chat/hooks/use-edit-message";
import { useOnboardingChoice } from "@/domains/chat/hooks/use-onboarding-choice";
import { usePullRefresh } from "@/domains/chat/hooks/use-pull-refresh";
import type {
  TranscriptHandle,
  TranscriptProps,
} from "@/domains/chat/transcript/transcript";
import { useTranscriptScroll } from "@/domains/chat/transcript/use-transcript-scroll";
import { useIsNativePlatform } from "@/runtime/native-auth";
import {
  resolveDroppedDirectories,
  WEB_FOLDER_DROP_ERROR,
} from "@/domains/chat/components/chat-attachments/handle-folder-drop";
import { Button } from "@vellumai/design-library";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import {
  getChatBillingBannerDecision,
  isManagedCredentialChatError,
  resolveComposerBillingBanner,
  shouldShowGenericChatErrorNotice,
} from "@/domains/chat/utils/error-classification";
import { openUrlInPopupOrTab } from "@/domains/chat/utils/oauth-popup-links";
import { useBillingBalanceStatus } from "@/hooks/use-billing-balance-status";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import type {
  DisplayAttachment,
  DisplayMessage,
} from "@/domains/chat/types/types";
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
import type { UseResourcePressureMonitorResult } from "@/assistant/use-resource-pressure-monitor";
import { useAppNudges } from "@/domains/chat/hooks/use-app-nudges";
import { useGhostTextSuggestion } from "@/domains/chat/hooks/use-ghost-text-suggestion";
import {
  handleConfirmationSubmit,
  handleAllowAndCreateRule,
} from "@/domains/chat/confirmation-actions";
import {
  handleOpenRuleEditorForToolCall,
  handleSaveRule,
  handleSaveAsNewRule,
} from "@/domains/chat/rule-editor-actions";
import { handleSurfaceAction } from "@/domains/chat/surface-actions";
import { useRuleEditorStore } from "@/domains/chat/rule-editor-store";
import { useOpenAppFromChat } from "@/domains/chat/hooks/use-open-app-from-chat";
import { useVoiceInput } from "@/domains/chat/hooks/use-voice-input";
import { useConversationListQuery } from "@/hooks/conversation-queries";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { shouldMintNewChatDraft } from "@/domains/chat/utils/conversation-selection";
import { isNativeMobile } from "@/runtime/platform-detection";
import { useConversationStore } from "@/stores/conversation-store";
import { paneState } from "@/stores/pane-state";
import { useDoctorHandoffStore } from "@/stores/doctor-handoff-store";
import { useLowBalanceBannerStore } from "@/stores/low-balance-banner-store";

/**
 * Self-hosted recovery for a rejected assistant API key. Mirrors the hint the
 * daemon returns from its own auth route (`runtime/routes/auth-routes.ts`) —
 * keep the two in step.
 */
const REPROVISION_ASSISTANT_KEY_COMMAND =
  "assistant keys set credential/vellum/assistant_api_key <key>";

// ---------------------------------------------------------------------------
// Props — only values that cannot be owned locally
// ---------------------------------------------------------------------------

export interface ChatMainPanelProps {
  // Send message (orchestration owns the SSE / queue lifecycle)
  sendMessage: (
    content: string,
    attachments?: DisplayAttachment[],
    opts?: SendChatMessageOptions,
  ) => Promise<void>;
  handleStopGenerating: () => Promise<void>;
  queuedMessages: DisplayMessage[];
  handleCancelQueuedMessage: (messageId: string) => void;
  handleCancelAllQueued: () => void;
  handleSteerMessage: (messageId: string) => void;
  handleEditQueueTail: () => void;

  // Conversation secondary actions (orchestration dependency)
  /** Forks through a message. Omitted unless the viewer passes the
   *  staff + `fork-from-message` gate, which hides the hover action. */
  handleForkConversation?: (throughMessageId: string) => Promise<void>;
  /** Opens the "Summarize up to here" confirm dialog for a message. */
  onSummarizeUpToHere?: (messageId: string) => void;
  /** Opens the "Retry" confirm dialog for the latest assistant turn. */
  onRetryLatestTurn?: () => void;
  handleInspectMessage?: (messageId: string) => void;

  // History pagination (from useConversationLoader in ActiveChatView)
  historyPagination: HistoryPaginationResult;

  // Disk pressure (single instance lives in ActiveChatView; passed down to
  // avoid duplicate polling intervals and bus subscriptions)
  diskPressure: UseDiskPressureMonitorResult;

  // Resource pressure (single instance, same reasoning as disk pressure)
  resourcePressure: UseResourcePressureMonitorResult;

  // Upward signals to ActiveChatView local state
  setRefreshEpoch: Dispatch<SetStateAction<number>>;

  // Shared refs (owned by ActiveChatView for debug API / keydown handler)
  inputRef: RefObject<HTMLTextAreaElement | null>;
  sanitizedMessagesRef: MutableRefObject<DisplayMessage[]>;
  transcriptItemsRef: MutableRefObject<TranscriptItem[]>;
  transcriptRef: RefObject<TranscriptHandle | null>;
  uiContextRef: MutableRefObject<UIContext | null>;

  // Onboarding (local state in ActiveChatView)
  onboardingChoiceEligible: boolean;
  didOnboarding: boolean;
  onboardingConversationId: string | null;
}

/**
 * Builds the registry-driven row of active background-process overlays.
 *
 * Each descriptor's `useActiveIds()` is a zero-arg hook that resolves the
 * active conversation internally, so the hooks are called here at the
 * orchestrator level (where the conversation lives in context). All four run
 * unconditionally, since the Rules of Hooks forbid both iterating a descriptor
 * list with hooks and calling a subset of them per render. The results are
 * keyed by `descriptor.kind`, so the overlay row order follows the kind list
 * without positional coupling.
 *
 * `isPopout` selects that kind list. A windowed chat carries subagent and ACP
 * sessions in the header's `ConversationActivityPill`, so its overlay row holds
 * only workflows and background tasks. A pop-out renders no header at all, so
 * there the overlay covers every kind and stays the one ambient surface.
 *
 * `hasAny` lets the caller omit the row entirely when nothing is active, so the
 * absolutely-positioned container never mounts empty; the overlays themselves
 * also self-gate on their own ids.
 */
function useActiveProcessSlots(isPopout: boolean) {
  const subagentIds = SUBAGENT_DESCRIPTOR.useActiveIds();
  const acpRunIds = ACP_RUN_DESCRIPTOR.useActiveIds();
  const workflowIds = WORKFLOW_DESCRIPTOR.useActiveIds();
  const backgroundTaskIds = BACKGROUND_TASK_DESCRIPTOR.useActiveIds();
  // Keyed by `descriptor.kind` (not array position) so reordering a kind list
  // can't silently feed an overlay the wrong kind's ids.
  const idsByKind: Record<ProcessKind, string[]> = {
    subagent: subagentIds,
    "acp-run": acpRunIds,
    workflow: workflowIds,
    "background-task": backgroundTaskIds,
  };
  const kinds = isPopout ? POPOUT_OVERLAY_PROCESS_KINDS : OVERLAY_PROCESS_KINDS;
  const hasAny = kinds.some(
    (descriptor) => idsByKind[descriptor.kind].length > 0,
  );
  const overlays = kinds.map((descriptor) => (
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
  onRetryLatestTurn,
  handleInspectMessage,
  historyPagination,
  diskPressure,
  resourcePressure,
  setRefreshEpoch,
  inputRef,
  sanitizedMessagesRef,
  transcriptItemsRef,
  transcriptRef,
  uiContextRef,
  onboardingChoiceEligible,
  didOnboarding,
  onboardingConversationId,
}: ChatMainPanelProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation("chat");
  // A pop-out renders no header and no status banner, which changes both what
  // chrome is available and which kinds the overlay row has to carry.
  const isPopout = isPopoutWindow(location.search);
  const statusBannerVisible = !isPopout;

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
    (files: FileList | File[]) =>
      useComposerStore.getState().addFiles(files, assistantId),
    [assistantId],
  );
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  const assistantName = useAssistantIdentityStore.use.name();
  const chatPullToRefreshEnabled =
    useClientFeatureFlagStore.use.chatPullToRefreshEnabled();

  // -------------------------------------------------------------------------
  // Store reads — per-conversation state
  // -------------------------------------------------------------------------
  const transcriptMessages = useTranscriptMessages();

  // Channel sidecar: while the flag is on and this conversation is bound to an
  // external channel, rows the client can attribute to that channel are drawn
  // in the read-only drawer instead of here, so the Vellum lane shows each row
  // exactly once. Everything downstream in this panel (transcript projection,
  // scroll, empty state, counts) reads the lane, because the lane IS the chat
  // in that arrangement. `vellumMessages` is the same array by reference
  // whenever nothing moved, so ordinary conversations see no change at all.
  const { vellumMessages: messages } = useChannelSidecar({
    conversationId: activeConversationId,
    conversation: activeConversation,
    messages: transcriptMessages,
  });
  const error = useChatSessionStore.use.error();
  const notice = useChatSessionStore.use.notice();
  // A client-minted draft has no server row, so there is no history to wait
  // for and no transcript skeleton to show. Derived during render rather than
  // lowered from an effect: the store seeds `isLoadingHistory` true, so an
  // effect would only clear it after the first commit had already painted the
  // skeleton, which is the flash this is here to prevent.
  //
  // The cold-launch frame needs the same answer one step earlier. A native
  // shell renders once with nothing selected, before the bootstrap effect
  // mints the draft, so there is no id to look up yet. Asking the bootstrap's
  // own predicate whether a draft is what it is about to select covers that
  // frame, and keeps the two from drifting apart. Every other context (web,
  // and a native deep link that names a conversation) answers false and keeps
  // the skeleton, which is correct: those really are resolving which
  // conversation to load, and the web path waits on the conversation list to
  // do it.
  const rawIsLoadingHistory = useChatSessionStore.use.isLoadingHistory();
  const draftConversationIds = useConversationStore.use.draftConversationIds();
  const { conversationId: urlConversationId } = useParams<{
    conversationId: string;
  }>();
  const awaitingColdStartDraft = shouldMintNewChatDraft({
    platformStartsInNewChat: isNativeMobile(),
    urlConversationId: urlConversationId ?? null,
    currentConversationId: activeConversationId,
  });
  const isLoadingHistory =
    rawIsLoadingHistory &&
    !awaitingColdStartDraft &&
    !(activeConversationId && draftConversationIds.has(activeConversationId));
  const contextWindowUsage = useChatSessionStore.use.contextWindowUsage();
  const compactionCircuitOpenUntil =
    useChatSessionStore.use.compactionCircuitOpenUntil();
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
  const unknownNudgeToolCallIds =
    useInteractionStore.use.unknownNudgeToolCallIds();

  const handleOpenApp = useOpenAppFromChat();

  // -------------------------------------------------------------------------
  // Action callbacks
  // -------------------------------------------------------------------------
  const handleOpenDocument = useCallback(
    (surfaceId: string) => {
      haptic.light();
      if (assistantId) {
        void useViewerStore.getState().loadDocument(assistantId, surfaceId);
      }
    },
    [assistantId],
  );

  const { overlays: activeProcessOverlays, hasAny: hasActiveProcess } =
    useActiveProcessSlots(isPopout);

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
    (subagentId: string) =>
      void useSubagentStore.getState().abortSubagent(subagentId),
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

  const pushToDailyLimitSettings = useCallback(() => {
    void navigate(routes.settings.usageBillingDailyLimit);
  }, [navigate]);

  const checkAssistant = useCallback(
    () => lifecycleService.checkAssistant(),
    [],
  );

  const handleDismissUnknownNudge = useCallback(
    (toolCallId: string) =>
      useInteractionStore.getState().removeUnknownNudgeToolCallId(toolCallId),
    [],
  );

  const handleSurfaceActionCallback = useCallback(
    (surfaceId: string, action: string, input: unknown) => {
      return handleSurfaceAction(
        surfaceId,
        action,
        input as Record<string, unknown> | undefined,
      );
    },
    [],
  );

  const handleForkConversationCallback = useMemo(
    () =>
      handleForkConversation
        ? (messageId: string) => {
            void handleForkConversation(messageId);
          }
        : undefined,
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

  // Commit counter for the chat-route subtree. Deliberately dependency-less:
  // it has to run on every commit to measure how tightly they are packed,
  // which is what `Maximum update depth exceeded` actually reacts to. A layout
  // effect rather than a passive one, so the commit is recorded before
  // ResizeObserver, rAF, and timer callbacks can fire: an instrumented update
  // landing in that window would otherwise be consumed as attribution of the
  // commit that just finished instead of the commit it causes. Records nothing
  // but a few integers; see `lib/commit-pressure.ts`.
  useLayoutEffect(() => {
    recordCommit();
  });

  // Closes the switch measurement `switchToConversation` opened. That action
  // blanks the snapshot and sets `isLoadingHistory` in one commit, so the first
  // render that is not an empty loading transcript is the incoming
  // conversation's first paint. It runs from an ancestor effect
  // (`ActiveChatView`), which React commits after this one, so the render that
  // first carries the new id finds no pending window and measures nothing.
  // A history fetch that errored with nothing on screen reads exactly like an
  // instant empty conversation, so it has to veto the paint; an error that
  // still has a painted transcript behind it (a failed older page, a failed
  // background refetch) does not.
  const historyLoadFailed = historyPagination.isError && messages.length === 0;
  useSwitchPaintMeasurement({
    conversationId: activeConversationId,
    historyLoadFailed,
    transcriptPainted: !(isLoadingHistory && messages.length === 0),
    hadHistory: messages.length > 0,
  });

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

  // Same containment for a staged channel reference. It carries the
  // conversation it was taken from, so the clear is conditional: a reference
  // survives the drawer being closed and reopened within its own conversation,
  // and is dropped the moment the user is somewhere else or the sidecar flag
  // turns off. The flag-off clear is what keeps flag-off behavior identical
  // to a build without the feature: no chip, and nothing riding the next
  // send. Re-enabling starts from an empty slot.
  const channelSidecarEnabled = useChannelSidecarFlag();
  useEffect(() => {
    useChannelReferenceStore.getState().reconcileReference({
      conversationId: activeConversationId,
      sidecarEnabled: channelSidecarEnabled,
    });
  }, [activeConversationId, channelSidecarEnabled]);

  const handleClearContext = useCallback(
    () => void sendMessage("/clean"),
    [sendMessage],
  );

  // -------------------------------------------------------------------------
  // Draft secret detection: owns the composer warning's matches/dismissal
  // plus the pre-send gate state.
  // -------------------------------------------------------------------------
  const draftSecretDetection = useDraftSecretDetection({
    conversationId: activeConversationId,
  });

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
    onboardingChoiceEligible,
    activeConversationId,
    onboardingConversationId,
    sendMessage,
  });

  const renderOnboardingChoice = useCallback(
    () => (
      <OnboardingChoiceCard
        onSelectSpecific={handleSelectSpecific}
        onSubmitTasks={handleSubmitTasks}
      />
    ),
    [handleSelectSpecific, handleSubmitTasks],
  );

  // -------------------------------------------------------------------------
  // Edit-message recall (up-arrow)
  // -------------------------------------------------------------------------
  const { editingMessageId, isEditing, startEditing, cancelEditing } =
    useEditMessage(messages);

  const handleRecallLastMessage = useCallback(() => {
    const content = startEditing();
    if (content !== null) {
      useComposerStore.getState().setInput(content);
    }
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
  const nudges = useAppNudges(
    messages,
    conversations.length,
    liveAssistantMessageId,
    activeConversationId,
  );

  const lastCompleteAssistantMsgId = useMemo<string | null>(() => {
    const last = messages[messages.length - 1];
    return last &&
      last.role === "assistant" &&
      last.id !== liveAssistantMessageId
      ? (last.id ?? null)
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
  // Single balance-status read shared by every proactive billing surface in
  // this component: the transcript's tail card, the empty state's card, and
  // the low-balance composer banner. The active conversation is passed so
  // the BYOK suppression respects a per-conversation managed profile pin. A
  // client-minted draft has no server row to look up (the lookup would 404
  // and needlessly fail the gate open); its effective profile lives in the
  // composer stash, so that is threaded instead.
  const pendingDraftProfiles = useConversationStore.use.pendingDraftProfiles();
  const activeDraftId =
    activeConversationId && draftConversationIds.has(activeConversationId)
      ? activeConversationId
      : null;
  const balanceStatus = useBillingBalanceStatus({
    conversationId: activeDraftId ? null : activeConversationId,
    draftProfile: activeDraftId
      ? (pendingDraftProfiles.get(activeDraftId) ?? null)
      : null,
  });

  const { sanitizedMessages, transcriptItems } = useTranscriptData({
    messages,
    showThinking,
    turnActive: isAssistantBusy,
    thinkingLabel,
    showOnboardingChoice,
    creditsExhausted: balanceStatus.isExhausted,
  });

  // --- Ref writes (connect hook outputs to ActiveChatView's debug refs) ---
  useEffect(() => {
    uiContextRef.current = uiContext;
    return () => {
      uiContextRef.current = null;
    };
  }, [uiContextRef, uiContext]);

  useLayoutEffect(() => {
    sanitizedMessagesRef.current = sanitizedMessages;
  });
  useLayoutEffect(() => {
    transcriptItemsRef.current = transcriptItems;
  });

  // -------------------------------------------------------------------------
  // Remaining derived values
  // -------------------------------------------------------------------------
  const diskPressureChatBlockReason = getDiskPressureChatBlockReason({
    monitorEnabled: diskPressure.mode !== null,
    hasResolvedStatus: diskPressure.hasResolvedStatus,
    status: diskPressure.status,
  });
  const diskPressureInputDisabled = diskPressureChatBlockReason !== null;

  // First meaningful transcript paint: the exact condition under which
  // `ChatScrollArea` stops rendering `<ChatSkeleton />`. On the new-conversation
  // draft there is no history to wait for, so this lands immediately; on an
  // existing conversation it is the history fetch. `markBoot` is first-write-wins,
  // so later conversation switches within the page load do not overwrite it.
  const transcriptPainted = !(isLoadingHistory && messages.length === 0);
  useEffect(() => {
    if (transcriptPainted) {
      markBoot("transcript_painted");
    }
  }, [transcriptPainted]);

  const typingDisabled =
    isLoadingHistory ||
    (assistantState.kind === "active" &&
      !!assistantState.maintenanceMode?.enabled) ||
    diskPressureInputDisabled;

  const sendDisabled = isSendDisabledFromTurn || typingDisabled;

  // rAF: modal/popover teardown restores focus on close, so the composer
  // must claim it afterwards.
  const focusComposer = useCallback(() => {
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
    !(
      assistantState.kind === "active" &&
      assistantState.maintenanceMode?.enabled
    );

  const showDoctorAction =
    assistantState.kind === "active" && !assistantState.isLocal;
  const doctorAction = showDoctorAction ? (
    <Button asChild variant="outlined" size="compact">
      <Link to={`${routes.settings.debug}?tab=doctor`}>
        {t("chatRouteContent.goToDoctor")}
      </Link>
    </Button>
  ) : undefined;

  // The assistant API key is provisioned by the platform, so unlike a rejected
  // personal key there is nothing for the user to fix in Settings. Recovery
  // differs by how the assistant is hosted, so the banner offers one of two
  // actions rather than a single link:
  //
  //   platform-hosted → the Doctor, which can re-issue the key. The request is
  //     parked in the same one-shot store `/doctor <message>` uses, so the
  //     panel auto-starts a session already on topic, not on a blank prompt.
  //   self-hosted → the Doctor tab doesn't exist (it is platform-hosted only),
  //     but `assistant keys set` does. Copying the command is the whole fix, so
  //     the banner hands it over rather than leaving the user with no action.
  const reprovisionAssistantKeyAction = showDoctorAction ? (
    <Button asChild variant="outlined" size="compact">
      <Link
        to={`${routes.settings.debug}?tab=doctor`}
        onClick={() =>
          useDoctorHandoffStore
            .getState()
            .setPendingPrompt("Help me re-provision my assistant's API key")
        }
      >
        {t("chatRouteContent.askTheDoctor")}
      </Link>
    </Button>
  ) : assistantState.kind === "active" ? (
    <Button
      variant="outlined"
      size="compact"
      onClick={() =>
        copyToClipboard(REPROVISION_ASSISTANT_KEY_COMMAND, {
          successMessage: "Command copied. Run it where the assistant runs.",
          errorMessage: "Couldn't copy the command.",
        })
      }
    >
      {t("chatRouteContent.copyCliFix")}
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
        {t("chatRouteContent.openPage")}
      </Button>
    ) : undefined;

  const genericChatError =
    shouldShowGenericChatErrorNotice(error) && error
      ? {
          message: error.message,
          tone: "error" as const,
          actions:
            buildOpenUrlAction(error.actionUrl, () =>
              useChatSessionStore.getState().setError(null),
            ) ??
            (isManagedCredentialChatError(error)
              ? reprovisionAssistantKeyAction
              : doctorAction),
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
            (isManagedCredentialChatError(notice)
              ? reprovisionAssistantKeyAction
              : undefined),
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
  const activeDraftProfile =
    !activeConversation && activeConversationId
      ? (pendingDraftProfiles.get(activeConversationId) ?? undefined)
      : undefined;
  const activeProfileModel = useActiveProfileModel(
    assistantId,
    activeConversation?.conversationId,
    activeDraftProfile,
  );
  const activeModelSupportsVision = activeProfileModel?.supportsVision ?? true;
  const visionGateActive = useVisionAttachmentGate();
  // Whether an image attached to the next message would survive the turn. One
  // resolution for every surface that can attach one: the drop/pick filter
  // below, the Eyes toggle, and the send's own camera frame. On an assistant
  // with the image-fallback plugin the gate is inactive and the question does
  // not arise; below it, an image on a profile without vision fails the whole
  // turn on the provider's rejection.
  const imageAttachmentsAllowed =
    !visionGateActive || activeModelSupportsVision;

  const isInMaintenanceWithNoMessages =
    !isLoadingHistory &&
    messages.length === 0 &&
    assistantState.kind === "active" &&
    assistantState.maintenanceMode?.enabled === true;

  // -------------------------------------------------------------------------
  // Attachment drop zone
  // -------------------------------------------------------------------------
  const handleDroppedFiles = useCallback(
    (files: FileList | File[]): File[] => {
      const arr = Array.from(files);
      const allowed = imageAttachmentsAllowed
        ? arr
        : arr.filter((f) => !isImageAttachment(f));
      if (allowed.length < arr.length) {
        useComposerStore.setState({
          attachmentLastError:
            "The current model doesn't support image input. Switch to a vision-capable model to attach images.",
        });
      }
      if (allowed.length > 0) {
        addChatAttachmentFiles(allowed);
      }
      // What a caller reading one file at a time needs to know: an image
      // dropped here is never held, so it should not count against whatever
      // budget that caller is keeping.
      return allowed;
    },
    [addChatAttachmentFiles, imageAttachmentsAllowed],
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
    imageAttachmentsAllowed,
    // Synchronous pre-send gate: re-scans the outgoing content so pastes
    // sent inside the detection debounce window are still caught. No
    // secrets → returns true, fully inert.
    beforeSend: draftSecretDetection.checkBeforeSend,
  });

  // "Send anyway" on the blocked notice: arm the single-use client bypass
  // (bound to the exact intercepted content), then resubmit carrying the
  // daemon-side `bypassSecretCheck` override so the explicit confirmation
  // is honored end to end instead of resurfacing as a server
  // `secret_blocked` error. The `beforeSend` gate still runs: if the draft
  // changed since the block, the content-bound bypass misses, the send
  // re-blocks, and the override never reaches the wire.
  const { allowOnce: allowSecretSendOnce } = draftSecretDetection;
  const handleSecretSendAnyway = useCallback(() => {
    allowSecretSendOnce();
    void submitMessage(undefined, { bypassSecretCheck: true });
  }, [allowSecretSendOnce, submitMessage]);

  // "Store securely" on the notice: stage the previewed (first) detected
  // secret and open the store-credential dialog for it. The dialog saves the
  // key to the vault and rewrites the draft to reference the vault slot; the
  // detection hook's draft subscription then clears the notice/blocked state
  // on its own once the plaintext leaves the draft. Cancel just unstages —
  // notice, blocked state, and draft all stay as they were.
  const [secretToStore, setSecretToStore] = useState<DetectedSecret | null>(
    null,
  );
  const handleStoreSecretSecurely = useCallback(() => {
    setSecretToStore(draftSecretDetection.matches[0] ?? null);
  }, [draftSecretDetection.matches]);
  const handleStoreSecretClose = useCallback(() => {
    setSecretToStore(null);
  }, []);

  const handleSelectStarter = useCallback(
    (starter: { prompt: string }) => {
      useComposerStore.getState().setInput(starter.prompt);
      void submitMessage(starter.prompt);
    },
    [submitMessage],
  );

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
  const handleCloseSuggestion = useCallback(
    () => setSelectedSuggestion(null),
    [],
  );

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
  // One visibility instance is shared between the slot and the precedence
  // gate below, so the gate tracks what the slot actually renders even when
  // a dismissal's storage write fails and no cross-instance notification
  // fires.
  const diskPressureVisibility = useDiskPressureBannerVisibility(
    diskPressure,
    assistantId,
  );
  const diskPressureBannerVisible = diskPressureVisibility.visibleMode !== null;
  const diskPressureBannerSlot = (
    <DiskPressureBannerSlot
      diskPressure={diskPressure}
      visibility={diskPressureVisibility}
      assistantStateKind={assistantState.kind}
    />
  );

  // -------------------------------------------------------------------------
  // Resource pressure banner (localStorage-backed dismiss/cooldown)
  // -------------------------------------------------------------------------
  // The slot stays mounted even while yielding to the disk banner so its
  // in-memory dismissal fallback (for failed storage writes) survives the
  // disk episode; it hides its own output via `hidden`.
  const resourcePressureBannerSlot = (
    <ResourcePressureBannerSlot
      resourcePressure={resourcePressure}
      assistantId={assistantId}
      assistantName={assistantName}
      assistantStateKind={assistantState.kind}
      hidden={diskPressureBannerVisible}
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
    startersDockCollapsed,
    renderAvatar,
    emptyStatePlaceholder,
    composerPeekSlot,
  } = useChatEmptyState({
    assistantId,
    conversationId: activeConversationId,
    isEmptyConversation,
    avatar,
    mainView,
    openedAppState,
    isAssistantBusy,
    showCreditsUpsell: balanceStatus.isExhausted,
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
  });

  // A conversation whose branch parent was deleted renders its own messages
  // and nothing before them. Composed into the banner slot rather than
  // replacing it, and kept undefined when there is nothing to show, because
  // `ChatBody` decides whether to render the banner container from whether
  // this node exists.
  const orphanedHistoryBanner =
    activeConversation?.historyOrphaned === true ? (
      <OrphanedHistoryNotice />
    ) : null;
  const mainBannerWithNotices =
    orphanedHistoryBanner || mainBannerSlot ? (
      <>
        {orphanedHistoryBanner}
        {mainBannerSlot}
      </>
    ) : undefined;

  // -------------------------------------------------------------------------
  // Billing composer banner
  // -------------------------------------------------------------------------
  const errorBillingBannerDecision = getChatBillingBannerDecision(error);
  const noticeBillingBannerDecision = getChatBillingBannerDecision(notice);
  const billingBannerDecision =
    errorBillingBannerDecision ?? noticeBillingBannerDecision;

  const lowBalanceBannerDismissed = useLowBalanceBannerStore.use.dismissed();
  const composerBillingBanner = resolveComposerBillingBanner({
    billingBannerDecision,
    isLowBalance: balanceStatus.isLowBalance,
    dismissed: lowBalanceBannerDismissed,
    // State-driven, so the banner is already up when the user returns to an
    // app whose daily cap was reached by background turns.
    dailyLimitReached: balanceStatus.dailyLimitReached,
    // A skip clears the banner even when the error that raised it is still the
    // last thing that happened on this conversation.
    dailyLimitSnoozed: balanceStatus.dailyLimitSnoozed,
  });

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
    // Hidden while a turn is in flight: retrying mid-generation would 409,
    // and the affordance targets the settled latest response.
    onRetryLatestTurn: isAssistantBusy ? undefined : onRetryLatestTurn,
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

  // Whether the surface each settings menu owns is open. The mobile composer
  // floats those two triggers above its card and hides them when focus leaves,
  // and opening one takes focus out of the composer, so it needs the open state
  // to hold the row in place underneath the sheet. Each menu reports `false` on
  // its way out, so a presentation swap that unmounts an open one clears the
  // flag it set.
  const [accessSheetOpen, setAccessSheetOpen] = useState(false);
  const [profileSheetOpen, setProfileSheetOpen] = useState(false);
  const settingsSheetOpen = accessSheetOpen || profileSheetOpen;

  const composerAssistantName = assistantName?.trim();
  const composerPlaceholder = resolveComposerPlaceholder({
    isEmptyConversation,
    emptyStatePlaceholder,
    assistantPlaceholder:
      isMobile && composerAssistantName
        ? t("chatComposer.askAssistantPlaceholder", {
            assistantName: composerAssistantName,
          })
        : null,
    defaultPlaceholder: "What would you like to do?",
  });

  // Explicit props (no spread bundle): the contract is visible here, and the
  // composer self-sources its own store state, so nothing high-frequency is
  // threaded through. `ChatBody` renders this node as-is.
  const composerNode = (
    <ChatComposer
      cmdEnterMode={cmdEnterMode}
      placeholder={composerPlaceholder}
      onSubmit={handleFormSubmit}
      inputRef={inputRef}
      typingDisabled={typingDisabled}
      sendDisabled={sendDisabled}
      onAddAttachmentFiles={handleDroppedFiles}
      imageAttachmentsAllowed={imageAttachmentsAllowed}
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
      // Same value the empty state renders from, so "speak first" and "show
      // the blank-thread greeting" can never disagree about what empty means.
      conversationIsEmpty={isEmptyConversation}
      onRecallLastMessage={
        isIdle && isNativeConversation ? handleRecallLastMessage : undefined
      }
      onCancelEdit={isEditing ? handleCancelEdit : undefined}
      textareaMaxHeightPx={isEmptyConversation ? 320 : undefined}
      suggestion={suggestion}
      hasBillingBanner={composerBillingBanner !== null}
      settingsSheetOpen={settingsSheetOpen}
      thresholdPickerSlot={
        assistantId ? (
          <ComposerSettingsMenu
            assistantId={assistantId}
            conversationId={activeConversation?.conversationId}
            segments="access"
            onOpenChange={setAccessSheetOpen}
          />
        ) : undefined
      }
      modelPickerSlot={
        assistantId ? (
          <ComposerSettingsMenu
            assistantId={assistantId}
            conversationId={activeConversation?.conversationId}
            segments="profile"
            onOpenChange={setProfileSheetOpen}
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
        <>
          {draftSecretDetection.matches.length > 0 &&
            // A blocked send always surfaces the notice — even when the
            // passive warning for these values was previously dismissed.
            (!draftSecretDetection.dismissed ||
              draftSecretDetection.sendBlocked) && (
              <ComposerSecretNotice
                matches={draftSecretDetection.matches}
                // Non-reactive read — the mount point deliberately never
                // subscribes to composer input (typing must not re-render it).
                // This render is already driven by `matches` changing, and a
                // secret only leaves `input` via an edit that re-scans and
                // updates `matches`, so the value read here stays in step with
                // what "Store securely" (input-origin gated) can remove.
                composerInput={useComposerStore.getState().input}
                sendBlocked={draftSecretDetection.sendBlocked}
                onDismiss={draftSecretDetection.dismiss}
                onSendAnyway={handleSecretSendAnyway}
                onStoreSecurely={handleStoreSecretSecurely}
              />
            )}
          <ComposerNotices
            voiceError={voiceError}
            onClearVoiceError={clearVoiceError}
            onRetryMicPermission={handleRetryMicPermission}
            onOpenMicSettings={handleOpenMicSettings}
            onOpenTextInsertionSettings={handleOpenTextInsertionSettings}
            billingBannerSlot={
              composerBillingBanner === "daily_limit" ? (
                <DailyLimitBanner onAdjustLimit={pushToDailyLimitSettings} />
              ) : composerBillingBanner === "provider_billing" ? (
                <ProviderBillingBanner onOpenSettings={pushToAiSettings} />
              ) : composerBillingBanner === "low_balance" ? (
                <LowBalanceBanner />
              ) : null
            }
            diskPressureBanner={diskPressureBannerSlot}
            // A storage warning is actionable-critical and must not stack
            // with or compete against an upsell banner, so the resource
            // slot yields whenever the disk-pressure banner is actually
            // visible. Acknowledgement-required and cleanup modes are never
            // dismissible, so disk always wins there; a dismissed or
            // suppressed warning hands the space to the resource banner.
            resourcePressureBanner={resourcePressureBannerSlot}
            showMissingApiKeyBanner={error?.code === "PROVIDER_NOT_CONFIGURED"}
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
        </>
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
  const editingConversationId =
    useConversationStore.use.editingConversationId();
  const paneArrangement = paneState({
    mainView,
    appId: openedAppState?.appId ?? null,
    conversationId: activeConversationId,
    boundConversationId: editingConversationId,
    isAppMinimized,
  }).presentation;
  const isSidePanel = paneArrangement === "side";
  const variant = isSidePanel ? "side-panel" : "main";

  // Mobile-only: while the app is parked to its bottom strip, the strip covers
  // the bottom of the chat, so its height is reserved to keep the composer
  // above it. The strip peeks `--app-strip-h` above the safe area, and the
  // chat shell already pads for the safe area itself, so only the strip height
  // needs reserving.
  const appStripBottomInset =
    isMobile && paneArrangement === "bottom"
      ? "var(--app-strip-h, 64px)"
      : undefined;

  const chatBody = (
    <ChatBody
      variant={variant}
      bottomInset={appStripBottomInset}
      scrollAreaProps={{
        ...chatBodyScrollAreaPropsBase,
        showMaintenanceRecoveryCard: isSidePanel
          ? false
          : isInMaintenanceWithNoMessages,
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
      bannerSlot={isSidePanel ? undefined : mainBannerWithNotices}
      queuedDrawerSlot={isSidePanel ? undefined : mainQueuedDrawerSlot}
      startersSlot={startersSlot}
      belowFoldSlot={belowFoldSlot}
      dockStartersToBottom={dockStartersToBottom}
      startersDockCollapsed={startersDockCollapsed}
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
            if (!next) {
              handleCloseSuggestion();
            }
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
                {selectedSuggestion?.detail.heading ??
                  t("chatRouteContent.suggestionFallback")}
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
      {composerPeekSlot}
      <MicPermissionPrimer
        open={showPrimer}
        onContinue={handlePrimerContinue}
        onCancel={handlePrimerCancel}
      />
      {sendErrorModalNode}
      {ruleEditorModalNode}
      {/* Mounted only while a secret is staged: ChatMainPanel renders outside
          ActiveAssistantGate, and the dialog's vault mutation requires the
          active assistant id — which a detected draft secret implies. */}
      {secretToStore !== null && (
        <StoreCredentialDialog
          secret={secretToStore}
          // Routing-truth id: binds the staged secret to the conversation it
          // was detected in, so a mid-save conversation switch cancels the
          // store action instead of rewriting the wrong thread's draft.
          conversationId={activeConversationId}
          open
          onClose={handleStoreSecretClose}
          // Leave the rewritten draft focused for the user to review and
          // send — never auto-send.
          onStored={focusComposer}
        />
      )}
      <TextSelectionPopover containerRef={transcriptContainerRef} />
      <QuoteReplyBubble onAddToChat={focusComposer} />
    </>
  );
}
