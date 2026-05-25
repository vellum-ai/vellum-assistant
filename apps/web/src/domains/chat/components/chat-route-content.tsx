/**
 * Chat route content — renders the chat-specific UI (main chat, document panel,
 * app-editing side panel) inside `ChatLayout`.
 *
 * Extracted from `AssistantPageClient` as Phase 1 of route-level component
 * splitting. This component owns:
 * - Chat body rendering (transcript, composer, scroll coordination)
 * - Document viewer panel (split or full-width)
 * - App-editing side panel (chat + app viewer)
 * - All JSX construction for chat-specific slots (banners, prompts, notices)
 * - Scroll coordination, pull-refresh, attachment drop zone
 * - Handlers used exclusively by chat rendering (submit, select starter, etc.)
 *
 * The parent (`AssistantPage`) still owns hooks, state, and the route switch
 * that decides whether to render this component vs Intelligence/Library/App.
 *
 * @see Phase 2: Extract IntelligenceRouteContent
 * @see Phase 3: Extract LibraryRouteContent, AppRouteContent
 */

import * as Sentry from "@sentry/react";
import { type Dispatch, type FormEvent, type MutableRefObject, type ReactNode, type RefObject, type SetStateAction, useCallback, useEffect, useMemo, useRef } from "react";

import { ChatBody } from "@/domains/chat/components/chat-body.js";
import { SlackChannelFooter } from "@/domains/chat/components/slack-channel-footer.js";
import { ConversationStarterGrid } from "@/domains/chat/components/conversation-starter-grid.js";
import { ComposerNotices } from "@/domains/chat/components/composer-notices.js";
import { SendErrorModal } from "@/domains/chat/components/send-error-modal.js";
import { ConfirmationPromptCard } from "@/domains/chat/components/confirmation-prompt-card.js";
import { ContactPromptCard } from "@/domains/chat/components/contact-prompt-card.js";
import { QuestionPromptCard } from "@/domains/chat/components/question-prompt-card.js";
import { SecretPromptCard } from "@/domains/chat/components/secret-prompt-card.js";
import { usePullRefresh } from "@/domains/chat/hooks/use-pull-refresh.js";
import { useRefreshLatestMessages as _useRefreshLatestMessages } from "@/domains/chat/hooks/use-refresh-latest-messages.js";
import { useConversationStarters } from "@/domains/chat/hooks/use-conversation-starters.js";
import type { TranscriptHandle, TranscriptProps } from "@/domains/chat/transcript/transcript.js";
import { useTranscriptScroll } from "@/domains/chat/transcript/use-transcript-scroll.js";
import { hasPendingAssistantResponse } from "@/domains/chat/utils/chat-utils.js";
import type { ChatError } from "@/domains/chat/types.js";
import type { AssistantState } from "@/domains/chat/hooks/use-assistant-lifecycle.js";
import { useChatAttachmentDropZone } from "@/domains/chat/components/chat-attachments/use-chat-attachment-drop-zone.js";
import type { ChatAttachment } from "@/domains/chat/components/chat-attachments/use-chat-attachments.js";
import type { ChatEmptyStateProps } from "@/domains/chat/components/chat-empty-state.js";
import { CreditsExhaustedBanner } from "@/domains/chat/components/credits-exhausted-banner.js";
import { DiscordNudgeBanner } from "@/domains/nudges/components/discord-nudge-banner.js";
import { GitHubNudgeBanner } from "@/domains/nudges/components/github-nudge-banner.js";
import { IOSAppBanner } from "@/domains/nudges/components/ios-app-banner.js";
import { MacOSAppBanner } from "@/domains/nudges/components/macos-app-banner.js";
import { Loader2 } from "lucide-react";
import { Button, Notice, ResizablePanel } from "@vellum/design-library";
import { ProviderBillingBanner } from "@/domains/chat/components/provider-billing-banner.js";
import { QueuedMessagesDrawer } from "@/domains/chat/components/queued-messages-drawer.js";
import { AppViewerContainer } from "@/domains/chat/components/app-viewer-container.js";
import { DocumentViewerContainer } from "@/domains/chat/components/document-viewer-container.js";
import { ChatAvatar } from "@/components/avatar/chat-avatar.js";
import { ComposerSettingsMenu } from "@/domains/chat/components/composer-settings-menu.js";
import { ContextWindowIndicator, type ContextWindowUsage } from "@/domains/chat/components/context-window-indicator.js";
import { SubagentDetailPanel } from "@/domains/chat/components/subagent-detail-panel.js";
import { OnboardingChoiceCard } from "@/domains/chat/components/onboarding-choice-card.js";
import { useOnboardingChoice } from "@/domains/chat/hooks/use-onboarding-choice.js";
import { useIsNativePlatform } from "@/runtime/native-auth.js";

import { Link, useNavigate } from "react-router";

import { buildEditAppGreeting, buildEditAppStarters } from "@/domains/chat/utils/edit-app-empty-state.js";
import { pickRandomPlaceholder } from "@/domains/chat/utils/empty-state-constants.js";
import { useEmptyStateGreeting } from "@/domains/chat/hooks/use-empty-state-greeting.js";
import { getChatBillingBannerDecision, shouldShowGenericChatErrorNotice } from "@/domains/chat/utils/error-classification.js";

import { useAssistantFeatureFlagStore } from "@/lib/feature-flags/assistant-feature-flag-store.js";
import { useDeployStore } from "@/domains/chat/deploy-store.js";
import { useInteractionStore } from "@/domains/interactions/interaction-store.js";
import type { SubagentEntry, SubagentState } from "@/domains/subagents/subagent-store.js";
import type { DisplayAttachment, DisplayMessage } from "@/domains/chat/utils/reconcile.js";
import { sortedByTimestamp } from "@/domains/chat/utils/message-sorting.js";
import { buildTranscriptItems } from "@/domains/chat/transcript/build-items.js";
import type { TranscriptPaginationState } from "@/domains/chat/transcript/types.js";
import type { HistoryPaginationResult } from "@/domains/chat/transcript/use-history-pagination.js";
import {
  canStopGeneration,
  getThinkingStatusText,
  isSendDisabled,
  shouldShowThinkingIndicator,
  type UIContext,
} from "@/domains/messaging/turn-selectors.js";
import { isSurfaceInteractive } from "@/domains/chat/types/types.js";

import type { MainView, OpenedAppState, OpenedDocumentState } from "@/stores/viewer-store.js";
import { useActiveProfileModel } from "@/domains/chat/hooks/use-active-profile-model.js";
import { modelSupportsVision } from "@/assistant/model-capabilities.js";
import { isPointerCoarse } from "@/utils/pointer.js";
import { routes } from "@/utils/routes.js";
import { haptic } from "@/utils/haptics.js";
import { isChannelConversation as _isChannelConversation } from "@/domains/chat/utils/conversation-channel.js";
import { getDiskPressureChatBlockReason } from "@/assistant/disk-pressure.js";
import type { DiskPressureStatusEventPayload } from "@/assistant/use-disk-pressure-monitor.js";
import { type TurnState, useTurnStore } from "@/domains/messaging/turn-store.js";
import type { QuestionResponseEntry, AllowlistOption, ScopeOption, DirectoryScopeOption, ConfirmationDecision } from "@/domains/chat/api/event-types.js";
import type { CharacterComponents, CharacterTraits } from "@/domains/avatar/types.js";
import { DiskPressureBanner, type DiskPressureBannerMode } from "@/domains/chat/components/disk-pressure-banner.js";
import type { VoiceInputButtonHandle } from "@/domains/chat/components/voice-input-button.js";
import type { AssistantIdentity } from "@/assistant/identity.js";
import type { Conversation } from "@/domains/chat/api/conversations.js";
import { submitQuestionResponse } from "@/domains/chat/api/interactions.js";
import type { ChatEventStream } from "@/domains/chat/api/stream.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StreamContext {
  assistantId: string;
  conversationId: string;
}

/** Nudge state produced by useAppNudges. */
export interface NudgeHandlers {
  isOnIOS: boolean;
  showBanner: boolean;
  nudge: {
    handleDownload: () => void;
    handleBannerDismiss: () => void;
  };
  githubNudge: {
    handleStar: () => void;
    handleBannerDismiss: () => void;
  };
  showGitHubBanner: boolean;
  discordNudge: {
    handleJoin: () => void;
    handleBannerDismiss: () => void;
  };
  showDiscordBanner: boolean;
}

/** Voice input handlers passed from useVoiceInput. */
export interface VoiceInputHandlers {
  voiceInputRef: RefObject<VoiceInputButtonHandle | null>;
  voiceInterim: string | null;
  voiceError: string | null;
  clearVoiceError: () => void;
  setVoiceError: (e: string | null) => void;
  handleVoiceBeforeStart: () => boolean | Promise<boolean>;
  handleVoiceTranscript: (rawText: string) => void;
  setVoiceInterim: (text: string) => void;
  handleRetryMicPermission: () => void;
}

/** Interaction action handlers from useInteractionActions. */
export interface InteractionActionHandlers {
  handleSecretSubmit: (value: string, mode: "store" | "transient_send") => void;
  handleSecretCancel: () => void;
  handleContactPromptSubmit: (address: string, channelType: string) => Promise<void>;
  handleContactPromptCancel: () => void;
  handleConfirmationSubmit: (decision: ConfirmationDecision) => Promise<void>;
  handleAllowAndCreateRule: (() => void) | undefined;
  handleOpenRuleEditorForToolCall: (context: {
    toolName: string;
    riskLevel?: string;
    riskReason?: string;
    input?: Record<string, unknown>;
    allowlistOptions: AllowlistOption[];
    scopeOptions: ScopeOption[];
    directoryScopeOptions: DirectoryScopeOption[];
  }) => void;
  handleQuestionResponse: (responses: QuestionResponseEntry[]) => void;
  handleSurfaceAction: (surfaceId: string, action: string, input?: Record<string, unknown>) => Promise<void>;
  unknownNudgeToolCallIds: Set<string>;
  setUnknownNudgeToolCallIds: Dispatch<SetStateAction<Set<string>>>;
}

/** Send message handlers from useSendMessage. */
export interface SendMessageHandlers {
  sendMessage: (content: string, attachments?: DisplayAttachment[]) => Promise<void>;
  handleStopGenerating: () => Promise<void>;
  queuedMessages: DisplayMessage[];
  handleCancelQueuedMessage: (stableId: string) => void;
  handleCancelAllQueued: () => void;
  handleSteerMessage: (stableId: string) => void;
  handleEditQueueTail: () => void;
}

/** Attachment state/handlers from useChatAttachments. */
export interface AttachmentHandlers {
  chatAttachments: ChatAttachment[];
  attachmentsUploadingCount: number;
  attachmentUploadedIds: string[];
  attachmentLastError: string | null;
  addChatAttachmentFiles: (files: File[] | FileList) => void;
  removeChatAttachment: (id: string) => void;
  resetChatAttachments: () => void;
  dismissChatAttachmentError: () => void;
}

/** Disk pressure state from useDiskPressureMonitor. */
export interface DiskPressureState {
  status: DiskPressureStatusEventPayload;
  mode: string | null;
  diskPressureMonitorEnabled: boolean;
  hasResolvedDiskPressureStatus: boolean;
  isAcknowledgingDiskPressure: boolean;
  diskPressureAcknowledgeError: Error | null;
  acknowledgeDiskPressure: () => Promise<void>;
}

/** Avatar data from useAssistantAvatar. */
export interface AvatarData {
  avatarComponents: CharacterComponents | null;
  avatarTraits: CharacterTraits | null;
  avatarImageUrl: string | null;
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

export interface ChatRouteRefs {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  messagesRef: MutableRefObject<DisplayMessage[]>;
  activeConversationIdRef: MutableRefObject<string | null>;
  assistantIdRef: MutableRefObject<string | null>;
  streamContextRef: MutableRefObject<StreamContext | null>;
  expandedToolCallIdsRef: MutableRefObject<Set<string>>;
  dismissedSurfaceIdsRef: MutableRefObject<Set<string>>;
  contextWindowUsageByConversationRef: MutableRefObject<Map<string, ContextWindowUsage>>;
  streamRef: MutableRefObject<ChatEventStream | null>;
  streamEpochRef: MutableRefObject<number>;
  pendingQueuedStableIdsRef: MutableRefObject<string[]>;
  requestIdToStableIdRef: MutableRefObject<Map<string, string>>;
  pendingLocalDeletionsRef: MutableRefObject<Set<string>>;
  confirmationToolCallMapRef: MutableRefObject<Map<string, string>>;
  reconcileAfterNextStreamOpenRef: MutableRefObject<boolean>;
  /**
   * Imperative handle to the mounted `<Transcript />`. Owned by ChatPage
   * so `useChatDebugApi` (installed there) can read scroll geometry
   * directly via `transcriptRef.current.getScrollElement()`.
   */
  transcriptRef: RefObject<TranscriptHandle | null>;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ChatRouteContentProps {
  // Core
  assistantId: string | null;
  assistantState: AssistantState;
  assistantIdentity: AssistantIdentity | null;

  // Feature flags
  chatPullToRefreshEnabled: boolean;
  deployToVercel: boolean;
  doctor: boolean;

  // Platform
  isMobile: boolean;
  isKeyboardOpen: boolean;

  // Messages
  messages: DisplayMessage[];
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;

  // Input
  input: string;
  setInput: Dispatch<SetStateAction<string>>;

  // Error
  error: ChatError | null;
  setError: Dispatch<SetStateAction<ChatError | null>>;

  // Loading
  isLoadingHistory: boolean;



  // Conversation
  conversations: Conversation[];
  activeConversationId: string | null;
  activeConversation: Conversation | undefined;
  processingConversationIds: ReadonlySet<string>;

  // Viewer
  mainView: MainView;
  openedAppState: OpenedAppState | null;
  openedDocumentState: OpenedDocumentState | null;
  editingConversationId: string | null;

  // Draft
  restoredDraftConversationId: string | null;
  setRestoredDraftConversationId: Dispatch<SetStateAction<string | null>>;
  saveDraft: (key: string, text: string) => void;
  clearDraft: (key: string) => void;

  // Avatar
  avatar: AvatarData;

  // Context window
  contextWindowUsage: ContextWindowUsage | null;

  // Compaction
  compactionCircuitOpenUntil: Date | null;
  setCompactionCircuitOpenUntil: Dispatch<SetStateAction<Date | null>>;

  // Suggestion (ghost text)
  suggestion: string | null;
  setSuggestion: Dispatch<SetStateAction<string | null>>;

  // Pagination
  transcriptPagination: Omit<TranscriptPaginationState, "items">;
  setTranscriptPagination: Dispatch<SetStateAction<Omit<TranscriptPaginationState, "items">>>;

  // Credits modal
  setShowAddCreditsModal: Dispatch<SetStateAction<boolean>>;

  // Disk pressure
  diskPressure: DiskPressureState;
  handleReviewDiskUsage: () => void;

  // Nudges
  nudges: NudgeHandlers;

  // Attachments
  attachments: AttachmentHandlers;

  // Voice
  voice: VoiceInputHandlers;

  // Send message
  send: SendMessageHandlers;

  // Interaction actions
  interactionActions: InteractionActionHandlers;

  // App/document actions
  handleOpenApp: (appId: string) => void;
  handleOpenDocument: (documentSurfaceId: string) => void;
  handleCloseDocument: () => void;
  handleCloseApp: () => void;
  handleCloseEditPanel: () => void;
  handleEditApp: () => void;
  handleShareApp: () => void;
  handleDeployApp: (() => void) | undefined;

  // Conversation secondary actions
  handleForkConversation: (throughMessageId: string) => Promise<void>;
  handleInspectMessage?: (messageId: string) => void;

  // Subagent
  subagentEntries: SubagentEntry[];
  subagentState: SubagentState;
  activeSubagentId: string | null;
  onSubagentClick: (subagentId: string) => void;
  onCloseSubagentDetail: () => void;
  onStopSubagent: (subagentId: string) => void;
  onRequestSubagentDetail?: (subagentId: string) => void;

  // Navigation (for billing banner)
  pushToAiSettings: () => void;

  // Callbacks
  checkAssistant: () => void;
  setRefreshEpoch: Dispatch<SetStateAction<number>>;

  // TanStack Query pagination (from useHistoryPagination)
  historyPagination: HistoryPaginationResult;

  // Refs
  refs: ChatRouteRefs;

  // Is channel readonly (computed in parent, used in topbar + here)
  isChannelReadonly: boolean;

  // Onboarding (iOS post-hatch flow)
  onboardingTasksEmpty: boolean;
  didOnboarding: boolean;
  onboardingConversationId: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChatRouteContent({
  assistantId,
  assistantState,
  assistantIdentity,
  chatPullToRefreshEnabled,
  deployToVercel,
  doctor: doctorEnabled,
  isMobile,
  isKeyboardOpen,
  messages,
  setMessages: _setMessages,
  input,
  setInput,
  error,
  setError,
  isLoadingHistory,
  conversations: _conversations,
  activeConversationId,
  activeConversation,
  processingConversationIds,
  mainView,
  openedAppState,
  openedDocumentState,
  editingConversationId,
  restoredDraftConversationId,
  setRestoredDraftConversationId,
  saveDraft,
  clearDraft,
  avatar,
  contextWindowUsage,
  compactionCircuitOpenUntil,
  setCompactionCircuitOpenUntil,
  suggestion,
  setSuggestion,
  transcriptPagination,
  setTranscriptPagination: _setTranscriptPagination,
  setShowAddCreditsModal,
  diskPressure,
  handleReviewDiskUsage,
  nudges,
  attachments,
  voice,
  send,
  interactionActions,
  handleOpenApp,
  handleOpenDocument,
  handleCloseDocument,
  handleCloseApp,
  handleCloseEditPanel,
  handleEditApp,
  handleShareApp,
  handleDeployApp,
  handleForkConversation,
  handleInspectMessage,
  subagentEntries,
  subagentState,
  activeSubagentId,
  onSubagentClick,
  onCloseSubagentDetail,
  onStopSubagent,
  onRequestSubagentDetail,
  pushToAiSettings,
  checkAssistant,
  setRefreshEpoch,
  historyPagination,
  refs,
  isChannelReadonly,
  onboardingTasksEmpty,
  didOnboarding,
  onboardingConversationId,
}: ChatRouteContentProps) {
  const navigate = useNavigate();

  // Destructure grouped props
  const { avatarComponents, avatarTraits, avatarImageUrl } = avatar;
  const {
    chatAttachments,
    attachmentsUploadingCount,
    attachmentUploadedIds,
    attachmentLastError,
    addChatAttachmentFiles,
    removeChatAttachment,
    resetChatAttachments,
    dismissChatAttachmentError,
  } = attachments;
  const {
    voiceInputRef,
    voiceInterim,
    voiceError,
    clearVoiceError,
    setVoiceError: _setVoiceError,
    handleVoiceBeforeStart,
    handleVoiceTranscript,
    setVoiceInterim,
    handleRetryMicPermission,
  } = voice;
  const {
    sendMessage,
    handleStopGenerating,
    queuedMessages,
    handleCancelQueuedMessage,
    handleCancelAllQueued,
    handleSteerMessage,
    handleEditQueueTail,
  } = send;
  const {
    handleSecretSubmit,
    handleSecretCancel,
    handleContactPromptSubmit,
    handleContactPromptCancel,
    handleConfirmationSubmit,
    handleAllowAndCreateRule,
    handleOpenRuleEditorForToolCall,
    handleQuestionResponse,
    handleSurfaceAction,
    unknownNudgeToolCallIds,
    setUnknownNudgeToolCallIds,
  } = interactionActions;
  const {
    inputRef,
    messagesRef,
    activeConversationIdRef: _activeConversationIdRef,
    assistantIdRef: _assistantIdRef,
    streamContextRef,
    expandedToolCallIdsRef,
    dismissedSurfaceIdsRef: _dismissedSurfaceIdsRef,
    contextWindowUsageByConversationRef: _contextWindowUsageByConversationRef,
    streamRef: _streamRef,
    streamEpochRef: _streamEpochRef,
    pendingQueuedStableIdsRef: _pendingQueuedStableIdsRef,
    requestIdToStableIdRef: _requestIdToStableIdRef,
    pendingLocalDeletionsRef: _pendingLocalDeletionsRef,
    confirmationToolCallMapRef: _confirmationToolCallMapRef,

    reconcileAfterNextStreamOpenRef: _reconcileAfterNextStreamOpenRef,
  } = refs;

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
  // Derived values
  // -------------------------------------------------------------------------

  const hasUncompletedVisibleSurface = useMemo(() => {
    for (const msg of messages) {
      if (msg.surfaces) {
        for (const s of msg.surfaces) {
          if (isSurfaceInteractive(s)) return true;
        }
      }
    }
    return false;
  }, [messages]);

  const activeConversationIsProcessing =
    activeConversationId != null && processingConversationIds.has(activeConversationId);

  const activeConversationHasPendingAssistantResponse = useMemo(
    () => hasPendingAssistantResponse(messages),
    [messages],
  );

  const hasStreamingAssistantMessage = messages.some((m) => m.isStreaming);

  const uiContext: UIContext = {
    hasStreamingAssistantMessage,
    hasPendingSecret: !!pendingSecret,
    hasPendingConfirmation: !!pendingConfirmation,
    hasPendingQuestion: !!pendingQuestion,
    hasPendingContactRequest: !!pendingContactRequest,
    hasUncompletedVisibleSurface,
    activeConversationIsProcessing,
    hasPendingAssistantResponse: activeConversationHasPendingAssistantResponse,
  };

  const showThinking = shouldShowThinkingIndicator(turnState, uiContext);
  const isAssistantStreaming =
    showThinking || hasStreamingAssistantMessage;
  const canStopGenerating = canStopGeneration(turnState, uiContext);

  const diskPressureChatBlockReason = getDiskPressureChatBlockReason({
    monitorEnabled: diskPressure.diskPressureMonitorEnabled,
    hasResolvedStatus: diskPressure.hasResolvedDiskPressureStatus,
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
  const activeModelSupportsVision = activeProfileModel
    ? (activeProfileModel.supportsVision ??
      modelSupportsVision(activeProfileModel.provider, activeProfileModel.model))
    : true;

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
    messagesRef,
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

  // Defensive ascending-timestamp sort at the render boundary. The internal
  // mutators (`setMessages` in stream handlers, `reconcile`, etc.) try to
  // keep the array sorted, but a handful of paths can land rows out of
  // order — multi-row server clusters with the same `daemonMessageId`, a
  // late tool-result event for an earlier bubble, history pages stitched
  // around an in-flight stream, etc. Sorting here guarantees the user
  // always sees messages in chronological order, regardless of which write
  // path landed last. The deeper fix (server-side cluster merging so the
  // client never sees the fragmented rows) is tracked separately.
  //
  // `sortedByTimestamp` is stable: rows without a `timestamp` keep their
  // original slot, and equal timestamps preserve insertion order, so
  // streaming bubbles don't flicker.
  const sortedMessages = useMemo(() => sortedByTimestamp(messages), [messages]);

  const transcriptItems = useMemo(
    () =>
      buildTranscriptItems({
        messages: sortedMessages,
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
      sortedMessages,
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

  // -------------------------------------------------------------------------
  // Scroll coordination
  // -------------------------------------------------------------------------

  const scrollCoordinator = useTranscriptScroll({
    transcriptRef: refs.transcriptRef,
    items: transcriptItems,
    conversationId: activeConversationId,
    hasMore: transcriptPagination.hasMore,
    isLoadingOlder: transcriptPagination.isLoadingOlder,
    onLoadOlder: loadOlder,
  });

  useEffect(() => {
    const el = refs.transcriptRef.current?.getScrollElement();
    if (!el) return;
    const handler = (e: Event) => scrollCoordinator.handleScroll(e);
    el.addEventListener("scroll", handler, { passive: true });
    return () => {
      el.removeEventListener("scroll", handler);
    };
  }, [scrollCoordinator, activeConversationId, transcriptItems, refs.transcriptRef]);

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
    setSuggestion(null);
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
    await sendMessage(trimmed, attachmentsToSend);
  }, [input, sendDisabled, attachmentUploadedIds.length, attachmentsUploadingCount, activeConversationId, chatAttachments, resetChatAttachments, sendMessage, setInput, setSuggestion, clearDraft, inputRef, scrollCoordinator]);

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
    const ctx = streamContextRef.current;
    if (!ctx) return;
    submitQuestionResponse(ctx.assistantId, snapshot.requestId, {
      kind: "close",
    })
      .then((result) => {
        if (!result.ok) {
          Sentry.captureException(
            new Error(`question-response close failed: ${result.error}`),
            {
              tags: { context: "submit_question_response_close" },
              extra: { status: result.status },
            },
          );
        }
      })
      .catch((err) => {
        Sentry.captureException(err, {
          tags: { context: "submit_question_response_close" },
        });
      });
  }, [streamContextRef]);

  // -------------------------------------------------------------------------
  // Empty state placeholder (stable per mount)
  // -------------------------------------------------------------------------

  const emptyStatePlaceholder = useMemo(() => pickRandomPlaceholder(), []);

  const emptyStateGreeting = useEmptyStateGreeting(assistantId);

  // -------------------------------------------------------------------------
  // Disk pressure banner
  // -------------------------------------------------------------------------

  const renderDiskPressureBanner = useCallback((): ReactNode => {
    if (!diskPressure.status) return null;
    const mode = diskPressure.mode === "inactive" ? null : (diskPressure.mode as DiskPressureBannerMode | null);
    if (!mode) return null;
    return (
      <DiskPressureBanner
        status={diskPressure.status}
        mode={mode}
        isAcknowledging={diskPressure.isAcknowledgingDiskPressure}
        acknowledgeError={diskPressure.diskPressureAcknowledgeError?.message ?? null}
        onAcknowledge={() => void diskPressure.acknowledgeDiskPressure()}
        onReviewDiskUsage={handleReviewDiskUsage}
      />
    );
  }, [diskPressure, handleReviewDiskUsage]);

  // -------------------------------------------------------------------------
  // Billing composer banner
  // -------------------------------------------------------------------------

  const renderBillingComposerBanner = (): ReactNode => {
    const decision = getChatBillingBannerDecision(error);
    if (decision === "managed_credits") {
      return (
        <div className="mb-2">
          <CreditsExhaustedBanner
            onAddFunds={() => setShowAddCreditsModal(true)}
          />
        </div>
      );
    }
    if (decision === "provider_billing") {
      return (
        <div className="mb-2">
          <ProviderBillingBanner
            onOpenSettings={pushToAiSettings}
          />
        </div>
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

  const chatTranscriptProps: TranscriptProps = {
    items: transcriptItems,
    assistantDisplayName: assistantIdentity?.name?.trim() || undefined,
    expandedToolCallIds: expandedToolCallIdsRef.current,
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
    renderAvatar:
      avatarComponents || avatarImageUrl
        ? () => (
            <ChatAvatar
              components={avatarComponents}
              traits={avatarTraits}
              customImageUrl={avatarImageUrl}
              size={56}
              interactive
              isStreaming={isAssistantStreaming}
            />
          )
        : undefined,
    onPullRefresh: handlePullRefresh,
    pullRefreshEnabled: chatPullToRefreshEnabled && touchSupported,
    scrollCoordinatorState: {
      isPinnedToLatest: scrollCoordinator.isPinnedToLatest,
      showScrollToLatest: scrollCoordinator.showScrollToLatest,
      shouldLoadOlder: false, // Not exposed by scroll coordinator; safe default
    },
    subagentEntries,
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
    onVoiceError: _setVoiceError,
    onVoiceBeforeStart: handleVoiceBeforeStart,
    onStopGenerating: handleStopGenerating,
    assistantId,
    modelSupportsVision: activeModelSupportsVision,
    textareaMaxHeightPx: isEmptyConversation ? 320 : undefined,
    thresholdPickerSlot: assistantId ? (
      <ComposerSettingsMenu
        assistantId={assistantId}
        conversationId={activeConversation?.conversationId}
      />
    ) : undefined,
    contextWindowIndicatorSlot: (
      <ContextWindowIndicator usage={contextWindowUsage} />
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
  };

  const chatBodyScrollAreaPropsBase = {
    isLoadingHistory,
    messageCount: messages.length,
    showEmptyState: isEmptyConversation,
    emptyStateProps: chatEmptyStateProps,
    transcriptRef: refs.transcriptRef,
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

  const channelFooterSlot = (
    <SlackChannelFooter
      assistantId={assistantId ?? undefined}
      conversation={activeConversation}
      messages={sortedMessages}
    />
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (mainView === "app-editing" && openedAppState && editingConversationId) {
    return (
      <ResizablePanel
        storageKey="appEditPanelWidth"
        defaultLeftWidth={400}
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
            isKeyboardOpen={isKeyboardOpen}
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
            channelFooterSlot={channelFooterSlot}
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
      isKeyboardOpen={isKeyboardOpen}
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
      channelFooterSlot={channelFooterSlot}
      startersSlot={startersSlot}
    />
  );

  if (mainView === "document" && !isMobile && openedDocumentState && assistantId) {
    return (
      <>
        <ResizablePanel
          storageKey="documentPanelWidth"
          defaultLeftWidth={400}
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
      </>
    );
  }

  if (mainView === "subagent-detail" && activeSubagentId && !isMobile) {
    const activeEntry = subagentState.byId[activeSubagentId];
    if (activeEntry) {
      return (
        <>
          <ResizablePanel
            storageKey="subagentDetailPanelWidth"
            defaultLeftWidth={400}
            minLeftWidth={300}
            minRightWidth={400}
            left={chatContent}
            right={
              <SubagentDetailPanel
                entry={activeEntry}
                onClose={onCloseSubagentDetail}
                onStop={onStopSubagent}
                onRequestDetail={onRequestSubagentDetail}
              />
            }
          />
          {sendErrorModalNode}
        </>
      );
    }
  }

  return (
    <>
      {chatContent}
      {sendErrorModalNode}
    </>
  );
}
