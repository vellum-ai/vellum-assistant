import {
  type MutableRefObject,
  type RefObject,
  useCallback,
  useReducer,
  useRef,
  useState,
} from "react";

import { useIsMobile } from "@/hooks/use-is-mobile.js";
import { useAuth } from "@/lib/auth/auth-provider.js";
import { useAssistantLifecycle } from "@/domains/chat/hooks/use-assistant-lifecycle.js";
import {
  interactionReducer,
  INITIAL_INTERACTION_STATE,
} from "@/domains/chat/lib/interaction-state-machine.js";
import {
  turnReducer,
  INITIAL_TURN_STATE,
} from "@/domains/chat/lib/turn-state-machine.js";
import type { DisplayMessage } from "@/domains/chat/lib/reconcile.js";
import { ChatProvider } from "@/domains/chat/chat-context.js";
import {
  ChatRouteContent,
  type ChatRouteContentProps,
} from "@/domains/chat/components/chat-route-content.js";

// TODO: port remaining state setup from platform AssistantPageClient.tsx
// The full wiring requires: event stream, conversation loader, send message,
// voice input, attachments, command palette, nudges, subagent state, etc.
// Each of these uses hooks already ported to domains/chat/hooks/.

const EMPTY_SET = new Set<string>();
const EMPTY_MAP_MESSAGES = new Map<
  string,
  { messages: DisplayMessage[]; pagination: { hasMore: boolean; oldestTimestamp: number | null } }
>();
const EMPTY_SET_STRINGS = new Set<string>();

export function ChatPage() {
  const { isLoggedIn, isLoading: authLoading } = useAuth();
  const isMobile = useIsMobile();

  const navigate = useCallback((_path: string) => {}, []);

  const lifecycle = useAssistantLifecycle({
    isLoggedIn,
    isLoading: authLoading,
    isRetired: false,
    isNonProduction: false,
    onRedirect: navigate,
  });

  const { assistantState, assistantId } = lifecycle;

  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [turnState, dispatchTurn] = useReducer(turnReducer, INITIAL_TURN_STATE);
  const [interactionState, dispatchInteraction] = useReducer(
    interactionReducer,
    INITIAL_INTERACTION_STATE,
  );
  const [input, setInput] = useState("");
  const [error, setError] = useState<{ message: string } | null>(null);
  const [compactionCircuitOpenUntil, setCompactionCircuitOpenUntil] =
    useState<Date | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [_showAddCreditsModal, setShowAddCreditsModal] = useState(false);
  const [restoredDraftConversationKey, setRestoredDraftConversationKey] =
    useState<string | null>(null);
  const [_refreshEpoch, setRefreshEpoch] = useState(0);

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const activeConversationKeyRef = useRef<string | null>(null);
  const assistantIdRef = useRef<string | null>(assistantId);
  assistantIdRef.current = assistantId;
  const streamContextRef = useRef(null);
  const expandedToolCallIdsRef = useRef(EMPTY_SET_STRINGS);
  const draftsRef = useRef(new Map<string, string>());
  const conversationCacheRef = useRef(EMPTY_MAP_MESSAGES);
  const dismissedSurfaceIdsRef = useRef(EMPTY_SET_STRINGS);
  const isLoadingOlderRef = useRef(false);

  const sendMessage = useCallback(
    async (_content: string) => {
      // TODO: wire up useSendMessage hook
    },
    [],
  );

  if (authLoading || assistantState.kind === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[var(--text-secondary)]">Connecting…</p>
      </div>
    );
  }

  if (assistantState.kind === "error") {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <p className="text-[var(--text-secondary)]">{assistantState.message}</p>
      </div>
    );
  }

  const noopVoid = () => {};
  const noopAsync = async () => {};

  const chatRouteProps: ChatRouteContentProps = {
    assistantId,
    assistantState,
    assistantIdentity: null,
    chatPullToRefresh: false,
    deployToVercel: false,
    doctor: false,
    isMobile,
    isKeyboardOpen: false,
    messages,
    setMessages,
    turnState,
    dispatchTurn,
    input,
    setInput,
    error,
    setError,
    isLoadingHistory: false,
    interactionState,
    dispatchInteraction,
    conversations: [],
    activeConversationKey: null,
    activeConversation: undefined,
    processingKeys: EMPTY_SET,
    mainView: "chat",
    viewerState: { mainView: "chat", activeAppId: null, openedAppState: null, openedDocumentState: null, isAppMinimized: false, intelligenceTab: "skills", assetsRefreshKey: 0, viewBeforeDocument: "chat", activeSubagentId: null, viewBeforeSubagentDetail: "chat" } as ChatRouteContentProps["viewerState"],
    openedAppState: null,
    openedDocumentState: null,
    editingConversationKey: null,
    restoredDraftConversationKey,
    setRestoredDraftConversationKey,
    avatar: { avatarComponents: null, avatarTraits: null, avatarImageUrl: null },
    conversationStarters: [],
    contextWindowUsage: null,
    compactionCircuitOpenUntil,
    setCompactionCircuitOpenUntil,
    suggestion,
    setSuggestion,
    transcriptPagination: { hasMore: false, oldestTimestamp: null, isLoadingOlder: false, isPinnedToLatest: true },
    setTranscriptPagination: noopVoid as ChatRouteContentProps["setTranscriptPagination"],
    setShowAddCreditsModal,
    diskPressure: {
      status: null,
      mode: null,
      diskPressureMonitorEnabled: false,
      hasResolvedDiskPressureStatus: false,
      isAcknowledgingDiskPressure: false,
      diskPressureAcknowledgeError: null,
      acknowledgeDiskPressure: noopAsync,
    },
    handleReviewDiskUsage: noopVoid,
    nudges: {
      isOnIOS: false,
      showBanner: false,
      nudge: { handleDownload: noopVoid, handleBannerDismiss: noopVoid },
      githubNudge: { handleStar: noopVoid, handleBannerDismiss: noopVoid },
      showGitHubBanner: false,
      discordNudge: { handleJoin: noopVoid, handleBannerDismiss: noopVoid },
      showDiscordBanner: false,
    },
    attachments: {
      chatAttachments: [],
      attachmentsUploadingCount: 0,
      attachmentUploadedIds: [],
      attachmentLastError: null,
      addChatAttachmentFiles: noopVoid as ChatRouteContentProps["attachments"]["addChatAttachmentFiles"],
      removeChatAttachment: noopVoid,
      resetChatAttachments: noopVoid,
      dismissChatAttachmentError: noopVoid,
    },
    voice: {
      voiceInputRef: { current: null } as RefObject<null>,
      voiceInterim: null,
      voiceError: null,
      clearVoiceError: noopVoid,
      setVoiceError: noopVoid,
      handleVoiceBeforeStart: () => false,
      handleVoiceTranscript: noopVoid,
      handleVoiceRecordingChange: noopVoid as ChatRouteContentProps["voice"]["handleVoiceRecordingChange"],
      setVoiceInterim: noopVoid,
      handleRetryMicPermission: noopVoid,
    },
    send: {
      sendMessage,
      handleStopGenerating: noopAsync,
      queuedMessages: [],
      handleCancelQueuedMessage: noopVoid,
      handleCancelAllQueued: noopVoid,
      handleEditQueueTail: noopVoid,
    },
    interactionActions: {
      handleSecretSubmit: noopVoid as ChatRouteContentProps["interactionActions"]["handleSecretSubmit"],
      handleSecretCancel: noopVoid,
      handleContactPromptSubmit: noopAsync as ChatRouteContentProps["interactionActions"]["handleContactPromptSubmit"],
      handleContactPromptCancel: noopVoid,
      handleConfirmationSubmit: noopAsync as ChatRouteContentProps["interactionActions"]["handleConfirmationSubmit"],
      handleAllowAndCreateRule: undefined,
      handleOpenRuleEditorForToolCall: noopVoid as ChatRouteContentProps["interactionActions"]["handleOpenRuleEditorForToolCall"],
      handleQuestionResponse: noopAsync as ChatRouteContentProps["interactionActions"]["handleQuestionResponse"],
      handleSurfaceAction: noopAsync as ChatRouteContentProps["interactionActions"]["handleSurfaceAction"],
      unknownNudgeToolCallIds: EMPTY_SET,
      setUnknownNudgeToolCallIds: noopVoid as ChatRouteContentProps["interactionActions"]["setUnknownNudgeToolCallIds"],
    },
    handleOpenApp: noopVoid,
    handleOpenDocument: noopVoid,
    handleCloseDocument: noopVoid,
    handleCloseApp: noopVoid,
    handleCloseEditPanel: noopVoid,
    handleShareApp: noopVoid,
    handleDeployApp: noopVoid,
    handleForkConversation: noopAsync as ChatRouteContentProps["handleForkConversation"],
    subagentEntries: [],
    subagentState: { byId: new Map(), orderedIds: [], entries: [] } as unknown as ChatRouteContentProps["subagentState"],
    activeSubagentId: null,
    onSubagentClick: noopVoid,
    onCloseSubagentDetail: noopVoid,
    onStopSubagent: noopVoid,
    onRequestSubagentDetail: noopAsync as ChatRouteContentProps["onRequestSubagentDetail"],
    pushToAiSettings: noopVoid,
    checkAssistant: noopVoid,
    setRefreshEpoch,
    streamRetryNonce: 0,
    refs: {
      inputRef,
      messagesRef,
      activeConversationKeyRef,
      assistantIdRef,
      streamContextRef,
      expandedToolCallIdsRef: expandedToolCallIdsRef as MutableRefObject<Set<string>>,
      draftsRef,
      conversationCacheRef: conversationCacheRef as MutableRefObject<
        Map<string, { messages: DisplayMessage[]; pagination: { hasMore: boolean; oldestTimestamp: number | null } }>
      >,
      dismissedSurfaceIdsRef: dismissedSurfaceIdsRef as MutableRefObject<Set<string>>,
      isLoadingOlderRef,
      initialPageOldestTsRef: { current: null },
      contextWindowUsageByConversationRef: { current: new Map() },
      refreshSettleRef: { current: null },
      streamRef: { current: null },
      reconcileActiveConversationRef: { current: noopAsync },
      voiceCursorPosRef: { current: null },
      syncRouterRef: { current: null },
      lastStreamDisconnectRef: { current: null },
      lastStreamReconnectRef: { current: null },
      conversationsRef: { current: [] },
      lastWatchdogKickRef: { current: null },
      applyDiskPressureStatusEventRef: { current: noopVoid },
      refreshAssistantIdentityRef: { current: noopAsync },
      turnsInFlightRef: { current: 0 },
    } as unknown as ChatRouteContentProps["refs"],
    isChannelReadonly: false,
  };

  return (
    <ChatProvider
      messages={messages}
      activeConversationKey={null}
      assistantId={assistantId}
      sendMessage={sendMessage}
      dispatchTurn={dispatchTurn}
      dispatchInteraction={dispatchInteraction}
    >
      <ChatRouteContent {...chatRouteProps} />
    </ChatProvider>
  );
}
