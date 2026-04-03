import Combine
import Foundation
import Network
import Observation
import os
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
import AVFoundation
#elseif os(iOS)
import UIKit
#else
#error("Unsupported platform")
#endif

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ChatViewModel")

// MARK: - Conversation Starter Types

public struct ConversationStarter: Identifiable, Codable {
    public let id: String
    public let label: String
    public let prompt: String
    public let category: String?
    public let batch: Int?

    public init(id: String, label: String, prompt: String, category: String?, batch: Int? = nil) {
        self.id = id
        self.label = label
        self.prompt = prompt
        self.category = category
        self.batch = batch
    }
}

struct ConversationStartersResponse: Codable {
    let starters: [ConversationStarter]
    let total: Int
    let status: String  // "ready", "generating", "empty"
}

@MainActor
protocol ConversationStarterClientProtocol {
    func fetchConversationStarters(limit: Int) async -> ConversationStartersResponse?
}

@MainActor
struct ConversationStarterClient: ConversationStarterClientProtocol {
    nonisolated init() {}

    func fetchConversationStarters(limit: Int) async -> ConversationStartersResponse? {
        guard let response = try? await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/conversation-starters",
            params: ["limit": String(limit)]
        ), response.isSuccess else { return nil }
        return try? JSONDecoder().decode(ConversationStartersResponse.self, from: response.data)
    }
}

/// Raw surface content from the daemon, preserving the untyped data dict
/// so callers can construct a `UiSurfaceShowMessage` without lossy roundtrips.
public struct SurfaceContentResponse: @unchecked Sendable {
    public let surfaceType: String
    public let title: String?
    public let rawData: [String: Any]

    // Sendable conformance — rawData is JSON-derived (all plist types).
    nonisolated public init(surfaceType: String, title: String?, rawData: [String: Any]) {
        self.surfaceType = surfaceType
        self.title = title
        self.rawData = rawData
    }
}

@MainActor
public protocol SurfaceClientProtocol {
    func fetchSurfaceData(surfaceId: String, conversationId: String) async -> SurfaceData?
    func fetchSurfaceContent(surfaceId: String, conversationId: String) async -> SurfaceContentResponse?
}

@MainActor
public struct SurfaceClient: SurfaceClientProtocol {
    nonisolated public init() {}

    public func fetchSurfaceData(surfaceId: String, conversationId: String) async -> SurfaceData? {
        let response = try? await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/surfaces/\(surfaceId)", params: ["conversationId": conversationId], timeout: 10
        )
        if let statusCode = response?.statusCode, !(200..<300).contains(statusCode) {
            log.error("Fetch surface \(surfaceId) failed (HTTP \(statusCode))")
            return nil
        }
        guard let data = response?.data else { return nil }
        return Surface.parseSurfaceDataFromResponse(data)
    }

    /// Fetch surface content returning the raw response dict, suitable for
    /// reconstructing a `UiSurfaceShowMessage` to re-open ephemeral surfaces.
    public func fetchSurfaceContent(surfaceId: String, conversationId: String) async -> SurfaceContentResponse? {
        let response = try? await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/surfaces/\(surfaceId)", params: ["conversationId": conversationId], timeout: 10
        )
        if let statusCode = response?.statusCode, !(200..<300).contains(statusCode) {
            log.error("Fetch surface content \(surfaceId) failed (HTTP \(statusCode))")
            return nil
        }
        guard let data = response?.data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return SurfaceContentResponse(
            surfaceType: json["surfaceType"] as? String ?? "",
            title: json["title"] as? String,
            rawData: json["data"] as? [String: Any] ?? [:]
        )
    }
}

/// Facade that owns the three focused sub-managers and forwards all property
/// accesses to them via computed properties.  Existing call sites require no
/// changes because the public API surface is identical to the previous monolith.
@Observable
@MainActor
public final class ChatViewModel: MessageSendCoordinatorDelegate {

    // MARK: - Sub-managers

    /// Owns message-list and send-state properties.
    public let messageManager = ChatMessageManager()
    /// Owns the pending-attachment list and image-processing helpers.
    public let attachmentManager = ChatAttachmentManager()
    /// Owns errorText, conversationError, and connection-diagnostic properties.
    public let errorManager = ChatErrorManager()
    /// Owns displayedMessages, pagination window, and load-more logic.
    public let paginationState: ChatPaginationState
    /// Owns send/cancel/queue logic.
    @ObservationIgnored private(set) var sendCoordinator: MessageSendCoordinator!
    /// Owns empty-state greeting and conversation starter properties.
    public let greetingState = ChatGreetingState()
    /// Owns server message dispatch (handleServerMessage switch).
    @ObservationIgnored private(set) var actionHandler: ChatActionHandler!

    @ObservationIgnored private var cancellables: Set<AnyCancellable> = []

    /// DispatchSource for system memory pressure events. Triggers an aggressive
    /// message trim on .warning and .critical events to reclaim memory quickly.
    @ObservationIgnored private var memoryPressureSource: DispatchSourceMemoryPressure?

    /// Watchdog task that fires when `isSending` has been `true` for more than
    /// 60 seconds without being reset.  Helps diagnose app freezes where the
    /// send-in-progress indicator gets stuck.
    @ObservationIgnored private var sendingWatchdogTask: Task<Void, Never>?

    /// Per-requestId safety-net timeouts that clear the submitting spinner if
    /// a guardian decision HTTP response takes longer than 15 seconds.  Keyed
    /// by requestId so concurrent submissions each get an independent timeout.
    @ObservationIgnored private var guardianDecisionTimeoutTasks: [String: Task<Void, Never>] = [:]

    // MARK: - Observation compatibility

    /// No-op — retained for protocol conformance (MessageSendCoordinatorDelegate).
    /// With @Observable, property-level tracking handles TextField binding
    /// updates immediately without coalesced publish machinery.
    func flushCoalescedPublish() {
        // No-op: @Observable tracks property access directly at the view level,
        // so TextField bindings update immediately when inputText changes.
    }

    private static let stallLog = OSLog(subsystem: "com.vellum.assistant", category: "LayoutStall")
    private static let poiLog = OSLog(subsystem: "com.vellum.assistant", category: .pointsOfInterest)



    // MARK: - Forwarding properties — ChatMessageManager

    public var messages: [ChatMessage] {
        get { messageManager.messages }
        set { messageManager.messages = newValue }
    }
    public var inputText: String {
        get { messageManager.inputText }
        set { messageManager.inputText = newValue }
    }
    public var isThinking: Bool {
        get { messageManager.isThinking }
        set { messageManager.isThinking = newValue }
    }
    /// Whether the assistant is actively working on a response — covers sending,
    /// extended-thinking, any in-progress assistant message, and orphaned tool
    /// calls that haven't received their `tool_result` event yet (e.g. tool
    /// calls created during skill/app execution whose results are folded into
    /// the parent tool's result rather than emitted individually).
    ///
    /// Use this for UI elements (stop button, placeholder text, paperclip hide)
    /// instead of `isSending` alone, because:
    /// 1. The "thinking" activity phase sets `isSending = false` to prevent
    ///    the 60s watchdog from firing.
    /// 2. `messageComplete` clears both `isSending` and `currentAssistantMessageId`
    ///    simultaneously, but tool call chips may still be visually running.
    public var isAssistantBusy: Bool {
        isSending || isThinking || currentAssistantMessageId != nil || hasIncompleteToolCalls
    }

    /// Whether the most recent assistant message has any tool calls that
    /// haven't been marked complete yet. This catches the case where
    /// `messageComplete` fires (clearing `isSending` and `currentAssistantMessageId`)
    /// but tool call chips are still visually running in the UI.
    var hasIncompleteToolCalls: Bool {
        guard let lastAssistant = messages.last(where: { $0.role == .assistant }) else {
            return false
        }
        return lastAssistant.toolCalls.contains(where: { !$0.isComplete })
    }

    public var isSending: Bool {
        get { messageManager.isSending }
        set {
            messageManager.isSending = newValue
            if newValue {
                // Start watchdog: if isSending is still true after 60s, auto-recover
                // by resetting transient state so the user can send new messages.
                // Without this, a missed messageComplete (e.g. server-side error with
                // the SSE stream still alive) leaves the chat permanently stuck.
                sendingWatchdogTask?.cancel()
                sendingWatchdogTask = Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .seconds(60))
                    guard !Task.isCancelled, let self, self.isSending else { return }
                    log.error("isSending watchdog: still true after 60s — auto-recovering, conversationId=\(self.conversationId ?? "nil")")
                    // Reset all transient state to match the reconnect recovery
                    // path, so the chat is fully usable again.
                    self.isThinking = false
                    self.isCancelling = false
                    // Workspace refinement state
                    self.isWorkspaceRefinementInFlight = false
                    self.refinementFlushTask?.cancel()
                    self.refinementFlushTask = nil
                    self.refinementMessagePreview = nil
                    self.refinementStreamingText = nil
                    self.cancelledDuringRefinement = false
                    self.refinementTextBuffer = ""
                    self.refinementReceivedSurfaceUpdate = false
                    // Activity phase state — keep lastActivityVersion at its
                    // current value so late activity events from the abandoned
                    // run with a lower version are rejected.
                    self.assistantActivityPhase = "idle"
                    self.assistantActivityAnchor = "global"
                    self.assistantActivityReason = nil
                    self.assistantStatusText = nil
                    self.isCompacting = false
                    self.contextWindowTokens = nil
                    self.contextWindowMaxTokens = nil
                    // Streaming message state
                    if let existingId = self.currentAssistantMessageId,
                       let index = self.messages.firstIndex(where: { $0.id == existingId }) {
                        self.messages[index].isStreaming = false
                        self.messages[index].streamingCodePreview = nil
                        self.messages[index].streamingCodeToolName = nil
                        for j in self.messages[index].toolCalls.indices where !self.messages[index].toolCalls[j].isComplete {
                            self.messages[index].toolCalls[j].isComplete = true
                            self.messages[index].toolCalls[j].completedAt = Date()
                        }
                    }
                    self.currentAssistantMessageId = nil
                    self.currentTurnUserText = nil
                    self.currentAssistantHasText = false
                    self.discardStreamingBuffer()
                    self.discardPartialOutputBuffer()
                    // Voice state
                    self.pendingVoiceMessage = false
                    // Bootstrap state — if the first message triggered the watchdog
                    // before a conversationId was assigned, clear these so the next
                    // sendMessage() doesn't take the isBootstrapping early-return path.
                    self.bootstrapCorrelationId = nil
                    self.pendingUserMessage = nil
                    self.pendingUserMessageDisplayText = nil
                    self.pendingUserAttachments = nil
                    self.pendingUserMessageAutomated = false
                    // Queue tracking state
                    self.pendingQueuedCount = 0
                    self.pendingMessageIds.removeAll()
                    self.requestIdToMessageId.removeAll()
                    self.activeRequestIdToMessageId.removeAll()
                    self.pendingLocalDeletions.removeAll()
                    // Reset queued/processing user messages to .sent
                    for i in self.messages.indices {
                        if case .queued = self.messages[i].status, self.messages[i].role == .user {
                            self.messages[i].status = .sent
                        } else if self.messages[i].role == .user && self.messages[i].status == .processing {
                            self.messages[i].status = .sent
                        }
                    }
                    // Cancel stale cancel-timeout task
                    self.cancelTimeoutTask?.cancel()
                    self.cancelTimeoutTask = nil
                    // Setting isSending = false triggers the setter again which
                    // cancels this watchdog task — use the backing store directly.
                    self.messageManager.isSending = false
                    self.sendingWatchdogTask = nil
                    // Dispatch any pending send-direct so the user's message isn't lost.
                    self.dispatchPendingSendDirect()
                }
            } else {
                sendingWatchdogTask?.cancel()
                sendingWatchdogTask = nil
            }
        }
    }
    public var assistantActivityPhase: String {
        get { messageManager.assistantActivityPhase }
        set { messageManager.assistantActivityPhase = newValue }
    }
    public var assistantActivityAnchor: String {
        get { messageManager.assistantActivityAnchor }
        set { messageManager.assistantActivityAnchor = newValue }
    }
    public var assistantActivityReason: String? {
        get { messageManager.assistantActivityReason }
        set { messageManager.assistantActivityReason = newValue }
    }
    public var assistantStatusText: String? {
        get { messageManager.assistantStatusText }
        set { messageManager.assistantStatusText = newValue }
    }
    public var isCompacting: Bool {
        get { messageManager.isCompacting }
        set { messageManager.isCompacting = newValue }
    }
    public var contextWindowTokens: Int? {
        get { messageManager.contextWindowTokens }
        set { messageManager.contextWindowTokens = newValue }
    }
    public var contextWindowMaxTokens: Int? {
        get { messageManager.contextWindowMaxTokens }
        set { messageManager.contextWindowMaxTokens = newValue }
    }
    public var contextWindowFillRatio: Double? {
        guard let tokens = contextWindowTokens,
              let max = contextWindowMaxTokens,
              max > 0 else { return nil }
        return min(Double(tokens) / Double(max), 1.0)
    }
    public var activePendingRequestId: String? {
        messageManager.activePendingRequestId
    }
    /// Whether any message contains non-empty text. O(1) cached value kept in
    /// sync with the message array by ChatMessageManager's Combine pipeline.
    public var hasNonEmptyMessage: Bool {
        messageManager.hasNonEmptyMessage
    }
    /// The daemon message ID of the last persisted, non-streaming, non-hidden
    /// message. O(1) cached value kept in sync with the message array by
    /// ChatMessageManager's Combine pipeline.
    public var latestPersistedTipDaemonMessageId: String? {
        messageManager.latestPersistedTipDaemonMessageId
    }
    public var hasPendingConfirmation: Bool {
        messages.contains(where: { $0.confirmation?.state == .pending })
    }
    public var pendingQueuedCount: Int {
        get { messageManager.pendingQueuedCount }
        set { messageManager.pendingQueuedCount = newValue }
    }
    public var suggestion: String? {
        get { messageManager.suggestion }
        set { messageManager.suggestion = newValue }
    }
    public var isRecording: Bool {
        get { messageManager.isRecording }
        set { messageManager.isRecording = newValue }
    }
    public var recordingAmplitude: Float {
        get { messageManager.recordingAmplitude }
        set { messageManager.recordingAmplitude = newValue }
    }
    public var isWorkspaceRefinementInFlight: Bool {
        get { messageManager.isWorkspaceRefinementInFlight }
        set { messageManager.isWorkspaceRefinementInFlight = newValue }
    }
    /// The user's sent text shown while a refinement is in progress.
    public var refinementMessagePreview: String? {
        get { messageManager.refinementMessagePreview }
        set { messageManager.refinementMessagePreview = newValue }
    }
    /// The AI response as it streams during a refinement.
    public var refinementStreamingText: String? {
        get { messageManager.refinementStreamingText }
        set { messageManager.refinementStreamingText = newValue }
    }
    /// Tracks whether a cancel was initiated during a workspace refinement.
    /// Used by `messageComplete` to correctly suppress refinement side-effects
    /// even though `isWorkspaceRefinementInFlight` is cleared immediately for UI.
    var cancelledDuringRefinement: Bool {
        get { messageManager.cancelledDuringRefinement }
        set { messageManager.cancelledDuringRefinement = newValue }
    }
    /// Text buffered during a workspace refinement (normally suppressed from chat).
    /// Surfaced to the user if the refinement completes without a surface update.
    var refinementTextBuffer: String {
        get { messageManager.refinementTextBuffer }
        set { messageManager.refinementTextBuffer = newValue }
    }
    var refinementReceivedSurfaceUpdate: Bool {
        get { messageManager.refinementReceivedSurfaceUpdate }
        set { messageManager.refinementReceivedSurfaceUpdate = newValue }
    }
    /// When non-nil, displays a toast in the workspace with the AI's response
    /// after a refinement that produced no surface update.
    public var refinementFailureText: String? {
        get { messageManager.refinementFailureText }
        set { messageManager.refinementFailureText = newValue }
    }
    var refinementFailureDismissTask: Task<Void, Never>? {
        get { messageManager.refinementFailureDismissTask }
        set { messageManager.refinementFailureDismissTask = newValue }
    }
    var refinementFlushTask: Task<Void, Never>? {
        get { messageManager.refinementFlushTask }
        set { messageManager.refinementFlushTask = newValue }
    }
    /// Number of undo steps available for the active workspace surface.
    public var surfaceUndoCount: Int {
        get { messageManager.surfaceUndoCount }
        set { messageManager.surfaceUndoCount = newValue }
    }
    public var pendingSkillInvocation: SkillInvocationData? {
        get { messageManager.pendingSkillInvocation }
        set { messageManager.pendingSkillInvocation = newValue }
    }
    public var isWatchSessionActive: Bool {
        get { messageManager.isWatchSessionActive }
        set { messageManager.isWatchSessionActive = newValue }
    }
    public var activeSubagents: [SubagentInfo] {
        get { messageManager.activeSubagents }
        set { messageManager.activeSubagents = newValue }
    }
    /// Widget IDs dismissed by the user, persisted across view recreation.
    public var dismissedDocumentSurfaceIds: Set<String> {
        get { messageManager.dismissedDocumentSurfaceIds }
        set { messageManager.dismissedDocumentSurfaceIds = newValue }
    }
    /// The currently active model ID, updated via `model_info` messages.
    public var selectedModel: String {
        get { messageManager.selectedModel }
        set { messageManager.selectedModel = newValue }
    }
    /// Set of provider keys with configured API keys, updated via `model_info` messages.
    public var configuredProviders: Set<String> {
        get { messageManager.configuredProviders }
        set { messageManager.configuredProviders = newValue }
    }
    /// Full provider catalog from daemon, updated via `model_info` messages.
    public var providerCatalog: [ProviderCatalogEntry] {
        get { messageManager.providerCatalog }
        set { messageManager.providerCatalog = newValue }
    }

    // MARK: - Forwarding properties — ChatAttachmentManager

    public var pendingAttachments: [ChatAttachment] {
        get { attachmentManager.pendingAttachments }
        set { attachmentManager.pendingAttachments = newValue }
    }
    /// True while at least one attachment is still being loaded in the background.
    /// The send button checks this to prevent sending before async load finishes.
    public var isLoadingAttachment: Bool {
        attachmentManager.isLoadingAttachment
    }

    // MARK: - Forwarding properties — ChatErrorManager

    public var errorText: String? {
        get { errorManager.errorText }
        set { errorManager.errorText = newValue }
    }
    public var conversationError: ConversationError? {
        get { errorManager.conversationError }
        set { errorManager.conversationError = newValue }
    }
    /// Whether this view model has an active error (either a conversation error or error text).
    /// Used by ConversationManager to derive `ConversationInteractionState.error`.
    public var hasActiveError: Bool {
        conversationError != nil || errorText != nil
    }
    /// Supplemental diagnostic hint shown alongside a daemon connection error.
    /// Nil when no connection error is active or the error has been dismissed.
    public var connectionDiagnosticHint: String? {
        get { errorManager.connectionDiagnosticHint }
        set { errorManager.connectionDiagnosticHint = newValue }
    }

    /// Platform-provided policy controlling whether a conversation error should
    /// produce an inline ChatMessage in the message list. When this returns false,
    /// the error is still set on errorManager (for toasts, banners, sidebar state)
    /// but no ChatMessage is appended. Defaults to true for all errors.
    @ObservationIgnored public var shouldCreateInlineErrorMessage: ((ConversationError) -> Bool)?

    /// Called when the daemon reports that the managed assistant API key is
    /// invalid (MANAGED_KEY_INVALID). The host should clear the cached key and
    /// call reprovision so the next retry uses a fresh key.
    @ObservationIgnored public var onManagedKeyInvalid: (() -> Void)?

    /// Maximum image size before compression (4 MB - leaves headroom for base64 encoding).
    /// Anthropic has a 5MB limit per image; base64 encoding adds ~33% overhead.
    static let maxImageSize = ChatAttachmentManager.maxImageSize

    public let subagentDetailStore = SubagentDetailStore()
    let connectionManager: GatewayConnectionManager
    let eventStreamClient: EventStreamClient
    private let settingsClient: any SettingsClientProtocol
    private let surfaceClient: any SurfaceClientProtocol = SurfaceClient()
    private let conversationListClient: any ConversationListClientProtocol = ConversationListClient()
    private let btwClient: any BtwClientProtocol = BtwClient()
    let btwState: ChatBtwState
    let interactionClient: any InteractionClientProtocol
    let surfaceActionClient: any SurfaceActionClientProtocol = SurfaceActionClient()
    private let trustRuleClient: any TrustRuleClientProtocol = TrustRuleClient()
    private let guardianClient: any GuardianClientProtocol = GuardianClient()
    private let regenerateClient: any RegenerateClientProtocol = RegenerateClient()
    let conversationQueueClient: any ConversationQueueClientProtocol = ConversationQueueClient()
    /// Tracks the action submitted for each guardian decision requestId so the
    /// response handler can display the correct resolved state (the server does
    /// not echo back the action in its acknowledgement).
    @ObservationIgnored private var pendingGuardianActions: [String: String] = [:]
    public var conversationId: String? {
        didSet {
            // If the daemon reconnected before this VM had a conversation ID, a deferred
            // flush was requested. Now that we have a conversation, run it.
            if conversationId != nil && needsOfflineFlush {
                needsOfflineFlush = false
                flushOfflineQueue()
            }
        }
    }
    @ObservationIgnored private var reconnectObserver: NSObjectProtocol?
    @ObservationIgnored private var appPreviewCapturedObserver: NSObjectProtocol?
    /// Debounces rapid-fire daemon reconnect notifications so only one history
    /// reload is triggered per reconnect burst (500ms settle window).
    @ObservationIgnored private var reconnectDebounceTask: Task<Void, Never>?
    /// Guards against overlapping reconnect history loads. Set true before
    /// requesting history, cleared when `populateFromHistory` completes.
    @ObservationIgnored private var isReconnectHistoryLoading = false
    /// Safety task that resets `isReconnectHistoryLoading` if the history
    /// response never arrives (e.g. the request throws or is dropped).
    @ObservationIgnored private var reconnectLatchTimeoutTask: Task<Void, Never>?
    /// Set to true when daemonDidReconnect fires before conversationId is populated.
    /// Cleared and actioned in the conversationId didSet observer.
    @ObservationIgnored var needsOfflineFlush: Bool = false
    /// Set to true when reconnecting after an SSE gap while a run was in progress.
    /// Causes `populateFromHistory` to do a full message replace instead of
    /// prepending, so the missed assistant response is displayed.
    @ObservationIgnored private var needsReconnectCatchUp: Bool = false
    /// Snapshot of `pendingMessageIds` captured before clearing on reconnect.
    /// Used by the reconnect catch-up path in `populateFromHistory` to dedup
    /// local messages that were pending when the connection dropped (the live
    /// `pendingMessageIds` is cleared immediately, but the debounced history
    /// reload fires 500ms later).
    @ObservationIgnored private var reconnectPendingSnapshot: [UUID] = []
    /// Called when the SSE stream reconnects while a run was in progress.
    /// The store/restorer registers the conversationId in pendingHistoryByConversationId
    /// and sends a history request so the response is routed back properly.
    @ObservationIgnored public var onReconnectHistoryNeeded: ((_ conversationId: String) -> Void)?
    @ObservationIgnored var pendingUserMessage: String?
    /// The display text (rawText) corresponding to pendingUserMessage.
    /// In voice mode, pendingUserMessage contains the voice-prefixed text while
    /// this stores the original user text used for message-bubble matching.
    @ObservationIgnored var pendingUserMessageDisplayText: String?
    /// Whether the pending message is automated (e.g. wake-up greeting).
    @ObservationIgnored var pendingUserMessageAutomated: Bool = false
    /// Optional callback for sending notifications when tool-use messages complete
    @ObservationIgnored public var onToolCallsComplete: ((_ toolCalls: [ToolCallData]) -> Void)?
    /// Whether the current assistant response was triggered by a voice message.
    public var pendingVoiceMessage: Bool = false
    /// Called when a voice-triggered assistant response completes, with the response text.
    @ObservationIgnored public var onVoiceResponseComplete: ((String) -> Void)?
    /// Called when any assistant response completes, with a summary of the response text.
    @ObservationIgnored public var onResponseComplete: ((String) -> Void)?
    /// Called once when the first complete assistant message arrives during bootstrap.
    /// Passes the reply text so callers can inspect content (e.g. naming intent).
    /// Cleared after firing to ensure it only triggers once.
    @ObservationIgnored public var onFirstAssistantReply: ((String) -> Void)?
    /// Called with each streaming text delta during a voice-triggered response, for real-time TTS.
    @ObservationIgnored public var onVoiceTextDelta: ((String) -> Void)?
    /// When true, messages are prefixed with a concise-response instruction for voice conversations.
    public var isVoiceModeActive: Bool = false
    @ObservationIgnored var pendingUserAttachments: [UserMessageAttachment]?
    /// Stores the last user message that failed to send, enabling retry.
    @ObservationIgnored var lastFailedMessageText: String? {
        didSet { syncRetryStateToErrorManager() }
    }
    @ObservationIgnored var lastFailedMessageDisplayText: String?
    @ObservationIgnored var lastFailedMessageAttachments: [UserMessageAttachment]?
    @ObservationIgnored var lastFailedMessageAutomated: Bool = false
    @ObservationIgnored var lastFailedMessageBypassSecretCheck: Bool = false
    /// Set only when a send operation (bootstrapConversation or sendUserMessage) fails.
    /// Used by `isRetryableError` to ensure the retry button only appears for
    /// actual send failures, not for unrelated errors (attachment validation,
    /// confirmation response failures, regenerate errors, etc.).
    @ObservationIgnored var lastFailedSendError: String? {
        didSet { syncRetryStateToErrorManager() }
    }
    /// Stores the text of a message that was blocked by the secret-ingress check.
    /// Set when an error with category "secret_blocked" arrives.
    @ObservationIgnored var secretBlockedMessageText: String? {
        didSet { syncRetryStateToErrorManager() }
    }
    /// Stashed context from the blocked send, so sendAnyway() can reconstruct
    /// the original UserMessageMessage with attachments and surface metadata.
    @ObservationIgnored var secretBlockedAttachments: [UserMessageAttachment]?
    @ObservationIgnored var secretBlockedActiveSurfaceId: String?
    @ObservationIgnored var secretBlockedCurrentPage: String?
    /// Nonce sent with `conversation_create` and echoed back in `conversation_info`.
    /// Used to ensure this ChatViewModel only claims its own conversation.
    @ObservationIgnored var bootstrapCorrelationId: String?
    /// Conversation type sent with `conversation_create` (e.g. "private").
    /// Set by `createConversationIfNeeded(conversationType:)` and included in the
    /// message so the daemon can persist the correct conversation kind.
    public var conversationType: String?
    /// Skill IDs to pre-activate in the conversation. Included in the
    /// `conversation_create` request for deterministic skill activation.
    public var preactivatedSkillIds: [String]?
    /// Whether this view model is currently bootstrapping a new conversation
    /// (conversation_create sent, awaiting conversation_info). Used by ConversationManager
    /// to decide whether it's safe to release the VM on archive.
    public var isBootstrapping: Bool { bootstrapCorrelationId != nil }
    @ObservationIgnored var messageLoopTask: Task<Void, Never>?
    /// Monotonically increasing ID used to distinguish successive message-loop
    /// tasks so that a cancelled loop's cleanup doesn't clear a newer replacement.
    @ObservationIgnored private var messageLoopGeneration: UInt64 = 0
    @ObservationIgnored var currentAssistantMessageId: UUID?
    /// The trimmed user text that initiated the current assistant turn.
    /// Used to tag the assistant message (e.g. modelList for "/models") without
    /// scanning the whole transcript, which would be fragile under queued messages.
    @ObservationIgnored var currentTurnUserText: String?
    /// Tracks whether the current assistant message has received any text content.
    /// Used to determine `arrivedBeforeText` for each tool call in the message.
    @ObservationIgnored var currentAssistantHasText: Bool = false
    /// When true, incoming deltas are suppressed until the daemon acknowledges
    /// the cancellation (via `generation_cancelled` or `message_complete`).
    // Public (rather than private) so tests can simulate the
    // daemon-acknowledged cancellation state directly.
    public var isCancelling: Bool = false
    /// Maps daemon requestId to the user message UUID in the messages array.
    @ObservationIgnored var requestIdToMessageId: [String: UUID] = [:]
    /// Maps requestId to the currently processing user message UUID after dequeue.
    @ObservationIgnored var activeRequestIdToMessageId: [String: UUID] = [:]
    /// FIFO queue of user message UUIDs awaiting requestId assignment from the daemon.
    @ObservationIgnored var pendingMessageIds: [UUID] = []
    /// Messages deleted locally before the daemon's `message_queued` ack arrived.
    /// Once the ack provides the requestId, the deletion is forwarded to the daemon.
    @ObservationIgnored var pendingLocalDeletions: Set<UUID> = []
    /// Tracks the current in-flight suggestion request so stale responses are ignored.
    @ObservationIgnored var pendingSuggestionRequestId: String?

    // MARK: - Streaming Delta Throttle

    /// Interval between flushing buffered streaming text deltas to the
    /// messages array.  Coalescing multiple token deltas into a single
    /// array mutation dramatically reduces SwiftUI view-graph
    /// invalidation frequency during streaming.
    static let streamingFlushInterval: TimeInterval = 0.05 // 50 ms

    /// Buffered text that has not yet been flushed to `messages`.
    @ObservationIgnored var streamingDeltaBuffer: String = ""
    /// Scheduled flush work item; cancelled and re-created on each delta.
    @ObservationIgnored var streamingFlushTask: Task<Void, Never>?

    /// Buffered thinking text that has not yet been flushed to `messages`.
    @ObservationIgnored var thinkingDeltaBuffer: String = ""
    /// Scheduled flush task for coalescing thinking delta writes.
    @ObservationIgnored var thinkingFlushTask: Task<Void, Never>?

    // MARK: - Partial Output Coalescing

    /// Buffered partial-output chunks keyed by "messageUUID:tcIndex".
    /// Uses stable message UUID instead of positional index so the buffer
    /// survives message-list mutations (pagination prepend, memory trim).
    @ObservationIgnored var partialOutputBuffer: [String: (messageId: UUID, tcIndex: Int, content: String)] = [:]
    /// Scheduled flush task for coalescing partial-output writes.
    @ObservationIgnored var partialOutputFlushTask: Task<Void, Never>?

    /// Safety timer that force-resets the UI if the daemon never acknowledges
    /// a cancel request (e.g. a stuck tool blocks the generation_cancelled event).
    @ObservationIgnored var cancelTimeoutTask: Task<Void, Never>?

    /// Saved text from a queued message that should be auto-sent after cancellation completes.
    @ObservationIgnored var pendingSendDirectText: String?
    /// Saved attachments from a queued message that should be auto-sent after cancellation completes.
    @ObservationIgnored var pendingSendDirectAttachments: [ChatAttachment]?
    /// Saved skill invocation from a queued message for send-direct dispatch.
    @ObservationIgnored var pendingSendDirectSkillInvocation: SkillInvocationData?

    /// Timestamp of the most recent `toolUseStart` event received by this view model.
    /// Used by ConversationManager to route `confirmationRequest` messages to the correct
    /// ChatViewModel when multiple conversations are active.
    @ObservationIgnored public var lastToolUseReceivedAt: Date?

    /// Monotonically increasing version counter for server-authoritative activity state.
    /// Used to ignore stale `assistant_activity_state` events.
    @ObservationIgnored var lastActivityVersion: Int = 0

    /// Called when an inline confirmation is responded to, so the floating panel can be dismissed.
    /// Parameters: (requestId, decision)
    @ObservationIgnored public var onInlineConfirmationResponse: ((String, String) -> Void)?

    /// Tracks requestIds for which onInlineConfirmationResponse has already been called locally
    /// (via respondToConfirmation / respondToAlwaysAllow). When the daemon's confirmationStateChanged
    /// event arrives for the same requestId, we skip the duplicate callback.
    @ObservationIgnored var inlineResponseHandledRequestIds = Set<String>()

    /// Called to determine whether this ChatViewModel should accept a `confirmationRequest`.
    /// Set by ConversationManager to coordinate routing when multiple ChatViewModels are active.
    @ObservationIgnored public var shouldAcceptConfirmation: (() -> Bool)?

    /// Called when the daemon sends a `watch_started` message to begin a watch session.
    /// The closure receives the WatchStartedMessage and the GatewayConnectionManager so the macOS
    /// layer can create and start a WatchSession.
    @ObservationIgnored public var onWatchStarted: ((WatchStartedMessage, GatewayConnectionManager) -> Void)?

    /// Called when the daemon sends a `watch_complete_request` to stop the active watch session.
    @ObservationIgnored public var onWatchCompleteRequest: ((WatchCompleteRequestMessage) -> Void)?

    /// Called when the user taps the stop button on the watch progress UI.
    /// The macOS layer should cancel the WatchSession and send a cancel to the daemon.
    @ObservationIgnored public var onStopWatch: (() -> Void)?

    /// Called when the daemon assigns a conversation ID to this chat (via conversation_info).
    /// Used by ConversationManager to backfill ConversationModel.conversationId for new conversations.
    @ObservationIgnored public var onConversationCreated: ((String) -> Void)?

    /// Called once when the first user message is sent, with the message text.
    /// Used by ConversationManager to auto-title the conversation.
    @ObservationIgnored public var onFirstUserMessage: ((String) -> Void)?

    /// Called every time a user message is sent. Used by ConversationManager to
    /// bump the conversation's lastInteractedAt so it rises to the top of the list.
    @ObservationIgnored public var onUserMessageSent: (() -> Void)?
    /// Called when the exact `/fork` composer command should be handled locally
    /// by the client instead of being sent to the assistant.
    @ObservationIgnored public var onFork: (() -> Void)?

    /// Whether this view model has had its history loaded from the daemon.
    public var isHistoryLoaded: Bool = false

    /// True while `populateFromHistory` is actively inserting messages.
    /// Observers can check this to avoid treating the history hydration as new activity.
    public internal(set) var isLoadingHistory: Bool = false

    // MARK: - Message Pagination (forwarded from ChatPaginationState)

    /// Page size for chat message display; older messages are loaded in this increment.
    public static let messagePageSize = ChatPaginationState.messagePageSize

    public var displayedMessageCount: Int {
        get { paginationState.displayedMessageCount }
        set {
            paginationState.displayedMessageCount = newValue
            // Full recompute from the live messages array — not just the
            // paginated suffix — because callers often mutate `messages` and
            // `displayedMessageCount` in the same synchronous block (e.g.
            // trimOldMessagesIfNeeded, populateFromHistory). The async
            // Combine bridge hasn't delivered the new messages yet, so the
            // cached `displayedMessages` would be stale if we only called
            // recomputePaginatedSuffix().
            paginationState.recomputeVisibleMessages(from: messageManager.messages)
        }
    }

    public var isLoadingMoreMessages: Bool {
        get { paginationState.isLoadingMoreMessages }
        set { paginationState.isLoadingMoreMessages = newValue }
    }

    public var displayedMessages: [ChatMessage] {
        paginationState.displayedMessages
    }

    /// Pre-computed paginated visible messages for the current display window.
    /// Cached at the model layer so view bodies read O(1) instead of running
    /// the O(n) visibility filter on every body evaluation.
    public var paginatedVisibleMessages: [ChatMessage] {
        paginationState.paginatedVisibleMessages
    }

    public var historyCursor: Double? {
        get { paginationState.historyCursor }
        set { paginationState.historyCursor = newValue }
    }

    public var hasMoreHistory: Bool {
        get { paginationState.hasMoreHistory }
        set { paginationState.hasMoreHistory = newValue }
    }

    // MARK: - BTW Side-Chain State (forwarded from ChatBtwState)

    /// The accumulated response text from a /btw side-chain query, or nil when inactive.
    public var btwResponse: String? { btwState.btwResponse }
    /// True while a /btw request is in flight.
    public var btwLoading: Bool { btwState.btwLoading }

    // MARK: - Forwarding properties — ChatGreetingState

    public var emptyStateGreeting: String? {
        get { greetingState.emptyStateGreeting }
        set { greetingState.emptyStateGreeting = newValue }
    }
    public var isGeneratingGreeting: Bool {
        greetingState.isGeneratingGreeting
    }
    public var conversationStarters: [ConversationStarter] {
        get { greetingState.conversationStarters }
        set { greetingState.conversationStarters = newValue }
    }
    public var conversationStartersLoading: Bool {
        greetingState.conversationStartersLoading
    }

    public var hasMoreMessages: Bool {
        paginationState.hasMoreMessages
    }

    public var onLoadMoreHistory: ((_ conversationId: String, _ beforeTimestamp: Double) -> Void)? {
        get { paginationState.onLoadMoreHistory }
        set { paginationState.onLoadMoreHistory = newValue }
    }

    @discardableResult
    public func loadPreviousMessagePage() async -> Bool {
        await paginationState.loadPreviousMessagePage()
    }

    public func resetMessagePagination() {
        paginationState.resetMessagePagination()
    }

    // MARK: - On-Demand Content Rehydration

    /// Message IDs currently being rehydrated — prevents duplicate concurrent fetches.
    private var rehydratingMessageIds: Set<UUID> = []

    /// Fetch full (untruncated) content for a message that was loaded with truncated
    /// text/tool results or had its heavy content stripped. No-ops if the message is
    /// not found, doesn't need rehydration, or is already being fetched.
    public func rehydrateMessage(id: UUID) {
        guard !rehydratingMessageIds.contains(id) else { return }
        guard let idx = messages.firstIndex(where: { $0.id == id }),
              messages[idx].wasTruncated || messages[idx].isContentStripped,
              let conversationId = conversationId,
              let daemonMessageId = messages[idx].daemonMessageId else { return }
        guard connectionManager.isConnected else { return }
        rehydratingMessageIds.insert(id)
        Task { [weak self] in
            guard let self else { return }
            defer { self.rehydratingMessageIds.remove(id) }
            if let response = await ConversationClient().fetchMessageContent(conversationId: conversationId, messageId: daemonMessageId) {
                self.handleMessageContentResponse(response)
            }
        }
    }

    /// Persist a captured preview image into the ChatMessage model so it survives conversation switches.
    public func updateSurfacePreviewImage(appId: String, base64: String) {
        for msgIdx in messages.indices {
            for surfIdx in messages[msgIdx].inlineSurfaces.indices {
                if case .dynamicPage(var dpData) = messages[msgIdx].inlineSurfaces[surfIdx].data,
                   dpData.appId == appId {
                    dpData.preview?.previewImage = base64
                    messages[msgIdx].inlineSurfaces[surfIdx].data = .dynamicPage(dpData)
                }
            }
        }
    }

    /// Handle a `message_content_response` from the daemon, updating the matching
    /// message with full (untruncated) text and tool call results.
    public func handleMessageContentResponse(_ response: MessageContentResponse) {
        guard let idx = messages.firstIndex(where: { $0.daemonMessageId == response.messageId }) else { return }

        // Only update text when the message has a single segment (non-interleaved).
        // Interleaved messages have multiple text segments separated by tool calls;
        // collapsing them into one destroys the contentOrder interleaving, which
        // causes separate tool groups to merge into one massive progress view.
        // Text is already displayed correctly from the original segments — rehydration
        // is primarily needed for tool call details (inputs, results, images).
        if let fullText = response.text {
            let hasInterleavedText = messages[idx].textSegments.count > 1
            if !hasInterleavedText {
                messages[idx].textSegments = fullText.isEmpty ? [] : [fullText]
            }
        }

        // Update tool call results with full content.
        // Use positional matching first — when a message has multiple tool calls
        // with the same name (e.g. two `bash` calls), name-based lookup always
        // overwrites the first match. Fall back to name-based only when the
        // positional index is out of bounds or the name doesn't match.
        if let fullToolCalls = response.toolCalls {
            for (i, fullTC) in fullToolCalls.enumerated() {
                let tcIdx: Int
                if i < messages[idx].toolCalls.count && messages[idx].toolCalls[i].toolName == fullTC.name {
                    tcIdx = i
                } else if let fallback = messages[idx].toolCalls.firstIndex(where: { $0.toolName == fullTC.name }) {
                    tcIdx = fallback
                } else {
                    continue
                }
                if let result = fullTC.result {
                    messages[idx].toolCalls[tcIdx].result = result
                    messages[idx].toolCalls[tcIdx].resultLength = result.count
                }
                if let input = fullTC.input {
                    let formatted = ToolCallData.formatAllToolInput(input)
                    messages[idx].toolCalls[tcIdx].inputFull = formatted
                    messages[idx].toolCalls[tcIdx].inputFullLength = formatted.count
                    messages[idx].toolCalls[tcIdx].inputRawDict = input
                }
            }
        }

        // Clear unconditionally — even when text replacement was skipped for
        // interleaved messages, tool call data has been rehydrated. Leaving
        // wasTruncated true would cause infinite rehydration requests.
        messages[idx].wasTruncated = false
        messages[idx].isContentStripped = false
    }

    // MARK: - Message Trimming

    /// Threshold above which old messages have their heavy content stripped.
    private static let trimThreshold = 150
    /// Number of recent messages to keep untrimmed (images, attachments, surfaces intact).
    private static let trimKeepRecent = 75

    /// Strip heavyweight binary data (images, attachments, completed surface payloads)
    /// from old messages when the total count exceeds `trimThreshold`. The most recent
    /// `trimKeepRecent` messages are left intact so scrolling back a reasonable amount
    /// still shows full content. Old messages are fully removed from the array (not just
    /// stripped) to free embedded images and tool data from memory entirely.
    /// Called after message mutations that increase count.
    public func trimOldMessagesIfNeeded() {
        let count = messages.count
        guard count > Self.trimThreshold else { return }
        let trimEnd = count - Self.trimKeepRecent
        // Strip heavy content first (safety net for any references that linger)
        for i in 0..<trimEnd {
            messages[i].stripHeavyContent()
        }
        // Hard-delete the stripped messages so ChatMessage objects are freed entirely.
        messages.removeSubrange(0..<trimEnd)
        // After deleting the oldest messages, advance the history cursor to the oldest
        // retained message and mark that older pages are available from the daemon so
        // the user can paginate back to re-fetch the trimmed messages.
        if let oldestRetained = messages.first {
            historyCursor = oldestRetained.timestamp.timeIntervalSince1970 * 1000
            hasMoreHistory = true
        }
        // Reset pagination so the display window doesn't reference indices beyond the
        // newly shortened array. trimKeepRecent < messagePageSize is possible, so clamp.
        displayedMessageCount = Self.messagePageSize
    }

    /// Aggressively trim this view model for background retention. Keeps only
    /// the latest page of messages with heavy content stripped, and resets
    /// pagination so re-activation fetches fresh history from the daemon.
    public func trimForBackground() {
        let pageSize = Self.messagePageSize
        if messages.count > pageSize {
            messages = Array(messages.suffix(pageSize))
        }
        for i in messages.indices {
            messages[i].stripHeavyContent()
        }
        displayedMessageCount = Self.messagePageSize
        // Only mark history as unloaded if there's a conversation to reload from.
        // Conversations without a conversation ID (new, empty) have nothing to fetch —
        // resetting the flag would leave the UI stuck on a loading spinner.
        if conversationId != nil {
            isHistoryLoaded = false
        }
    }

    /// Surface the user is currently viewing in workspace mode.
    /// Set by MainWindowView when the dynamic workspace is expanded.
    public var activeSurfaceId: String? {
        didSet {
            if oldValue != activeSurfaceId {
                surfaceUndoCount = 0
                currentPage = nil
            }
        }
    }

    /// When true, the chat is docked to the side panel alongside the workspace.
    /// Messages should flow through the normal chat conversation instead of the
    /// workspace activity feed overlay.
    public var isChatDockedToSide: Bool = false

    /// The page currently displayed in the workspace WebView (e.g. "settings.html").
    /// Set via the onPageChanged callback when the user navigates within a multi-page app.
    public var currentPage: String?

    public init(
        connectionManager: GatewayConnectionManager,
        eventStreamClient: EventStreamClient,
        settingsClient: any SettingsClientProtocol = SettingsClient(),
        interactionClient: any InteractionClientProtocol = InteractionClient(),
        onToolCallsComplete: ((_ toolCalls: [ToolCallData]) -> Void)? = nil
    ) {
        self.connectionManager = connectionManager
        self.eventStreamClient = eventStreamClient
        self.settingsClient = settingsClient
        self.interactionClient = interactionClient
        self.onToolCallsComplete = onToolCallsComplete
        self.paginationState = ChatPaginationState(
            messageManager: messageManager
        )

        // Initialize BTW side-chain state as a self-contained @Observable.
        self.btwState = ChatBtwState(btwClient: btwClient)

        // Set the conversationId provider after all stored properties are
        // initialized so the closure can capture `self` weakly — Swift
        // requires all stored properties to be initialized before `self`
        // is available.
        paginationState.conversationIdProvider = { [weak self] in self?.conversationId }

        // Initialize the send coordinator with injected dependencies.
        self.sendCoordinator = MessageSendCoordinator(
            delegate: self,
            messageManager: messageManager,
            attachmentManager: attachmentManager,
            errorManager: errorManager,
            btwState: btwState,
            settingsClient: settingsClient,
            conversationListClient: conversationListClient
        )

        // Initialize the action handler for server message dispatch.
        self.actionHandler = ChatActionHandler(viewModel: self)

        // Surface attachment validation errors in the error manager so the UI
        // can show them without the attachment manager needing a direct reference.
        attachmentManager.onError = { [weak self] message in
            self?.errorManager.errorText = message
        }

        reconnectObserver = NotificationCenter.default.addObserver(
            forName: .daemonDidReconnect,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                // Snapshot pendingMessageIds before clearing so the debounced
                // reconnect catch-up (which fires 500ms later) can still dedup
                // local messages that were pending when the connection dropped.
                // Only take a new snapshot if no debounce task is in flight —
                // a rapid second reconnect must not overwrite the snapshot to
                // empty while the first debounce is still pending.
                if self?.reconnectDebounceTask == nil {
                    self?.reconnectPendingSnapshot = self?.pendingMessageIds ?? []
                }
                self?.pendingQueuedCount = 0
                self?.pendingMessageIds.removeAll()
                self?.requestIdToMessageId.removeAll()
                self?.activeRequestIdToMessageId.removeAll()
                self?.pendingLocalDeletions.removeAll()
                self?.lastActivityVersion = 0
                self?.assistantActivityPhase = "idle"
                self?.assistantActivityAnchor = "global"
                self?.assistantActivityReason = nil
                self?.assistantStatusText = nil
                // If a run was in progress when the connection dropped, the
                // client may have missed the messageComplete (or the full
                // assistant response). Reset the spinner and re-fetch history
                // so the UI catches up on anything that happened during the gap.
                // Debounce: cancel any pending reconnect task and wait 500ms
                // to coalesce rapid-fire reconnect notifications into one load.
                if self?.isThinking == true || self?.isSending == true || self?.currentAssistantMessageId != nil {
                    self?.isThinking = false
                    self?.isSending = false
                    self?.currentAssistantMessageId = nil
                    self?.discardStreamingBuffer()
                    self?.discardPartialOutputBuffer()
                    self?.reconnectDebounceTask?.cancel()
                    self?.reconnectDebounceTask = Task { @MainActor [weak self] in
                        defer { if !Task.isCancelled { self?.reconnectDebounceTask = nil } }
                        try? await Task.sleep(nanoseconds: 500_000_000) // 500ms
                        guard !Task.isCancelled else { return }
                        guard let self, !self.isReconnectHistoryLoading else { return }
                        if let conversationId = self.conversationId {
                            self.isReconnectHistoryLoading = true
                            self.needsReconnectCatchUp = true
                            // Safety timeout: if the history response never arrives
                            // (e.g. request throws or is dropped), reset the latch
                            // so future reconnects aren't blocked forever.
                            self.reconnectLatchTimeoutTask?.cancel()
                            self.reconnectLatchTimeoutTask = Task { @MainActor [weak self] in
                                try? await Task.sleep(nanoseconds: 10_000_000_000) // 10s
                                guard !Task.isCancelled, let self, self.isReconnectHistoryLoading else { return }
                                log.warning("Reconnect history latch timed out after 10s — resetting")
                                self.isReconnectHistoryLoading = false
                                self.needsReconnectCatchUp = false
                                self.reconnectPendingSnapshot = []
                            }
                            self.onReconnectHistoryNeeded?(conversationId)
                        }
                    }
                }
                // Auto-retry a failed message on reconnect so the user doesn't
                // have to manually click "Retry" after a transient daemon crash.
                if let self, self.isConnectionError, self.lastFailedMessageText != nil {
                    self.retryLastMessage()
                } else if let self, self.isConnectionError {
                    // No message to retry, but clear the stale error banner
                    self.errorText = nil
                    self.lastFailedSendError = nil
                    self.connectionDiagnosticHint = nil
                }

                // If we already have a conversation ID, flush immediately. Otherwise
                // defer: conversationId's didSet will trigger flushOfflineQueue() once
                // the conversation is restored from history (cold-start reconnect case).
                if self?.conversationId != nil {
                    self?.flushOfflineQueue()
                } else {
                    self?.needsOfflineFlush = true
                }
            }
        }

        // Listen for captured app preview images and persist them into the
        // ChatMessage model so they survive conversation switches and history reloads.
        appPreviewCapturedObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("MainWindow.appPreviewImageCaptured"),
            object: nil,
            queue: nil
        ) { [weak self] notification in
            guard let appId = notification.userInfo?["appId"] as? String,
                  let base64 = notification.userInfo?["previewImage"] as? String else { return }
            Task { @MainActor [weak self] in
                self?.updateSurfacePreviewImage(appId: appId, base64: base64)
            }
        }

        // Register for system memory pressure events so we can aggressively
        // trim the message list when the OS warns of low memory. This prevents
        // the app from being jettisoned on devices with limited RAM.
        let source = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical], queue: .main)
        source.setEventHandler { [weak self] in
            guard let self else { return }
            // Keep only the most recent trimKeepRecent messages to reclaim
            // as much memory as possible under pressure.
            let keepCount = Self.trimKeepRecent
            if self.messages.count > keepCount {
                self.messages.removeFirst(self.messages.count - keepCount)
                // Advance cursor to oldest retained message and mark that older
                // pages are available from the daemon so the user can paginate back.
                if let oldestRetained = self.messages.first {
                    self.historyCursor = oldestRetained.timestamp.timeIntervalSince1970 * 1000
                }
                self.hasMoreHistory = true
                self.displayedMessageCount = Self.messagePageSize
            }
        }
        source.resume()
        self.memoryPressureSource = source
    }

    // MARK: - Notification Catch-Up

    /// Prepare the view model for a notification catch-up history fetch.
    ///
    /// Sets `needsReconnectCatchUp` so the next `populateFromHistory` call uses
    /// the smart merge path (server-authoritative list + preserved unsent locals)
    /// instead of the prepend-older-only path which would drop the new message.
    ///
    /// Called by ConversationManager when a `notification_intent` arrives for a
    /// conversation that already has an active ViewModel. Must be followed by a
    /// `requestReconnectHistory()` call on the ConversationRestorer.
    public func prepareForNotificationCatchUp() {
        needsReconnectCatchUp = true
    }

    /// Prepare the view model for a channel conversation refresh.
    /// Resets `isHistoryLoaded` so `loadHistoryIfNeeded` proceeds, and sets
    /// `needsReconnectCatchUp` so `populateFromHistory` does an atomic
    /// message replace instead of clearing the array first.
    public func prepareForChannelRefresh() {
        needsReconnectCatchUp = true
        isHistoryLoaded = false
    }

    // MARK: - Deep Link

    /// Check for a buffered deep-link message and apply it to `inputText`.
    /// Called by the view layer when this `ChatViewModel` becomes the
    /// active/visible conversation, ensuring only one VM ever consumes the message.
    public func consumeDeepLinkIfNeeded() {
        guard let message = DeepLinkManager.pendingMessage else { return }
        DeepLinkManager.pendingMessage = nil
        inputText = message
    }

    // MARK: - Sending (forwarded to MessageSendCoordinator)

    public func sendMessage(hidden: Bool = false) {
        os_signpost(.event, log: Self.stallLog, name: "sendMessage")
        sendCoordinator.sendMessage(hidden: hidden)
    }

    // MARK: - BTW Side-Chain (forwarded to ChatBtwState)

    /// Send a /btw side-chain question and stream the response into `btwResponse`.
    public func sendBtwMessage(question: String) {
        btwState.sendBtwMessage(question: question, conversationKey: conversationId ?? "")
    }

    /// Clear btw side-chain state and cancel any in-flight stream.
    public func dismissBtw() {
        btwState.dismissBtw()
    }

    // MARK: - Forwarding methods — ChatGreetingState

    public func generateGreeting() {
        greetingState.generateGreeting()
    }

    public func dismissGreeting() {
        greetingState.dismissGreeting()
    }

    public func fetchConversationStarters() {
        greetingState.fetchConversationStarters()
    }

    func bootstrapConversation(userMessage: String?, attachments: [UserMessageAttachment]?) {
        sendCoordinator.bootstrapConversation(userMessage: userMessage, attachments: attachments)
    }

    func sendUserMessage(_ text: String, displayText: String? = nil, attachments: [UserMessageAttachment]? = nil, queuedMessageId: UUID? = nil, automated: Bool = false, bypassSecretCheck: Bool = false) {
        sendCoordinator.sendUserMessage(text, displayText: displayText, attachments: attachments, queuedMessageId: queuedMessageId, automated: automated, bypassSecretCheck: bypassSecretCheck)
    }

    // MARK: - Offline Queue Flush (forwarded to MessageSendCoordinator)

    func flushOfflineQueue() {
        sendCoordinator.flushOfflineQueue()
    }

    public func startMessageLoop() {
        messageLoopTask?.cancel()
        let messageStream = eventStreamClient.subscribe()

        messageLoopGeneration &+= 1
        let generation = messageLoopGeneration

        messageLoopTask = Task { @MainActor [weak self] in
            for await message in messageStream {
                guard let self, !Task.isCancelled else { break }
                self.handleServerMessage(message)
            }
            // Stream ended (e.g. daemon disconnected) — clear the task reference
            // so the next sendUserMessage() call will re-subscribe.
            // Only nil out if this task is still the current one; a cancelled
            // loop that finishes after its replacement must not wipe the new
            // task reference, which would cause duplicate subscriptions.
            if self?.messageLoopGeneration == generation {
                self?.messageLoopTask = nil
                // Reset spinner state — if the connection drops mid-turn the client
                // never receives message_complete, leaving the UI stuck.
                self?.isThinking = false
                self?.isSending = false
                self?.isCancelling = false
                // Mark current assistant message as no longer streaming
                if let existingId = self?.currentAssistantMessageId,
                   let index = self?.messages.firstIndex(where: { $0.id == existingId }) {
                    self?.messages[index].isStreaming = false
                }
                self?.currentAssistantMessageId = nil
                self?.discardStreamingBuffer()
                self?.discardPartialOutputBuffer()
                // If a send-direct was pending when the stream dropped,
                // dispatch it now so the message isn't silently lost.
                self?.dispatchPendingSendDirect()
            }
        }
    }

    /// Start the daemon message stream if this chat has a bound conversation and
    /// no active loop yet.
    public func ensureMessageLoopStarted() {
        guard conversationId != nil, messageLoopTask == nil else { return }
        startMessageLoop()
    }

    /// Send a message to the daemon without showing a user bubble in the chat.
    /// Used for automated actions like inline model picker selections.
    /// Returns `true` if the message was sent (or a conversation bootstrap was started),
    /// `false` if the message was silently dropped (e.g. bootstrap already in flight).
    @discardableResult
    public func sendSilently(_ text: String) -> Bool {
        // Don't re-enter bootstrap if a conversation creation is already in progress —
        // that would overwrite pendingUserMessage and orphan the in-flight conversation.
        if conversationId == nil && (isSending || isBootstrapping) {
            return false
        }
        if conversationId == nil {
            bootstrapConversation(userMessage: text, attachments: nil)
        } else {
            sendUserMessage(text)
        }
        return true
    }

    /// Create a daemon conversation immediately, without a user message.
    /// Used by private conversations that need a persistent conversation ID right away
    /// (e.g. to store the conversation in the database before the user types anything).
    /// No-op if a conversation already exists or a bootstrap is already in flight.
    public func createConversationIfNeeded(conversationType: String? = nil) {
        guard conversationId == nil, !isBootstrapping else { return }
        if let conversationType {
            self.conversationType = conversationType
        }
        bootstrapConversation(userMessage: nil, attachments: nil)
    }

    // MARK: - Model

    /// Switch the active model via the gateway.
    public func setModel(_ modelId: String) {
        // Ensure the message loop is running so we receive downstream events.
        // VMs restored with an existing conversationId may not have started it yet.
        if messageLoopTask == nil {
            startMessageLoop()
        }
        Task {
            let info = await SettingsClient().setModel(model: modelId)
            if let model = info?.model {
                self.selectedModel = model
            }
            if let providers = info?.configuredProviders {
                self.configuredProviders = Set(providers)
            }
            if let allProviders = info?.allProviders, !allProviders.isEmpty {
                self.providerCatalog = allProviders
            }
        }
    }

    // MARK: - Actions

    public func sendSurfaceAction(surfaceId: String, actionId: String, data: [String: AnyCodable]? = nil) {
        // For relay_prompt / agent_prompt actions from history-restored surfaces,
        // send the prompt as a regular message instead of a surface action.
        // This avoids requiring in-memory surface state on the daemon (which is
        // lost after restart) and ensures the full message send pipeline runs
        // (conversation creation, hub publisher setup, SSE event delivery).
        let isRelay = actionId == "relay_prompt" || actionId == "agent_prompt"
        if isRelay, let prompt = data?["prompt"]?.value as? String, !prompt.isEmpty {
            _ = sendSilently(prompt)
            return
        }

        guard let conversationId else { return }
        Task {
            await surfaceActionClient.sendSurfaceAction(
                conversationId: conversationId,
                surfaceId: surfaceId,
                actionId: actionId,
                data: data
            )
        }
    }

    // MARK: - Surface Refetch

    @ObservationIgnored private lazy var surfaceRefetchCoordinator = SurfaceRefetchCoordinator(
        surfaceRefetchManager: SurfaceRefetchManager { [weak self] surfaceId, conversationId in
            guard let self else { return nil }
            return await self.surfaceClient.fetchSurfaceData(surfaceId: surfaceId, conversationId: conversationId)
        },
        applyResult: { [weak self] surfaceId, result in
            guard let self else { return }
            for msgIndex in self.messages.indices {
                if let surfIndex = self.messages[msgIndex].inlineSurfaces.firstIndex(where: { $0.id == surfaceId }) {
                    if let data = result.data {
                        self.messages[msgIndex].inlineSurfaces[surfIndex].data = data
                    } else if result.retriesExhausted {
                        self.messages[msgIndex].inlineSurfaces[surfIndex].data = .strippedFailed
                    }
                    // When data is nil but retries are not exhausted, leave the
                    // surface in .stripped state so a future onAppear re-triggers
                    // the fetch attempt.
                    return
                }
            }
        }
    )

    public func refetchStrippedSurface(surfaceId: String, conversationId: String) {
        surfaceRefetchCoordinator.refetchStrippedSurface(surfaceId: surfaceId, conversationId: conversationId)
    }

    /// Cancel the queued user message without clearing `bootstrapCorrelationId`.
    /// Used when archiving a conversation before conversation_info arrives.
    public func cancelPendingMessage() {
        sendCoordinator.cancelPendingMessage()
    }

    public func stopGenerating() {
        sendCoordinator.stopGenerating()
    }

    /// Regenerate the last assistant response. Removes the old reply from
    /// all memory systems (including Qdrant) and re-runs the agent loop.
    public func regenerateLastMessage() {
        guard let conversationId, !isSending else { return }
        guard connectionManager.isConnected else {
            errorText = "Failed to connect to the assistant."
            return
        }

        // Remove inline error messages before regenerating so they don't
        // linger above the new response.
        while messages.last?.isError == true {
            messages.removeLast()
        }
        errorText = nil
        conversationError = nil
        errorManager.isConversationErrorDisplayedInline = false
        isSending = true
        isThinking = true
        suggestion = nil
        pendingSuggestionRequestId = nil

        // Make sure we're listening for the response
        if messageLoopTask == nil {
            startMessageLoop()
        }

        Task {
            let success = await regenerateClient.regenerate(conversationId: conversationId)
            if !success {
                isSending = false
                isThinking = false
                errorText = "Failed to regenerate message."
            }
        }
    }

    /// Revert the last refinement on the active workspace surface.
    public func undoSurfaceRefinement() {
        guard let conversationId, let surfaceId = activeSurfaceId else { return }
        guard surfaceUndoCount > 0 else { return }
        Task {
            await surfaceActionClient.sendSurfaceUndo(conversationId: conversationId, surfaceId: surfaceId)
        }
    }

    /// Delete a queued message by its local message ID.
    /// Finds the daemon requestId for the message and sends a delete request.
    public func deleteQueuedMessage(messageId: UUID) {
        guard let conversationId else { return }

        // Find the requestId for this message
        guard let entry = requestIdToMessageId.first(where: { $0.value == messageId }) else {
            // Message hasn't been assigned a requestId yet — remove it from the UI
            // and defer the daemon-side cancellation until the ack arrives.
            pendingLocalDeletions.insert(messageId)
            removeQueuedMessageLocally(messageId: messageId)
            return
        }

        Task {
            let success = await conversationQueueClient.deleteQueuedMessage(
                conversationId: conversationId,
                requestId: entry.key
            )
            if success {
                applyQueuedMessageDeletion(requestId: entry.key)
            } else {
                log.error("Failed to delete queued message")
            }
        }
    }

    /// Update local state after the server confirms a queued message deletion.
    /// Mirrors the bookkeeping that `.messageQueuedDeleted` performs so that
    /// the UI stays consistent when the delete originates from a direct HTTP call.
    func applyQueuedMessageDeletion(requestId: String) {
        pendingQueuedCount = max(0, pendingQueuedCount - 1)
        let messageId = requestIdToMessageId.removeValue(forKey: requestId)
            ?? activeRequestIdToMessageId.removeValue(forKey: requestId)
        if let messageId {
            messages.removeAll { $0.id == messageId }
        }
        var queuePosition = 0
        for i in messages.indices {
            if case .queued = messages[i].status {
                messages[i].status = .queued(position: queuePosition)
                queuePosition += 1
            }
        }
        if pendingQueuedCount == 0 && !isThinking {
            isSending = false
        }
    }

    /// Remove a queued message from local state without a daemon round-trip.
    /// Used when the message hasn't been acknowledged by the daemon yet.
    private func removeQueuedMessageLocally(messageId: UUID) {
        // Do NOT remove from pendingMessageIds — the FIFO queue must stay
        // intact so incoming message_queued acks map to the correct messages.
        // The deferred deletion is tracked via pendingLocalDeletions instead.
        messages.removeAll { $0.id == messageId }
        pendingQueuedCount = max(0, pendingQueuedCount - 1)
        if pendingQueuedCount == 0 && !isThinking {
            isSending = false
        }
    }

    /// Skip the queue: stop the current generation and immediately send a specific queued message.
    public func sendDirectQueuedMessage(messageId: UUID) {
        sendCoordinator.sendDirectQueuedMessage(messageId: messageId)
    }

    /// If a send-direct is pending, populate the composer and fire sendMessage.
    /// Called from all cancel-completion paths (generationCancelled, timeout, disconnected, etc.).
    func dispatchPendingSendDirect() {
        sendCoordinator.dispatchPendingSendDirect()
    }

    /// Stop the active watch session and notify the macOS layer.
    public func stopWatchSession() {
        guard isWatchSessionActive else { return }
        isWatchSessionActive = false
        onStopWatch?()
    }

    public func dismissDocumentSurface(id: String) {
        dismissedDocumentSurfaceIds.insert(id)
    }

    public func dismissError() {
        conversationError = nil
        errorText = nil
        errorManager.isConversationErrorDisplayedInline = false
        lastFailedMessageText = nil
        lastFailedMessageDisplayText = nil
        lastFailedMessageAttachments = nil
        lastFailedMessageAutomated = false
        lastFailedMessageBypassSecretCheck = false
        lastFailedSendError = nil
        connectionDiagnosticHint = nil
        secretBlockedMessageText = nil
        secretBlockedAttachments = nil
        secretBlockedActiveSurfaceId = nil
        secretBlockedCurrentPage = nil
    }

    /// Dismiss the typed conversation error state. Clears both the typed error
    /// and any corresponding `errorText` so the UI can return to normal.
    /// Removes the most recent inline error message only if one was created.
    public func dismissConversationError() {
        conversationError = nil
        errorText = nil
        // Only remove the inline error card if the current error actually
        // produced one. When shouldCreateInlineErrorMessage returned false
        // (e.g. credits-exhausted on macOS), no card was appended, so
        // removing the last .isError message would delete an unrelated
        // historical error card.
        if errorManager.isConversationErrorDisplayedInline,
           let lastErrorIndex = messages.lastIndex(where: { $0.isError }) {
            messages.remove(at: lastErrorIndex)
        }
        errorManager.isConversationErrorDisplayedInline = false
    }

    /// Copy conversation error details to the clipboard for debugging.
    public func copyConversationErrorDebugDetails() {
        let error = conversationError ?? messages.last(where: { $0.isError })?.conversationError
        guard let error else { return }
        var details = """
        Error: \(error.message)
        Category: \(error.category)
        Conversation: \(error.conversationId)
        Retryable: \(error.isRetryable)
        """
        if let debugDetails = error.debugDetails {
            details += "\n\nDebug Details:\n\(debugDetails)"
        }
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(details, forType: .string)
        #elseif os(iOS)
        UIPasteboard.general.string = details
        #endif
    }

    /// Retry the last message after a conversation error, if the error is retryable.
    /// The error may live on the view model (toast path) or on the last inline error
    /// message (inline card path, where `conversationError` was already cleared).
    ///
    /// When `messageId` is provided (inline card path), the method validates that no
    /// successful messages follow the target error — preventing the retry button on
    /// an older error card from regenerating a newer, perfectly good response.
    public func retryAfterConversationError(messageId: UUID? = nil) {
        // When a specific message triggered the retry, validate that it is still
        // at the tail of the conversation so the retry targets the correct turn.
        if let messageId {
            guard let targetIndex = messages.firstIndex(where: { $0.id == messageId }) else { return }
            let target = messages[targetIndex]
            guard target.isError else { return }
            // Bail if any non-error messages follow — the conversation has moved on.
            let hasSuccessfulFollowup = messages.suffix(from: messages.index(after: targetIndex))
                .contains(where: { !$0.isError })
            if hasSuccessfulFollowup { return }
        }

        let error = conversationError ?? messages.last(where: { $0.isError })?.conversationError
        guard let error, error.isRetryable else { return }
        guard conversationId != nil else { return }
        // Reset sending state that may still be set if the conversation error arrived
        // while queued messages were pending (pendingQueuedCount > 0).
        // Without this, regenerateLastMessage() silently bails at its
        // `!isSending` guard, leaving the UI stuck with no error and no retry.
        isSending = false
        pendingQueuedCount = 0
        pendingMessageIds = []
        requestIdToMessageId = [:]
        activeRequestIdToMessageId = [:]
        pendingLocalDeletions.removeAll()
        for i in messages.indices {
            if case .queued = messages[i].status, messages[i].role == .user {
                messages[i].status = .sent
            }
        }
        dismissConversationError()

        // When the last message is from the user (i.e. the assistant never
        // responded — e.g. because the send was rate-limited with 429), resend
        // the original message instead of regenerating. A /regenerate request
        // would fail because the daemon has no assistant response to regenerate.
        if let lastMsg = messages.last, lastMsg.role == .user {
            lastFailedMessageText = lastMsg.text
            lastFailedMessageDisplayText = nil
            lastFailedMessageAutomated = lastMsg.isHidden
            lastFailedMessageBypassSecretCheck = false
            // Preserve attachments so they are resent with the retry.
            lastFailedMessageAttachments = lastMsg.attachments.compactMap { att in
                guard !att.data.isEmpty || att.filePath != nil else { return nil }
                return UserMessageAttachment(
                    id: att.id,
                    filename: att.filename,
                    mimeType: att.mimeType,
                    data: att.data,
                    extractedText: nil,
                    sizeBytes: att.sizeBytes,
                    thumbnailData: att.thumbnailData?.base64EncodedString(),
                    filePath: att.filePath
                )
            }
            retryLastMessage()
        } else {
            // The daemon already persisted both the user message and the error
            // assistant message. Regenerate deletes the error message and re-runs
            // the agent loop with the existing user message, avoiding duplicates.
            regenerateLastMessage()
        }
    }

    /// Whether the current error has a failed user message that can be retried.
    /// Only true when `lastFailedSendError` is set, which restricts the retry
    /// button to actual send failures and prevents unrelated errors (attachment
    /// validation, confirmation response failures, regenerate errors) from
    /// offering to resend a stale cached message.
    public var hasRetryPayload: Bool { lastFailedMessageText != nil }

    public var isRetryableError: Bool {
        lastFailedMessageText != nil && lastFailedSendError != nil && !isConnectionError
    }

    /// Whether the current error is a daemon/assistant connection failure.
    public var isConnectionError: Bool {
        lastFailedSendError == "Failed to connect to the assistant."
    }

    /// Whether the current error is a secret-ingress block that can be bypassed.
    public var isSecretBlockError: Bool {
        secretBlockedMessageText != nil
    }

    /// Forward retry-related state to `errorManager` so `@ObservedObject` views
    /// (e.g. `ErrorToastOverlay`) receive reactive updates. Called automatically
    /// via `didSet` on `lastFailedMessageText`, `lastFailedSendError`, and
    /// `secretBlockedMessageText`.
    private func syncRetryStateToErrorManager() {
        errorManager.isConnectionError = isConnectionError
        errorManager.isSecretBlockError = isSecretBlockError
        errorManager.isRetryableError = isRetryableError
        errorManager.hasRetryPayload = hasRetryPayload
    }

    /// Resend the secret-blocked message with the bypass flag so the backend skips the check.
    public func sendAnyway() {
        sendCoordinator.sendAnyway()
    }

    /// Retry sending the last user message that failed (e.g. due to daemon disconnection).
    public func retryLastMessage() {
        sendCoordinator.retryLastMessage()
    }

    /// Retry sending a specific failed message. Moves it to the end of the
    /// conversation and resends it so it appears as the most recent message.
    public func retryFailedMessage(id: UUID) {
        guard let idx = messages.firstIndex(where: { $0.id == id }) else { return }
        let message = messages[idx]
        guard message.role == .user, message.status == .sendFailed else { return }

        // Remove the failed message from its current position
        messages.remove(at: idx)

        // Re-append it at the end with .sent status
        var retryMessage = ChatMessage(
            role: .user,
            text: message.text,
            status: .sent,
            skillInvocation: message.skillInvocation,
            attachments: message.attachments
        )
        retryMessage.isHidden = message.isHidden
        messages.append(retryMessage)

        // Convert ChatAttachments back to UserMessageAttachments for the send call.
        // Keep file-path-based attachments even when data is empty,
        // since the daemon can read the file from disk.
        let userAttachments: [UserMessageAttachment]? = message.attachments.isEmpty ? nil : message.attachments.compactMap { att in
            guard !att.data.isEmpty || att.filePath != nil else { return nil }
            return UserMessageAttachment(
                id: att.id,
                filename: att.filename,
                mimeType: att.mimeType,
                data: att.data,
                extractedText: nil,
                sizeBytes: att.sizeBytes,
                thumbnailData: att.thumbnailData?.base64EncodedString(),
                filePath: att.filePath
            )
        }

        // Resend — bootstrap a new conversation if needed (mirrors retryLastMessage)
        if conversationId == nil {
            pendingUserMessageAutomated = message.isHidden
            bootstrapConversation(userMessage: message.text, attachments: userAttachments)
        } else {
            sendUserMessage(message.text, attachments: userAttachments, automated: message.isHidden)
        }
    }

    /// Respond to a tool confirmation request displayed inline in the chat.
    public func respondToConfirmation(requestId: String, decision: String) {
        log.info("[confirm-flow] respondToConfirmation called: requestId=\(requestId, privacy: .public) decision=\(decision, privacy: .public)")
        markConfirmationInFlight(requestId: requestId, decision: decision)
        inlineResponseHandledRequestIds.insert(requestId)
        Task {
            let result = await performConfirmationResponse(
                requestId: requestId, decision: decision, selectedPattern: nil, selectedScope: nil
            )
            switch result {
            case .success:
                break
            case .alreadyResolved:
                // The backend already auto-denied this confirmation (e.g. a new
                // message arrived). Collapse the prompt silently — the SSE
                // confirmation_state_changed event will confirm the final state.
                log.info("[confirm-flow] respondToConfirmation: already resolved, collapsing silently: requestId=\(requestId, privacy: .public)")
                self.collapseStaleConfirmation(requestId: requestId)
            case .failed:
                log.error("[confirm-flow] respondToConfirmation POST failed (will show error banner): requestId=\(requestId, privacy: .public) decision=\(decision, privacy: .public)")
                self.revertConfirmationInFlight(requestId: requestId)
                self.inlineResponseHandledRequestIds.remove(requestId)
                self.errorText = "Failed to send confirmation response."
            }
        }
    }

    /// Respond to a tool confirmation with "always_allow", sending the selected pattern and scope
    /// so the backend atomically persists the trust rule alongside the confirmation response.
    /// On send errors, attempts a one-time allow fallback and only claims success if the
    /// fallback actually went through.
    public func respondToAlwaysAllow(requestId: String, selectedPattern: String, selectedScope: String, decision: String = "always_allow") {
        markConfirmationInFlight(requestId: requestId, decision: decision)
        inlineResponseHandledRequestIds.insert(requestId)
        Task {
            let result = await interactionClient.sendConfirmationResponse(
                requestId: requestId, decision: decision, selectedPattern: selectedPattern, selectedScope: selectedScope
            )
            switch result {
            case .success:
                if let index = self.messages.firstIndex(where: { $0.confirmation?.requestId == requestId }) {
                    self.messages[index].confirmation?.approvedDecision = decision
                }
                self.clearPendingConfirmation(requestId: requestId)
                self.onInlineConfirmationResponse?(requestId, "allow")
                self.inlineResponseHandledRequestIds.insert(requestId)
            case .alreadyResolved:
                log.info("[confirm-flow] respondToAlwaysAllow: already resolved, collapsing silently: requestId=\(requestId, privacy: .public)")
                self.collapseStaleConfirmation(requestId: requestId)
            case .failed:
                log.warning("Always-allow send failed, trying one-time allow fallback")
                let fallbackResult = await self.performConfirmationResponse(
                    requestId: requestId, decision: "allow", selectedPattern: nil, selectedScope: nil
                )
                switch fallbackResult {
                case .success:
                    self.errorText = "Preference could not be saved. This action was allowed once."
                case .alreadyResolved:
                    log.info("[confirm-flow] respondToAlwaysAllow fallback: already resolved, collapsing silently: requestId=\(requestId, privacy: .public)")
                    self.collapseStaleConfirmation(requestId: requestId)
                case .failed:
                    self.revertConfirmationInFlight(requestId: requestId)
                    self.inlineResponseHandledRequestIds.remove(requestId)
                }
            }
        }
    }

    /// Optimistically update confirmation UI to prevent duplicate submissions while
    /// the gateway request is in flight.
    private func markConfirmationInFlight(requestId: String, decision: String) {
        guard let index = messages.firstIndex(where: { $0.confirmation?.requestId == requestId }) else { return }
        let isApproval = decision == "allow" || decision == "allow_10m" || decision == "allow_conversation"
            || decision == "always_allow" || decision == "always_allow_high_risk"
        messages[index].confirmation?.state = isApproval ? .approved : .denied
        if isApproval {
            messages[index].confirmation?.approvedDecision = decision
        }
    }

    /// Revert an optimistic confirmation update when the gateway request fails.
    private func revertConfirmationInFlight(requestId: String) {
        guard let index = messages.firstIndex(where: { $0.confirmation?.requestId == requestId }) else { return }
        messages[index].confirmation?.state = .pending
        messages[index].confirmation?.approvedDecision = nil
    }

    /// Collapse a stale confirmation that was already resolved by the backend
    /// (e.g. auto-denied when a new message arrived). Marks it as denied and
    /// cleans up tracking state without showing an error banner.
    private func collapseStaleConfirmation(requestId: String) {
        if let index = messages.firstIndex(where: { $0.confirmation?.requestId == requestId }) {
            messages[index].confirmation?.state = .denied
        }
        clearPendingConfirmation(requestId: requestId)
        onInlineConfirmationResponse?(requestId, "deny")
        inlineResponseHandledRequestIds.insert(requestId)
    }

    /// Shared async helper that sends a confirmation response and updates UI state on success.
    private func performConfirmationResponse(
        requestId: String,
        decision: String,
        selectedPattern: String?,
        selectedScope: String?
    ) async -> ConfirmationSendResult {
        let result = await interactionClient.sendConfirmationResponse(
            requestId: requestId, decision: decision, selectedPattern: selectedPattern, selectedScope: selectedScope
        )
        guard result == .success else { return result }
        if let index = messages.firstIndex(where: { $0.confirmation?.requestId == requestId }) {
            let isApproval = decision == "allow" || decision == "allow_10m" || decision == "allow_conversation"
            messages[index].confirmation?.state = isApproval ? .approved : .denied
            if isApproval {
                messages[index].confirmation?.approvedDecision = decision
            }
        }
        clearPendingConfirmation(requestId: requestId)
        onInlineConfirmationResponse?(requestId, decision)
        inlineResponseHandledRequestIds.insert(requestId)
        return .success
    }

    /// Update the inline confirmation message state without sending a response to the daemon.
    /// Used when the floating panel handles the response.
    public func updateConfirmationState(requestId: String, decision: String) {
        if let index = messages.firstIndex(where: { $0.confirmation?.requestId == requestId }) {
            switch decision {
            case "allow", "allow_10m", "allow_conversation":
                messages[index].confirmation?.state = .approved
                messages[index].confirmation?.approvedDecision = decision
            case "deny":
                messages[index].confirmation?.state = .denied
            default:
                break
            }
        }
        clearPendingConfirmation(requestId: requestId)
    }

    /// Clear `pendingConfirmation` on the matching tool call so the inline bubble
    /// reflects the submitted decision without waiting for the daemon's
    /// `confirmation_state_changed` echo.
    private func clearPendingConfirmation(requestId: String) {
        for i in messages.indices.reversed() {
            guard messages[i].role == .assistant, messages[i].confirmation == nil else { continue }
            if let tcIdx = messages[i].toolCalls.firstIndex(where: {
                $0.pendingConfirmation?.requestId == requestId
            }) {
                messages[i].toolCalls[tcIdx].pendingConfirmation = nil
                break
            }
        }
    }

    /// Persist a trust rule via the focused TrustRuleClient.
    public func addTrustRule(toolName: String, pattern: String, scope: String, decision: String) {
        Task {
            do {
                try await trustRuleClient.addTrustRule(
                    toolName: toolName,
                    pattern: pattern,
                    scope: scope,
                    decision: decision,
                    allowHighRisk: nil,
                    executionTarget: nil
                )
            } catch {
                log.error("Failed to add trust rule: \(error.localizedDescription)")
            }
        }
    }


    /// Ask the daemon for a follow-up suggestion for the current conversation.
    func fetchSuggestion() {
        guard let conversationId, connectionManager.isConnected else { return }

        let requestId = UUID().uuidString
        pendingSuggestionRequestId = requestId

        Task {
            let settingsClient = SettingsClient()
            let response = await settingsClient.fetchSuggestion(conversationId: conversationId, requestId: requestId)
            guard pendingSuggestionRequestId == requestId else { return }
            pendingSuggestionRequestId = nil
            suggestion = response?.suggestion
        }
    }

    /// Accept the current suggestion, appending the ghost suffix to input.
    public func acceptSuggestion() {
        let effectiveSuggestion = suggestion
        guard let effectiveSuggestion else { return }
        if effectiveSuggestion.hasPrefix(inputText) {
            inputText = effectiveSuggestion
        } else if inputText.isEmpty {
            inputText = effectiveSuggestion
        }
        self.suggestion = nil
    }

    /// Populate messages from history data returned by the daemon.
    /// If the user hasn't sent any messages yet, replaces messages entirely.
    /// If the user already sent messages (late history_response), prepends
    /// history before the existing messages so the user sees full context.
    ///
    /// - Parameters:
    ///   - historyMessages: The message items from the daemon's history response.
    ///   - hasMore: Whether the daemon has older pages available.
    ///   - oldestTimestamp: The timestamp of the oldest message in the response (ms since epoch).
    ///     Used as the cursor for the next pagination request.
    ///   - isPaginationLoad: When `true`, messages are prepended to the existing list
    ///     (older page fetched on demand). When `false`, the standard initial-load
    ///     or reconnect-catch-up logic applies.
    public func populateFromHistory(
        _ historyMessages: [HistoryResponseMessage],
        hasMore: Bool,
        oldestTimestamp: Double? = nil,
        isPaginationLoad: Bool = false
    ) {
        let spid = OSSignpostID(log: Self.poiLog)
        os_signpost(.begin, log: Self.poiLog, name: "populateFromHistory", signpostID: spid, "messages=%d isPagination=%d", historyMessages.count, isPaginationLoad ? 1 : 0)

        // Reconstruct messages using a nonisolated static method.
        // The heavy work (JSON size estimation, tool input formatting, surface
        // mapping, image decoding) is isolated in a pure function that accesses
        // no @MainActor state, enabling future background execution.
        let convId = self.conversationId
        let result = HistoryReconstructionService.reconstructMessages(from: historyMessages, conversationId: convId)
        let chatMessages = result.messages
        let reconstructedSubagents = result.subagents

        // Merge reconstructed subagents into activeSubagents (avoid duplicates)
        for info in reconstructedSubagents where !activeSubagents.contains(where: { $0.id == info.id }) {
            activeSubagents.append(info)
        }

        // Update daemon pagination cursor from the response metadata.
        self.hasMoreHistory = hasMore
        self.historyCursor = oldestTimestamp

        if isPaginationLoad {
            // Older page fetched on demand — prepend before existing messages
            // and expand the display window so the newly loaded messages are
            // visible. The loading indicator is cleared here.
            // Flush any buffered partial output before prepending — the prepend
            // shifts positional indices so stale buffer entries would corrupt.
            flushPartialOutputBuffer()
            var mergedMessages = chatMessages + self.messages
            let hasModelCommand = applyHistoryResponseMarkers(to: &mergedMessages)
            self.messages = mergedMessages
            // Expand the display window by the number of messages prepended so
            // the user sees them immediately. Use Int.max if no more pages exist.
            if hasMore {
                displayedMessageCount = displayedMessageCount == Int.max
                    ? Int.max
                    : displayedMessageCount + chatMessages.count
            } else {
                displayedMessageCount = Int.max
            }
            self.paginationState.loadMoreTimeoutTask?.cancel()
            self.paginationState.loadMoreTimeoutTask = nil
            self.paginationState.isLoadingMoreMessages = false
            // TODO: Add pagination-aware trim that doesn't regress historyCursor (follow-up)
            refreshModelMetadataIfNeeded(hasModelCommand)
            os_signpost(.end, log: Self.poiLog, name: "populateFromHistory", signpostID: spid, "path=pagination")
            return
        }

        self.isLoadingHistory = true

        // Discard any in-flight streaming text that references the pre-replacement
        // message array. Without this, a scheduled flushStreamingBuffer() can fire
        // after the messages array is replaced, creating an orphan assistant message
        // or appending text to a stale currentAssistantMessageId.
        discardStreamingBuffer()
        discardPartialOutputBuffer()
        surfaceRefetchCoordinator.cancelRefetchTasks()
        currentAssistantMessageId = nil
        currentAssistantHasText = false

        if needsReconnectCatchUp {
            // Reconnect catch-up: the SSE stream dropped while a run was
            // in progress, so the client may have missed the assistant's
            // response. Use the server's authoritative message list, but
            // preserve any genuinely unsent local messages. History items
            // use daemon DB IDs while local messages use Swift UUIDs, so
            // simple ID-based dedup won't work — use fuzzy matching instead
            // (role + text prefix + timestamp ±2s).
            needsReconnectCatchUp = false
            // Use the snapshot captured at reconnect time, unioned with the
            // current pendingMessageIds. The snapshot has IDs that were pending
            // when the connection dropped (before clearing), while current
            // pendingMessageIds captures any messages the user sent AFTER the
            // reconnect but BEFORE this debounced handler ran.
            let snapshotIds = self.reconnectPendingSnapshot
            let allPendingIds = Set(snapshotIds).union(self.pendingMessageIds)
            self.reconnectPendingSnapshot = []
            let localCandidates = self.messages.filter {
                allPendingIds.contains($0.id) || $0.status == .pendingOffline
            }
            var localOnly: [ChatMessage] = []
            for local in localCandidates {
                let isDuplicate = chatMessages.contains { server in
                    server.role == local.role
                    && server.text.hasPrefix(String(local.text.prefix(100)))
                    && abs(server.timestamp.timeIntervalSince(local.timestamp)) < 2
                }
                if !isDuplicate { localOnly.append(local) }
            }
            var mergedMessages = chatMessages + localOnly
            mergedMessages.sort { $0.timestamp < $1.timestamp }
            let hasModelCommand = applyHistoryResponseMarkers(to: &mergedMessages)
            self.messages = mergedMessages
            self.reconnectLatchTimeoutTask?.cancel()
            self.isReconnectHistoryLoading = false
            refreshModelMetadataIfNeeded(hasModelCommand)
        } else if messages.contains(where: { $0.role == .user }) {
            // History arrived after the user already sent messages.
            // The history payload includes ALL persisted messages — including
            // ones the user sent (and any assistant replies) before the
            // history_response arrived. Deduplicate by only prepending
            // history messages whose timestamps precede the earliest
            // existing message.
            let earliestExisting = self.messages.map(\.timestamp).min()
            let uniqueHistory: [ChatMessage]
            if let earliest = earliestExisting {
                uniqueHistory = chatMessages.filter { $0.timestamp < earliest }
            } else {
                uniqueHistory = chatMessages
            }
            var mergedMessages = uniqueHistory + self.messages
            mergedMessages.sort { $0.timestamp < $1.timestamp }
            let hasModelCommand = applyHistoryResponseMarkers(to: &mergedMessages)
            self.messages = mergedMessages
            refreshModelMetadataIfNeeded(hasModelCommand)
        } else {
            var taggedMessages = chatMessages
            let hasModelCommand = applyHistoryResponseMarkers(to: &taggedMessages)
            self.messages = taggedMessages
            refreshModelMetadataIfNeeded(hasModelCommand)
        }
        self.isLoadingHistory = false
        self.isHistoryLoaded = true
        // Reset pagination so the view shows the most-recent page after history loads.
        self.displayedMessageCount = Self.messagePageSize
        // Surfaces are now included directly in the history response and populated above
        // Strip heavy data from old messages after a (potentially large) history load.
        trimOldMessagesIfNeeded()
        // Fetch pending guardian prompts when history loads (conversation open/restore)
        refreshGuardianPrompts()
        os_signpost(.end, log: Self.poiLog, name: "populateFromHistory", signpostID: spid, "path=initial messages=%d", chatMessages.count)
    }


    private func applyHistoryResponseMarkers(to chatMessages: inout [ChatMessage]) -> Bool {
        var hasModelCommand = false

        for i in chatMessages.indices {
            guard chatMessages[i].role == .user,
                  i + 1 < chatMessages.count,
                  chatMessages[i + 1].role == .assistant else {
                continue
            }

            let userText = chatMessages[i].text.trimmingCharacters(in: .whitespacesAndNewlines)
            if userText == "/models" {
                chatMessages[i + 1].modelList = ModelListData()
                hasModelCommand = true
            } else if userText == "/commands" {
                chatMessages[i + 1].commandList = CommandListData()
            }
        }

        return hasModelCommand
    }

    private func refreshModelMetadataIfNeeded(_ shouldRefresh: Bool) {
        guard shouldRefresh else { return }

        Task {
            let info = await SettingsClient().fetchModelInfo()
            if let model = info?.model {
                self.selectedModel = model
            }
            if let providers = info?.configuredProviders {
                self.configuredProviders = Set(providers)
            }
            if let allProviders = info?.allProviders, !allProviders.isEmpty {
                self.providerCatalog = allProviders
            }
        }
    }

    deinit {
        // Cancel all Combine subscriptions first so no new work can be scheduled
        // from incoming publisher events while the remaining cleanup runs.
        cancellables.removeAll()
        messageLoopTask?.cancel()
        streamingFlushTask?.cancel()
        partialOutputFlushTask?.cancel()
        cancelTimeoutTask?.cancel()
        // paginationState.loadMoreTimeoutTask uses [weak self] and exits
        // naturally when ChatPaginationState is deallocated with this object.
        // surfaceRefetchCoordinator is released with self; its deinit cancels tasks.
        // refinementFailureDismissTask and refinementFlushTask are accessed via
        // @MainActor computed properties (forwarded from ChatMessageManager), which
        // cannot be referenced from nonisolated deinit. Both tasks use [weak self],
        // so they will exit naturally when self is deallocated.
        reconnectLatchTimeoutTask?.cancel()
        reconnectDebounceTask?.cancel()
        // btwTask cancellation is handled by ChatBtwState's deinit.
        greetingState.cancelAll()
        sendingWatchdogTask?.cancel()
        guardianDecisionTimeoutTasks.values.forEach { $0.cancel() }
        memoryPressureSource?.cancel()
        if let observer = reconnectObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        if let observer = appPreviewCapturedObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    // MARK: - Connection diagnostics

    /// Map a raw connection error to a short, actionable diagnostic hint.
    /// Delegates to ChatErrorManager so the logic lives in one place.
    static func connectionDiagnosticHint(for error: Error) -> String? {
        ChatErrorManager.connectionDiagnosticHint(for: error)
    }

    // MARK: - Guardian Decision Prompts

    /// Fetch pending guardian prompts for the current conversation and insert
    /// them into the message list. Existing guardian messages for the same
    /// requestId are updated rather than duplicated; resolved prompts not in
    /// the response are marked stale.
    public func refreshGuardianPrompts() {
        guard let conversationId else { return }
        Task {
            if let response = await guardianClient.fetchPendingActions(conversationId: conversationId) {
                handleGuardianActionsPendingResponse(response)
            }
        }
    }

    /// Submit a guardian action decision for a given request.
    /// Marks the prompt as submitting immediately for responsive UI.
    public func submitGuardianDecision(requestId: String, action: String) {
        // Track the submitted action so the response handler can display the
        // correct resolved state (the server acknowledgement omits the action).
        pendingGuardianActions[requestId] = action

        // Mark as submitting in the UI
        if let idx = messages.firstIndex(where: { $0.guardianDecision?.requestId == requestId }) {
            messages[idx].guardianDecision?.isSubmitting = true
        }

        Task {
            let response = await guardianClient.submitDecision(requestId: requestId, action: action, conversationId: conversationId)

            // Cancel the safety-net timeout for this specific requestId — we have an HTTP response.
            guardianDecisionTimeoutTasks[requestId]?.cancel()
            guardianDecisionTimeoutTasks[requestId] = nil

            if let response {
                if response.applied {
                    // Real server decision — route to the handler for resolved state.
                    handleGuardianActionDecisionResponse(response)
                } else {
                    // Transport failure (HTTP error, network timeout) or server
                    // explicitly said stale/not-found. GuardianClient synthesizes
                    // applied=false for HTTP errors — don't mark the prompt as
                    // .stale on a transient 5xx. Instead, revert submitting state
                    // and let the user retry.
                    pendingGuardianActions.removeValue(forKey: requestId)
                    if let idx = messages.firstIndex(where: { $0.guardianDecision?.requestId == requestId }) {
                        messages[idx].guardianDecision?.isSubmitting = false
                    }
                    refreshGuardianPrompts()
                }
            } else {
                log.error("Failed to submit guardian decision for requestId \(requestId)")
                pendingGuardianActions.removeValue(forKey: requestId)
                // Revert submitting state on failure
                if let idx = messages.firstIndex(where: { $0.guardianDecision?.requestId == requestId }) {
                    messages[idx].guardianDecision?.isSubmitting = false
                }
            }
        }

        // Safety-net timeout: if the decision is still submitting after 15s,
        // clear the spinner and re-sync with the server. Don't remove from
        // pendingGuardianActions — let the main response handler or refresh
        // handle the cleanup so the action label is preserved.
        // Cancel any previous timeout for the SAME requestId only — other
        // in-flight submissions keep their own independent timeouts.
        guardianDecisionTimeoutTasks[requestId]?.cancel()
        guardianDecisionTimeoutTasks[requestId] = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 15_000_000_000)
            guard !Task.isCancelled, let self else { return }
            if let idx = self.messages.firstIndex(where: { $0.guardianDecision?.requestId == requestId }),
               self.messages[idx].guardianDecision?.isSubmitting == true {
                log.warning("Guardian decision submit timed out for requestId \(requestId, privacy: .public)")
                self.messages[idx].guardianDecision?.isSubmitting = false
                self.refreshGuardianPrompts()
            }
            self.guardianDecisionTimeoutTasks[requestId] = nil
        }
    }

    /// Process the server's response to a guardian actions pending request.
    /// Inserts new prompts, updates existing ones, and marks absent ones as stale.
    func handleGuardianActionsPendingResponse(_ response: GuardianActionsPendingResponseMessage) {
        // Only process prompts that belong to this conversation
        guard let myConversationId = conversationId else {
            return
        }

        // Responses are broadcast to all subscribers. Skip responses scoped to
        // a different conversation to avoid incorrectly stale-marking our
        // genuinely pending prompts.
        if let responseConversationId = response.conversationId,
           responseConversationId != myConversationId {
            return
        }

        let relevantPrompts = response.prompts.filter { $0.conversationId == myConversationId }
        let incomingIds = Set(relevantPrompts.map(\.requestId))

        // Mark existing guardian messages not in the response as stale
        for i in messages.indices {
            if let gd = messages[i].guardianDecision,
               case .pending = gd.state,
               !incomingIds.contains(gd.requestId) {
                messages[i].guardianDecision?.state = .stale()
                messages[i].guardianDecision?.isSubmitting = false
            }
        }

        let existingIds = Set(messages.compactMap { $0.guardianDecision?.requestId })
        // Also track confirmation bubbles to avoid creating duplicate guardian
        // decision cards for the same requestId that already has a confirmation UI.
        let existingConfirmationIds = Set(messages.compactMap { $0.confirmation?.requestId })

        for wire in relevantPrompts {
            if existingConfirmationIds.contains(wire.requestId) {
                continue
            }
            if existingIds.contains(wire.requestId) {
                // Update existing message
                if let idx = messages.firstIndex(where: { $0.guardianDecision?.requestId == wire.requestId }) {
                    // Don't overwrite a locally-resolved state with a stale state
                    // from the server — the local resolved state carries the action label.
                    if case .resolved = messages[idx].guardianDecision?.state {
                        continue
                    }
                    let newData = GuardianDecisionData(from: wire)
                    // Preserve submitting state if still waiting
                    let wasSubmitting = messages[idx].guardianDecision?.isSubmitting ?? false
                    messages[idx].guardianDecision = newData
                    if wasSubmitting && newData.state == .pending {
                        messages[idx].guardianDecision?.isSubmitting = true
                    }
                }
            } else {
                // Insert new guardian prompt as an assistant message
                let data = GuardianDecisionData(from: wire)
                let msg = ChatMessage(
                    role: .assistant,
                    text: "",
                    guardianDecision: data
                )
                messages.append(msg)
            }
        }
    }

    /// Process the server's response to a guardian action decision submission.
    func handleGuardianActionDecisionResponse(_ response: GuardianActionDecisionResponseMessage) {
        guard let requestId = response.requestId else {
            // The server returned without a requestId (e.g., already-resolved or
            // not-found paths). Clear isSubmitting on any locally-tracked pending
            // actions and refresh prompts so the UI doesn't stay stuck.
            if !response.applied {
                for pendingRequestId in pendingGuardianActions.keys {
                    if let idx = messages.firstIndex(where: { $0.guardianDecision?.requestId == pendingRequestId }) {
                        messages[idx].guardianDecision?.isSubmitting = false
                    }
                }
                refreshGuardianPrompts()
            }
            return
        }

        let submittedAction = pendingGuardianActions.removeValue(forKey: requestId)

        if let idx = messages.firstIndex(where: { $0.guardianDecision?.requestId == requestId }) {
            messages[idx].guardianDecision?.isSubmitting = false
            if response.applied {
                // Use the locally tracked action since the server acknowledgement
                // does not echo back the action that was submitted.
                let resolvedAction = submittedAction ?? response.reason ?? "approved"
                messages[idx].guardianDecision?.state = .resolved(action: resolvedAction)

                // Display resolver reply text (e.g. verification code for access
                // requests) as a follow-up assistant message so the guardian can
                // see and act on it.
                if let replyText = response.replyText, !replyText.isEmpty {
                    let replyMessage = ChatMessage(role: .assistant, text: replyText)
                    messages.append(replyMessage)
                }
            } else {
                // Stale: someone else already resolved this prompt.
                // Surface the server-supplied reason so the user sees context
                // (e.g. "expired", "stale") instead of a generic message.
                let staleReason = response.reason ?? response.userText
                messages[idx].guardianDecision?.state = .stale(reason: staleReason)
            }
        }

        // Re-fetch pending prompts to get the updated list
        refreshGuardianPrompts()
    }

    // MARK: - PTT metadata

    /// Snapshot of the current push-to-talk state, sent with each user message
    /// so the daemon can include it in channel capabilities.
    struct PttMetadata {
        let activationKey: String?
        let microphonePermissionGranted: Bool?
    }

    /// Read the current PTT activation key and microphone permission from the
    /// platform. On non-macOS platforms, returns nil fields (PTT is desktop-only).
    static func currentPttMetadata() -> PttMetadata {
        #if os(macOS)
        let key = SharedUserDefaults.standard.string(forKey: "activationKey") ?? "fn"
        let micGranted = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        return PttMetadata(activationKey: key, microphonePermissionGranted: micGranted)
        #else
        return PttMetadata(activationKey: nil, microphonePermissionGranted: nil)
        #endif
    }
}
