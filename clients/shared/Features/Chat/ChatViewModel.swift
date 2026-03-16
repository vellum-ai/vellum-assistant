import Combine
import Foundation
import Network
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

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ChatViewModel")

/// Facade that owns the three focused sub-managers and forwards all property
/// accesses to them via computed properties.  Existing call sites require no
/// changes because the public API surface is identical to the previous monolith.
@MainActor
public final class ChatViewModel: ObservableObject {

    // MARK: - Sub-managers

    /// Owns message-list and send-state properties.
    public let messageManager = ChatMessageManager()
    /// Owns the pending-attachment list and image-processing helpers.
    public let attachmentManager = ChatAttachmentManager()
    /// Owns errorText, sessionError, and connection-diagnostic properties.
    public let errorManager = ChatErrorManager()

    private var cancellables: Set<AnyCancellable> = []

    /// DispatchSource for system memory pressure events. Triggers an aggressive
    /// message trim on .warning and .critical events to reclaim memory quickly.
    private var memoryPressureSource: DispatchSourceMemoryPressure?

    // MARK: - Coalesced objectWillChange forwarding

    /// Coalescing window for sub-manager objectWillChange forwarding.
    /// The first sub-manager change schedules a single objectWillChange after
    /// this interval; subsequent changes within the window piggyback on the
    /// same notification, dramatically reducing view-tree invalidation rate
    /// during streaming bursts.
    static let subManagerCoalesceInterval: TimeInterval = 0.1 // 100ms

    /// Coalescing task: fires objectWillChange once per burst window, same
    /// pattern as SubagentDetailStore.scheduleFlush().
    private var subManagerPublishTask: Task<Void, Never>?

    /// Schedule a single coalesced `objectWillChange` notification.
    /// The first sub-manager mutation in a burst schedules the publish;
    /// subsequent mutations within the 100ms window piggyback on the same
    /// notification instead of firing individually.
    private func scheduleCoalescedPublish() {
        guard subManagerPublishTask == nil else { return }
        subManagerPublishTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.subManagerCoalesceInterval * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.objectWillChange.send()
            self?.subManagerPublishTask = nil
        }
    }

    /// Flush any pending coalesced publish immediately.
    /// Used after clearing `inputText` in `sendMessage()` so the TextField
    /// binding updates without the 100ms delay — preventing the field editor
    /// from writing stale text back through the binding.
    private func flushCoalescedPublish() {
        subManagerPublishTask?.cancel()
        subManagerPublishTask = nil
        objectWillChange.send()
    }

    // MARK: - Debug publish-rate counters

    #if DEBUG
    private static let perfLog = OSLog(subsystem: "com.vellum.assistant", category: "PerfCounters")
    private var publishCount = 0
    private var messageManagerPublishCount = 0
    private var attachmentManagerPublishCount = 0
    private var errorManagerPublishCount = 0
    private var lastRateLogTime = Date()

    private func trackPublish(source: String) {
        publishCount += 1
        switch source {
        case "messageManager": messageManagerPublishCount += 1
        case "attachmentManager": attachmentManagerPublishCount += 1
        case "errorManager": errorManagerPublishCount += 1
        default: break
        }
        let now = Date()
        if now.timeIntervalSince(lastRateLogTime) >= 5 {
            os_log(
                .debug, log: Self.perfLog,
                "ChatViewModel publish rate: %d/5s (msg=%d, attach=%d, err=%d)",
                publishCount, messageManagerPublishCount, attachmentManagerPublishCount, errorManagerPublishCount
            )
            publishCount = 0
            messageManagerPublishCount = 0
            attachmentManagerPublishCount = 0
            errorManagerPublishCount = 0
            lastRateLogTime = now
        }
    }
    #endif

    // MARK: - Forwarding properties — ChatMessageManager

    public var messages: [ChatMessage] {
        get { messageManager.messages }
        set { messageManager.messages = newValue }
    }
    public var inputText: String {
        get { messageManager.inputText }
        set {
            let oldValue = messageManager.inputText
            let oldSuggestion = messageManager.suggestion
            messageManager.inputText = newValue
            guard newValue != oldValue else { return }
            if let oldSuggestion, !oldSuggestion.hasPrefix(newValue) {
                messageManager.suggestion = nil
                pendingSuggestionRequestId = nil
            }
        }
    }
    public var isThinking: Bool {
        get { messageManager.isThinking }
        set { messageManager.isThinking = newValue }
    }
    public var isSending: Bool {
        get { messageManager.isSending }
        set { messageManager.isSending = newValue }
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
    /// Whether this view model has an active error (either a session error or error text).
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

    // MARK: - Static size limits (forwarded to attachment manager for use in extensions)

    /// Maximum file size per attachment (20 MB).
    static let maxFileSize = ChatAttachmentManager.maxFileSize
    /// Maximum image size before compression (4 MB - leaves headroom for base64 encoding).
    /// Anthropic has a 5MB limit per image; base64 encoding adds ~33% overhead.
    static let maxImageSize = ChatAttachmentManager.maxImageSize

    public let subagentDetailStore = SubagentDetailStore()
    let daemonClient: any DaemonClientProtocol
    /// Tracks the action submitted for each guardian decision requestId so the
    /// response handler can display the correct resolved state (the server does
    /// not echo back the action in its acknowledgement).
    private var pendingGuardianActions: [String: String] = [:]
    public var conversationId: String? {
        didSet {
            // If the daemon reconnected before this VM had a session ID, a deferred
            // flush was requested. Now that we have a session, run it.
            if conversationId != nil && needsOfflineFlush {
                needsOfflineFlush = false
                flushOfflineQueue()
            }
        }
    }
    private var reconnectObserver: NSObjectProtocol?
    private var appPreviewCapturedObserver: NSObjectProtocol?
    /// Debounces rapid-fire daemon reconnect notifications so only one history
    /// reload is triggered per reconnect burst (500ms settle window).
    private var reconnectDebounceTask: Task<Void, Never>?
    /// Guards against overlapping reconnect history loads. Set true before
    /// requesting history, cleared when `populateFromHistory` completes.
    private var isReconnectHistoryLoading = false
    /// Safety task that resets `isReconnectHistoryLoading` if the history
    /// response never arrives (e.g. the request throws or is dropped).
    private var reconnectLatchTimeoutTask: Task<Void, Never>?
    /// Set to true when daemonDidReconnect fires before conversationId is populated.
    /// Cleared and actioned in the conversationId didSet observer.
    private var needsOfflineFlush: Bool = false
    /// Set to true when reconnecting after an SSE gap while a run was in progress.
    /// Causes `populateFromHistory` to do a full message replace instead of
    /// prepending, so the missed assistant response is displayed.
    private var needsReconnectCatchUp: Bool = false
    /// Snapshot of `pendingMessageIds` captured before clearing on reconnect.
    /// Used by the reconnect catch-up path in `populateFromHistory` to dedup
    /// local messages that were pending when the connection dropped (the live
    /// `pendingMessageIds` is cleared immediately, but the debounced history
    /// reload fires 500ms later).
    private var reconnectPendingSnapshot: [UUID] = []
    /// Called when the SSE stream reconnects while a run was in progress.
    /// The store/restorer registers the conversationId in pendingHistoryByConversationId
    /// and sends a history request so the response is routed back properly.
    public var onReconnectHistoryNeeded: ((_ conversationId: String) -> Void)?
    var pendingUserMessage: String?
    /// The display text (rawText) corresponding to pendingUserMessage.
    /// In voice mode, pendingUserMessage contains the voice-prefixed text while
    /// this stores the original user text used for message-bubble matching.
    var pendingUserMessageDisplayText: String?
    /// Optional callback for sending notifications when tool-use messages complete
    public var onToolCallsComplete: ((_ toolCalls: [ToolCallData]) -> Void)?
    /// Whether the current assistant response was triggered by a voice message.
    public var pendingVoiceMessage: Bool = false
    /// Called when a voice-triggered assistant response completes, with the response text.
    public var onVoiceResponseComplete: ((String) -> Void)?
    /// Called when any assistant response completes, with a summary of the response text.
    public var onResponseComplete: ((String) -> Void)?
    /// Called once when the first complete assistant message arrives during bootstrap.
    /// Passes the reply text so callers can inspect content (e.g. naming intent).
    /// Cleared after firing to ensure it only triggers once.
    public var onFirstAssistantReply: ((String) -> Void)?
    /// Called with each streaming text delta during a voice-triggered response, for real-time TTS.
    public var onVoiceTextDelta: ((String) -> Void)?
    /// When true, messages are prefixed with a concise-response instruction for voice conversations.
    public var isVoiceModeActive: Bool = false
    var pendingUserAttachments: [UserMessageAttachment]?
    /// Stores the last user message that failed to send, enabling retry.
    private(set) var lastFailedMessageText: String? {
        didSet { syncRetryStateToErrorManager() }
    }
    private(set) var lastFailedMessageDisplayText: String?
    private(set) var lastFailedMessageAttachments: [UserMessageAttachment]?
    /// Set only when a send operation (bootstrapConversation or sendUserMessage) fails.
    /// Used by `isRetryableError` to ensure the retry button only appears for
    /// actual send failures, not for unrelated errors (attachment validation,
    /// confirmation response failures, regenerate errors, etc.).
    private(set) var lastFailedSendError: String? {
        didSet { syncRetryStateToErrorManager() }
    }
    /// Stores the text of a message that was blocked by the secret-ingress check.
    /// Set when an error with category "secret_blocked" arrives.
    var secretBlockedMessageText: String? {
        didSet { syncRetryStateToErrorManager() }
    }
    /// Stashed context from the blocked send, so sendAnyway() can reconstruct
    /// the original UserMessageMessage with attachments and surface metadata.
    var secretBlockedAttachments: [UserMessageAttachment]?
    var secretBlockedActiveSurfaceId: String?
    var secretBlockedCurrentPage: String?
    /// Nonce sent with `conversation_create` and echoed back in `conversation_info`.
    /// Used to ensure this ChatViewModel only claims its own session.
    var bootstrapCorrelationId: String?
    /// Conversation type sent with `conversation_create` (e.g. "private").
    /// Set by `createConversationIfNeeded(conversationType:)` and included in the
    /// message so the daemon can persist the correct conversation kind.
    public var conversationType: String?
    /// Skill IDs to pre-activate in the session. Included in the
    /// `conversation_create` request for deterministic skill activation.
    public var preactivatedSkillIds: [String]?
    /// Whether this view model is currently bootstrapping a new session
    /// (conversation_create sent, awaiting conversation_info). Used by ThreadManager
    /// to decide whether it's safe to release the VM on archive.
    public var isBootstrapping: Bool { bootstrapCorrelationId != nil }
    private var messageLoopTask: Task<Void, Never>?
    /// Monotonically increasing ID used to distinguish successive message-loop
    /// tasks so that a cancelled loop's cleanup doesn't clear a newer replacement.
    private var messageLoopGeneration: UInt64 = 0
    var currentAssistantMessageId: UUID?
    /// The trimmed user text that initiated the current assistant turn.
    /// Used to tag the assistant message (e.g. modelList for "/models") without
    /// scanning the whole transcript, which would be fragile under queued messages.
    var currentTurnUserText: String?
    /// Tracks whether the current assistant message has received any text content.
    /// Used to determine `arrivedBeforeText` for each tool call in the message.
    var currentAssistantHasText: Bool = false
    /// Tracks whether the last content block was a tool call, so the next text
    /// delta starts a new segment instead of appending to the previous one.
    var lastContentWasToolCall: Bool = false
    /// When true, incoming deltas are suppressed until the daemon acknowledges
    /// the cancellation (via `generation_cancelled` or `message_complete`).
    // Public (rather than private) so tests can simulate the
    // daemon-acknowledged cancellation state directly.
    public var isCancelling: Bool = false
    /// Maps daemon requestId to the user message UUID in the messages array.
    var requestIdToMessageId: [String: UUID] = [:]
    /// Maps requestId to the currently processing user message UUID after dequeue.
    var activeRequestIdToMessageId: [String: UUID] = [:]
    /// FIFO queue of user message UUIDs awaiting requestId assignment from the daemon.
    var pendingMessageIds: [UUID] = []
    /// Messages deleted locally before the daemon's `message_queued` ack arrived.
    /// Once the ack provides the requestId, the deletion is forwarded to the daemon.
    var pendingLocalDeletions: Set<UUID> = []
    /// Tracks the current in-flight suggestion request so stale responses are ignored.
    var pendingSuggestionRequestId: String?

    // MARK: - Streaming Delta Throttle

    /// Interval between flushing buffered streaming text deltas to the
    /// `@Published messages` array.  Coalescing multiple token deltas
    /// into a single array mutation dramatically reduces SwiftUI
    /// view-graph invalidation frequency during streaming.
    static let streamingFlushInterval: TimeInterval = 0.1 // 100 ms

    /// Buffered text that has not yet been flushed to `messages`.
    var streamingDeltaBuffer: String = ""
    /// Scheduled flush work item; cancelled and re-created on each delta.
    var streamingFlushTask: Task<Void, Never>?

    // MARK: - Partial Output Coalescing

    /// Buffered partial-output chunks keyed by "messageUUID:tcIndex".
    /// Uses stable message UUID instead of positional index so the buffer
    /// survives message-list mutations (pagination prepend, memory trim).
    var partialOutputBuffer: [String: (messageId: UUID, tcIndex: Int, content: String)] = [:]
    /// Scheduled flush task for coalescing partial-output writes.
    var partialOutputFlushTask: Task<Void, Never>?

    /// Safety timer that force-resets the UI if the daemon never acknowledges
    /// a cancel request (e.g. a stuck tool blocks the generation_cancelled event).
    var cancelTimeoutTask: Task<Void, Never>?

    /// Saved text from a queued message that should be auto-sent after cancellation completes.
    var pendingSendDirectText: String?
    /// Saved attachments from a queued message that should be auto-sent after cancellation completes.
    var pendingSendDirectAttachments: [ChatAttachment]?
    /// Saved skill invocation from a queued message for send-direct dispatch.
    var pendingSendDirectSkillInvocation: SkillInvocationData?

    /// Timestamp of the most recent `toolUseStart` event received by this view model.
    /// Used by ThreadManager to route `confirmationRequest` messages to the correct
    /// ChatViewModel when multiple threads have active sessions.
    public var lastToolUseReceivedAt: Date?

    /// Monotonically increasing version counter for server-authoritative activity state.
    /// Used to ignore stale `assistant_activity_state` events.
    var lastActivityVersion: Int = 0

    /// Called when an inline confirmation is responded to, so the floating panel can be dismissed.
    /// Parameters: (requestId, decision)
    public var onInlineConfirmationResponse: ((String, String) -> Void)?

    /// Called to determine whether this ChatViewModel should accept a `confirmationRequest`.
    /// Set by ThreadManager to coordinate routing when multiple ChatViewModels are active.
    public var shouldAcceptConfirmation: (() -> Bool)?

    /// Called when the daemon sends a `watch_started` message to begin a watch session.
    /// The closure receives the WatchStartedMessage and the DaemonClient so the macOS
    /// layer can create and start a WatchSession.
    public var onWatchStarted: ((WatchStartedMessage, any DaemonClientProtocol) -> Void)?

    /// Called when the daemon sends a `watch_complete_request` to stop the active watch session.
    public var onWatchCompleteRequest: ((WatchCompleteRequestMessage) -> Void)?

    /// Called when the user taps the stop button on the watch progress UI.
    /// The macOS layer should cancel the WatchSession and send a cancel to the daemon.
    public var onStopWatch: (() -> Void)?

    /// Called when the daemon assigns a session ID to this chat (via conversation_info).
    /// Used by ThreadManager to backfill ThreadModel.conversationId for new threads.
    public var onConversationCreated: ((String) -> Void)?

    /// Called once when the first user message is sent, with the message text.
    /// Used by ThreadManager to auto-title the thread.
    public var onFirstUserMessage: ((String) -> Void)?

    /// Called every time a user message is sent. Used by ThreadManager to
    /// bump the thread's lastInteractedAt so it rises to the top of the list.
    public var onUserMessageSent: (() -> Void)?

    /// Whether this view model has had its history loaded from the daemon.
    public var isHistoryLoaded: Bool = false

    /// True while `populateFromHistory` is actively inserting messages.
    /// Observers can check this to avoid treating the history hydration as new activity.
    public internal(set) var isLoadingHistory: Bool = false

    // MARK: - Message Pagination

    /// Page size for chat message display; older messages are loaded in this increment.
    public static let messagePageSize = 50

    /// Number of messages currently revealed at the top of the conversation.
    /// The view slices `messages` to `messages.suffix(displayedMessageCount)`.
    /// Grows by `messagePageSize` each time the user scrolls to the top.
    /// Set to `Int.max` when the user has loaded all history ("show all" mode), so that new
    /// incoming messages don't collapse the window back to `suffix(messagePageSize)`.
    @Published public var displayedMessageCount: Int = messagePageSize

    /// True while a previous-page load is in progress (brief async delay for UX).
    @Published public var isLoadingMoreMessages: Bool = false

    /// Timeout task that logs a warning if the daemon takes too long to respond
    /// to a pagination request. The flag is intentionally NOT cleared here —
    /// see the comment in `loadPreviousMessagePage()` for rationale.
    private var loadMoreTimeoutTask: Task<Void, Never>?

    /// The subset of messages that are actually displayed (excludes subagent notifications
    /// and other UI-only messages that the view filters before rendering).
    /// Cached as a stored @Published property to avoid O(n) filter on every access
    /// during streaming (which can be dozens of times per second).
    @Published public private(set) var displayedMessages: [ChatMessage] = []

    /// Recompute and cache the displayedMessages from the current messages array.
    /// Call this after any mutation to messages.
    private func updateDisplayedMessages() {
        displayedMessages = messages.filter { !$0.isSubagentNotification && !$0.isHidden }
    }

    // MARK: - Daemon History Pagination

    /// Timestamp of the oldest loaded message (ms since epoch). Used as the
    /// `beforeTimestamp` cursor when fetching the next older page from the daemon.
    public var historyCursor: Double?

    /// Whether the daemon has indicated that older messages exist beyond the
    /// currently loaded page. Falls back to `false` for older daemons that don't
    /// send `hasMore` in the history response.
    @Published public var hasMoreHistory: Bool = false

    // MARK: - BTW Side-Chain State

    /// The accumulated response text from a /btw side-chain query, or nil when inactive.
    @Published public var btwResponse: String?
    /// True while a /btw request is in flight.
    @Published public var btwLoading: Bool = false
    /// The in-flight btw streaming task, stored for cancellation.
    private var btwTask: Task<Void, Never>?

    // MARK: - Empty-State Greeting

    /// A daemon-generated greeting shown when the conversation is empty, or nil before generation.
    @Published public var emptyStateGreeting: String? = nil
    /// True while a greeting is being streamed from the daemon.
    @Published public var isGeneratingGreeting: Bool = false
    /// The in-flight greeting streaming task, stored for cancellation.
    private var greetingTask: Task<Void, Never>?

    private static let fallbackGreetings = [
        "What are we working on?",
        "I'm here whenever you need me.",
        "What's on your mind?",
        "Let's make something happen.",
        "Ready when you are.",
    ]

    /// Whether there are more messages above the current display window.
    /// True when either:
    ///   1. There are locally loaded messages outside the current display suffix, OR
    ///   2. The daemon has older pages available to fetch.
    /// When `displayedMessageCount == Int.max` (show-all mode), only daemon pages apply.
    public var hasMoreMessages: Bool {
        (displayedMessageCount < displayedMessages.count) || hasMoreHistory
    }

    /// Called when `loadPreviousMessagePage` needs to fetch an older page from the
    /// daemon. The session restorer sets this so the daemon client request is
    /// routed through the same pending-history tracking used for initial loads.
    public var onLoadMoreHistory: ((_ conversationId: String, _ beforeTimestamp: Double) -> Void)?

    /// Load the previous page of messages by expanding the display window.
    /// When all locally loaded messages are already visible and the daemon has
    /// more history available, requests the next older page from the daemon.
    /// Returns `true` if there were additional messages to reveal or a fetch was started.
    @discardableResult
    public func loadPreviousMessagePage() async -> Bool {
        guard hasMoreMessages, !isLoadingMoreMessages else { return false }

        // If the local display window can still grow, expand it first.
        let locallyHasMore = displayedMessageCount < displayedMessages.count
        if locallyHasMore {
            isLoadingMoreMessages = true
            // Brief delay so the loading indicator is visible before the list shifts.
            try? await Task.sleep(nanoseconds: 150_000_000)
            let next = displayedMessageCount + Self.messagePageSize
            let total = displayedMessages.count
            // When all messages fit within the expanded window, switch to show-all mode
            // (Int.max) so future incoming messages don't shrink the visible history back
            // to a suffix window — the regression described in the parent PR.
            displayedMessageCount = next >= total ? Int.max : next
            isLoadingMoreMessages = false
            return true
        }

        // All local messages are visible — fetch the next page from the daemon.
        guard hasMoreHistory, let cursor = historyCursor, let conversationId else { return false }
        isLoadingMoreMessages = true
        // Safety timeout: log a warning if the daemon is slow, but do NOT
        // clear isLoadingMoreMessages here. Callers (ThreadConversationRestorer,
        // IOSConversationStore) use `vm.isLoadingMoreMessages` to decide whether
        // a history response is a pagination load. If the timeout clears the
        // flag before the response arrives, the late-but-valid response is
        // misclassified as an initial load and replaces all messages instead
        // of prepending. The flag is properly cleared by populateFromHistory
        // when the response arrives, or by reconnect/thread-switch logic if
        // the daemon disconnects.
        loadMoreTimeoutTask?.cancel()
        loadMoreTimeoutTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 30_000_000_000) // 30 seconds
            guard let self, !Task.isCancelled, self.isLoadingMoreMessages else { return }
            log.warning("Pagination request still pending after 30s — daemon may be unresponsive")
        }
        onLoadMoreHistory?(conversationId, cursor)
        // The loading indicator is cleared by populateFromHistory when the response arrives.
        return true
    }

    /// Reset pagination when the thread switches or history is reloaded.
    public func resetMessagePagination() {
        displayedMessageCount = Self.messagePageSize
        historyCursor = nil
        hasMoreHistory = false
        loadMoreTimeoutTask?.cancel()
        loadMoreTimeoutTask = nil
        isLoadingMoreMessages = false
    }

    // MARK: - On-Demand Content Rehydration

    /// Fetch full (untruncated) content for a message that was loaded with truncated
    /// text/tool results or had its heavy content stripped. No-ops if the message is
    /// not found or doesn't need rehydration.
    public func rehydrateMessage(id: UUID) {
        guard let idx = messages.firstIndex(where: { $0.id == id }),
              messages[idx].wasTruncated || messages[idx].isContentStripped,
              let conversationId = conversationId,
              let daemonMessageId = messages[idx].daemonMessageId else { return }
        do {
            try daemonClient.send(MessageContentRequest(type: "message_content_request", conversationId: conversationId, messageId: daemonMessageId))
        } catch {
            log.error("Failed to send message_content_request: \(error)")
        }
    }

    /// Persist a captured preview image into the ChatMessage model so it survives thread switches.
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
        // displayedMessages is updated automatically via the messageManager.$messages
        // publisher subscription set up in init.
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
        // Only mark history as unloaded if there's a session to reload from.
        // Threads without a session (new, empty) have nothing to fetch —
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

    public init(daemonClient: any DaemonClientProtocol, onToolCallsComplete: ((_ toolCalls: [ToolCallData]) -> Void)? = nil) {
        self.daemonClient = daemonClient
        self.onToolCallsComplete = onToolCallsComplete

        // Coalesce sub-manager objectWillChange signals through a single
        // delayed publish. During streaming, sub-managers may fire dozens of
        // objectWillChange events per second (each @Published property
        // mutation triggers one). Instead of forwarding each immediately —
        // which invalidates the entire view tree every time — we batch them
        // into a single objectWillChange per 100ms window. Views still
        // update promptly, but the SwiftUI diffing cost drops dramatically.

        // Keep displayedMessages in sync with messages via publisher subscription.
        // This catches every mutation site (current and future) without requiring
        // manual updateDisplayedMessages() calls at each one.
        //
        // Two correctness/perf fixes applied here:
        // 1. Use the delivered `newMessages` value directly rather than reading
        //    `self.messages` inside the sink. @Published fires during willSet, so
        //    the stored property still holds the OLD value when the subscriber runs
        //    — reading it caused displayedMessages to lag one mutation behind.
        // 2. Throttle to 100ms so displayedMessages (and any SwiftUI views observing
        //    it) only refresh at most every 100ms, matching the coalesced publish
        //    window used for the rest of the view model.
        messageManager.$messages
            .throttle(for: .milliseconds(100), scheduler: RunLoop.main, latest: true)
            .sink { [weak self] newMessages in
                self?.displayedMessages = newMessages.filter { !$0.isSubagentNotification && !$0.isHidden }
            }
            .store(in: &cancellables)

        messageManager.objectWillChange
            .sink { [weak self] _ in
                self?.scheduleCoalescedPublish()
                #if DEBUG
                self?.trackPublish(source: "messageManager")
                #endif
            }
            .store(in: &cancellables)
        attachmentManager.objectWillChange
            .sink { [weak self] _ in
                self?.scheduleCoalescedPublish()
                #if DEBUG
                self?.trackPublish(source: "attachmentManager")
                #endif
            }
            .store(in: &cancellables)
        errorManager.objectWillChange
            .sink { [weak self] _ in
                self?.scheduleCoalescedPublish()
                #if DEBUG
                self?.trackPublish(source: "errorManager")
                #endif
            }
            .store(in: &cancellables)

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

                // If we already have a session ID, flush immediately. Otherwise
                // defer: conversationId's didSet will trigger flushOfflineQueue() once
                // the session is restored from history (cold-start reconnect case).
                if self?.conversationId != nil {
                    self?.flushOfflineQueue()
                } else {
                    self?.needsOfflineFlush = true
                }
            }
        }

        // Listen for captured app preview images and persist them into the
        // ChatMessage model so they survive thread switches and history reloads.
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
                // displayedMessages is updated automatically via $messages sink.
                self.displayedMessageCount = Self.messagePageSize
            }
        }
        source.resume()
        self.memoryPressureSource = source
    }

    // MARK: - Deep Link

    /// Check for a buffered deep-link message and apply it to `inputText`.
    /// Called by the view layer when this `ChatViewModel` becomes the
    /// active/visible thread, ensuring only one VM ever consumes the message.
    public func consumeDeepLinkIfNeeded() {
        guard let message = DeepLinkManager.pendingMessage else { return }
        DeepLinkManager.pendingMessage = nil
        inputText = message
    }

    // MARK: - Sending

    public func sendMessage(hidden: Bool = false) {
        let rawText = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = rawText
        let hasAttachments = !pendingAttachments.isEmpty
        let hasSkillInvocation = pendingSkillInvocation != nil
        guard !text.isEmpty || hasAttachments || hasSkillInvocation else { return }

        // Intercept /btw side-chain messages before the normal send path.
        if text.hasPrefix("/btw ") {
            let question = String(text.dropFirst(5)).trimmingCharacters(in: .whitespaces)
            inputText = ""
            pendingAttachments = []
            pendingSkillInvocation = nil
            flushCoalescedPublish()
            sendBtwMessage(question: question)
            return
        }

        // Confirmation state is now server-authoritative: the daemon emits
        // `confirmation_state_changed` events for all resolution paths.
        // No client-side pessimistic denial is needed.

        // When "/model" or "/models" is sent, refresh model state so the picker/table has fresh data
        if (text == "/model" || text == "/models") && !hasSkillInvocation {
            do {
                try daemonClient.send(ModelGetRequestMessage())
            } catch {
                log.error("Failed to send ModelGetRequest: \(error)")
            }
        }

        // Fire auto-title callback on the first user message (skip slash commands
        // like /model so the thread title isn't set to a command string)
        if !rawText.isEmpty, !rawText.hasPrefix("/"), let callback = onFirstUserMessage {
            onFirstUserMessage = nil
            callback(rawText)
        }

        // Notify ThreadManager so the thread rises to the top of the list
        onUserMessageSent?()

        // Block rapid-fire only when bootstrapping with a queued message.
        // When a message-less bootstrap is in flight (e.g. private thread
        // pre-allocation), adopt the user's message as the pending message
        // so it gets sent when conversation_info arrives instead of being dropped.
        if (isSending || isBootstrapping) && conversationId == nil {
            if pendingUserMessage == nil {
                isSending = true
                let attachments = pendingAttachments
                pendingAttachments = []
                pendingUserMessage = text
                pendingUserMessageDisplayText = rawText
                pendingUserAttachments = attachments.isEmpty ? nil : attachments.map {
                    UserMessageAttachment(filename: $0.filename, mimeType: $0.mimeType, data: $0.data, extractedText: nil)
                }
                isThinking = true
                var userMsg = ChatMessage(role: .user, text: rawText, status: .sent, skillInvocation: pendingSkillInvocation, attachments: attachments)
                userMsg.isHidden = hidden
                messages.append(userMsg)
                pendingSkillInvocation = nil
                inputText = ""
                suggestion = nil
                pendingSuggestionRequestId = nil
                errorText = nil
                conversationError = nil
                lastFailedMessageText = nil
                lastFailedMessageDisplayText = nil
                lastFailedMessageAttachments = nil
                lastFailedSendError = nil
                connectionDiagnosticHint = nil
                secretBlockedMessageText = nil
                secretBlockedAttachments = nil
                secretBlockedActiveSurfaceId = nil
                secretBlockedCurrentPage = nil
                currentTurnUserText = rawText
                flushCoalescedPublish()
                return
            }
            pendingSkillInvocation = nil
            inputText = ""
            pendingAttachments = []
            flushCoalescedPublish()
            return
        }

        // Snapshot and clear pending attachments
        let attachments = pendingAttachments
        pendingAttachments = []

        let isModelCommand = text == "/model" || text == "/models" || text.hasPrefix("/model ")
        let isWorkspaceRefinement = activeSurfaceId != nil && !isChatDockedToSide && !isModelCommand

        let willBeQueued = isSending && conversationId != nil
        var queuedMessageId: UUID?
        if !isWorkspaceRefinement {
            let status: ChatMessageStatus = willBeQueued ? .queued(position: 0) : .sent
            var userMessage = ChatMessage(role: .user, text: rawText, status: status, skillInvocation: pendingSkillInvocation, attachments: attachments)
            userMessage.isHidden = hidden
            messages.append(userMessage)
            if willBeQueued {
                pendingMessageIds.append(userMessage.id)
                queuedMessageId = userMessage.id
            }
        } else {
            isWorkspaceRefinementInFlight = true
            refinementMessagePreview = text
            refinementStreamingText = nil
            refinementTextBuffer = ""
            refinementReceivedSurfaceUpdate = false
            refinementFailureText = nil
            refinementFailureDismissTask?.cancel()
        }
        pendingSkillInvocation = nil
        inputText = ""
        suggestion = nil
        pendingSuggestionRequestId = nil
        errorText = nil
        conversationError = nil
        lastFailedMessageText = nil
        lastFailedMessageDisplayText = nil
        lastFailedMessageAttachments = nil
        lastFailedSendError = nil
        connectionDiagnosticHint = nil
        secretBlockedMessageText = nil
        secretBlockedAttachments = nil
        secretBlockedActiveSurfaceId = nil
        secretBlockedCurrentPage = nil
        flushCoalescedPublish()

        let messageAttachments: [UserMessageAttachment]? = attachments.isEmpty ? nil : attachments.map {
            UserMessageAttachment(filename: $0.filename, mimeType: $0.mimeType, data: $0.data, extractedText: nil)
        }

        // Track the user text for this turn so assistantTextDelta can tag the
        // response correctly (e.g. modelList for "/models") without scanning the
        // whole transcript. For queued messages this is set in messageDequeued.
        if !willBeQueued {
            currentTurnUserText = rawText
        }

        if conversationId == nil {
            // First message: need to bootstrap session
            pendingUserMessageDisplayText = rawText
            bootstrapConversation(userMessage: text, attachments: messageAttachments)
        } else {
            // Subsequent messages: send directly (daemon queues if busy)
            sendUserMessage(text, displayText: rawText, attachments: messageAttachments, queuedMessageId: queuedMessageId)
        }
    }

    // MARK: - BTW Side-Chain

    /// Send a /btw side-chain question and stream the response into `btwResponse`.
    public func sendBtwMessage(question: String) {
        guard !question.isEmpty else { return }

        // Cancel any in-flight btw task to prevent interleaved deltas.
        btwTask?.cancel()

        btwLoading = true
        btwResponse = ""

        btwTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let stream = self.daemonClient.sendBtwMessage(
                    content: question,
                    conversationKey: self.conversationId ?? ""
                )
                for try await delta in stream {
                    guard !Task.isCancelled else { return }
                    self.btwResponse = (self.btwResponse ?? "") + delta
                }
            } catch is CancellationError {
                // Stream was cancelled via dismiss — no error to show.
            } catch {
                guard !Task.isCancelled else { return }
                self.btwResponse = "Failed to get response: \(error.localizedDescription)"
            }
            guard !Task.isCancelled else { return }
            self.btwLoading = false
        }
    }

    /// Clear btw side-chain state and cancel any in-flight stream.
    public func dismissBtw() {
        btwTask?.cancel()
        btwTask = nil
        btwResponse = nil
        btwLoading = false
    }

    // MARK: - Empty-State Greeting Generation

    /// Stream a short, personality-matched greeting from the daemon for the empty conversation state.
    /// Each call cancels any in-flight generation and starts fresh. On error, falls back to a
    /// random default greeting so the UI always receives a value.
    public func generateGreeting() {
        greetingTask?.cancel()
        emptyStateGreeting = nil
        isGeneratingGreeting = true

        greetingTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let key = "greeting-\(UUID().uuidString)"
            var result = ""
            do {
                let stream = self.daemonClient.sendBtwMessage(
                    content: "Generate a short, casual greeting for when the user opens a new conversation (under 8 words, like \"Ready when you are.\" or \"What's on your mind?\"). Match your personality. Output ONLY the greeting, nothing else.",
                    conversationKey: key
                )
                for try await delta in stream {
                    guard !Task.isCancelled else { return }
                    result += delta
                }
                guard !Task.isCancelled else { return }
                self.emptyStateGreeting = result.isEmpty
                    ? Self.fallbackGreetings.randomElement()!
                    : result
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                self.emptyStateGreeting = Self.fallbackGreetings.randomElement()!
            }
            self.isGeneratingGreeting = false
        }
    }

    private func bootstrapConversation(userMessage: String?, attachments: [UserMessageAttachment]?) {
        // Only set sending/thinking indicators when there's an actual user
        // message; message-less session creates (e.g. private thread
        // pre-allocation) are silent and shouldn't affect UI state.
        if userMessage != nil {
            isSending = true
            isThinking = true
        }
        pendingUserMessage = userMessage
        pendingUserAttachments = attachments

        // Generate a unique correlation ID so this ChatViewModel only claims
        // the conversation_info response that belongs to its own conversation_create request.
        let correlationId = UUID().uuidString
        self.bootstrapCorrelationId = correlationId

        Task { @MainActor in
            // Ensure daemon connection
            if !daemonClient.isConnected {
                do {
                    try await daemonClient.connect()
                } catch {
                    log.error("Failed to connect to daemon: \(error.localizedDescription)")
                    self.isThinking = false
                    self.isSending = false
                    self.bootstrapCorrelationId = nil
                    self.lastFailedMessageText = self.pendingUserMessage
                    self.lastFailedMessageDisplayText = self.pendingUserMessageDisplayText
                    self.lastFailedMessageAttachments = self.pendingUserAttachments
                    self.lastFailedSendError = "Failed to connect to the assistant."
                    self.connectionDiagnosticHint = Self.connectionDiagnosticHint(for: error)
                    self.pendingUserMessage = nil
                    self.pendingUserMessageDisplayText = nil
                    self.pendingUserAttachments = nil
                    self.errorText = self.lastFailedSendError
                    return
                }
            }

            // Subscribe to daemon stream
            self.startMessageLoop()

            // Send conversation_create with correlation ID and thread type
            do {
                try daemonClient.send(ConversationCreateMessage(title: nil, correlationId: correlationId, conversationType: self.conversationType, preactivatedSkillIds: self.preactivatedSkillIds))
                // Clear one-shot preactivated skills so they don't leak into a
                // later session if this bootstrap is interrupted before completion.
                self.preactivatedSkillIds = nil
            } catch {
                log.error("Failed to send conversation_create: \(error.localizedDescription)")
                self.isThinking = false
                self.isSending = false
                self.bootstrapCorrelationId = nil
                self.lastFailedMessageText = self.pendingUserMessage
                self.lastFailedMessageDisplayText = self.pendingUserMessageDisplayText
                self.lastFailedMessageAttachments = self.pendingUserAttachments
                self.lastFailedSendError = "Failed to create session."
                self.pendingUserMessage = nil
                self.pendingUserMessageDisplayText = nil
                self.pendingUserAttachments = nil
                self.errorText = self.lastFailedSendError
            }
        }
    }

    private func sendUserMessage(_ text: String, displayText: String? = nil, attachments: [UserMessageAttachment]? = nil, queuedMessageId: UUID? = nil) {
        guard let conversationId else { return }

        // Check connectivity before entering sending state so the UI
        // doesn't get stuck with isSending/isThinking = true when the
        // daemon has disconnected between turns.
        guard daemonClient.isConnected else {
            log.error("Cannot send user_message: daemon not connected")

            // Buffer the primary (non-queued-retry) send in the offline queue
            // instead of surfacing an error. The message stays visible with a
            // "pending" indicator and is flushed automatically on reconnect.
            if queuedMessageId == nil {
                log.info("Buffering message in offline queue (session: \(conversationId))")
                OfflineMessageQueue.shared.enqueue(conversationId: conversationId, text: text, displayText: displayText, attachments: attachments)
                // Mark the corresponding chat message as offline-pending so the UI
                // can show a visual indicator. Find the last user message with this
                // text — it is the one just appended by sendMessage().
                let matchText = displayText ?? text
                if let idx = messages.indices.reversed().first(where: { messages[$0].role == .user && messages[$0].text == matchText }) {
                    messages[idx].status = .pendingOffline
                }
                // Don't show the error banner — the pending indicator on the bubble
                // communicates the offline state without interrupting the conversation.
                return
            }

            // Always track the failed message for retry support.
            lastFailedMessageText = text
            lastFailedMessageDisplayText = displayText
            lastFailedMessageAttachments = attachments
            // Only update UI error state for the primary send (not a queued
            // retry). A queued retry failing must not clobber the active turn's
            // isSending/isThinking flags or show an error banner over it.
            if queuedMessageId == nil {
                lastFailedSendError = "Failed to connect to the assistant."
                errorText = lastFailedSendError
            }
            // Remove the queued message ID to prevent stale FIFO entries
            if let queuedMessageId {
                pendingMessageIds.removeAll { $0 == queuedMessageId }
                // Revert status so the message doesn't appear permanently queued
                if let idx = messages.firstIndex(where: { $0.id == queuedMessageId }) {
                    messages[idx].status = .sent
                }
            }
            return
        }

        isSending = true
        // Only show "Thinking" for the primary send. Queued messages will
        // set isThinking = true when they are dequeued for processing.
        if queuedMessageId == nil {
            isThinking = true
        }

        // Make sure we're listening
        if messageLoopTask == nil {
            startMessageLoop()
        }

        do {
            let pttMeta = Self.currentPttMetadata()
            try daemonClient.send(UserMessageMessage(
                conversationId: conversationId,
                content: text,
                attachments: attachments,
                activeSurfaceId: activeSurfaceId,
                currentPage: activeSurfaceId != nil ? currentPage : nil,
                pttActivationKey: pttMeta.activationKey,
                microphonePermissionGranted: pttMeta.microphonePermissionGranted
            ))
        } catch {
            log.error("Failed to send user_message: \(error.localizedDescription)")
            // Always track the failed message for retry support.
            lastFailedMessageText = text
            lastFailedMessageDisplayText = displayText
            lastFailedMessageAttachments = attachments
            // Only update UI error state for the primary send (not a queued
            // retry). A queued retry failing must not clobber the active turn's
            // isSending/isThinking flags or show an error banner over it.
            if queuedMessageId == nil {
                isSending = false
                isThinking = false
                lastFailedSendError = "Failed to send message."
                errorText = lastFailedSendError
            }
            // Remove the queued message ID to prevent stale FIFO entries
            if let queuedMessageId {
                pendingMessageIds.removeAll { $0 == queuedMessageId }
                // Revert status so the message doesn't appear permanently queued
                if let idx = messages.firstIndex(where: { $0.id == queuedMessageId }) {
                    messages[idx].status = .sent
                }
            }
        }
    }

    // MARK: - Offline Queue Flush

    /// Drain the persistent offline queue and send all buffered messages in order.
    ///
    /// Called automatically when the daemon reconnects. Only flushes messages whose
    /// conversationId matches this view model's current conversation, so concurrent view models
    /// on different conversations don't interfere with each other's queued messages.
    ///
    /// Messages are removed from persistent storage one at a time, immediately before
    /// each send, so a crash mid-flush leaves unprocessed messages intact rather than
    /// silently dropping them.
    func flushOfflineQueue() {
        let queue = OfflineMessageQueue.shared
        guard !queue.isEmpty else { return }

        guard let currentConversationId = conversationId else {
            // No session yet — defer until conversationId is populated.
            needsOfflineFlush = true
            return
        }

        // Read the queue contents without clearing. Filter for this session only;
        // other sessions' messages stay in the persistent store for their own VMs.
        let mine = queue.allMessages.filter { $0.conversationId == currentConversationId }
        guard !mine.isEmpty else { return }

        log.info("Flushing \(mine.count) offline-queued message(s) for session \(currentConversationId)")

        // Update message bubbles: clear pendingOffline status so they show as sent.
        for queued in mine {
            let matchText = queued.displayText ?? queued.text
            if let idx = messages.indices.reversed().first(where: {
                messages[$0].role == .user
                    && messages[$0].text == matchText
                    && messages[$0].status == .pendingOffline
            }) {
                messages[idx].status = .sent
            }
        }

        // Remove each message from persistent storage and send it. Removal happens
        // before the send attempt so a successful removal + failed send is recoverable
        // via the normal error retry path, rather than duplicating on the next flush.
        for queued in mine {
            queue.remove(id: queued.id)
            sendUserMessage(queued.text, displayText: queued.displayText, attachments: queued.messageAttachments)
        }
    }

    public func startMessageLoop() {
        messageLoopTask?.cancel()
        let messageStream = daemonClient.subscribe()

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

    /// Start the daemon message stream if this chat has a bound session and
    /// no active loop yet.
    public func ensureMessageLoopStarted() {
        guard conversationId != nil, messageLoopTask == nil else { return }
        startMessageLoop()
    }

    /// Send a message to the daemon without showing a user bubble in the chat.
    /// Used for automated actions like inline model picker selections.
    /// Returns `true` if the message was sent (or a session bootstrap was started),
    /// `false` if the message was silently dropped (e.g. bootstrap already in flight).
    @discardableResult
    public func sendSilently(_ text: String) -> Bool {
        // Don't re-enter bootstrap if a session creation is already in progress —
        // that would overwrite pendingUserMessage and orphan the in-flight session.
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

    /// Create a daemon session immediately, without a user message.
    /// Used by private threads that need a persistent session ID right away
    /// (e.g. to store the thread in the database before the user types anything).
    /// No-op if a session already exists or a bootstrap is already in flight.
    public func createConversationIfNeeded(conversationType: String? = nil) {
        guard conversationId == nil, !isBootstrapping else { return }
        if let conversationType {
            self.conversationType = conversationType
        }
        bootstrapConversation(userMessage: nil, attachments: nil)
    }

    // MARK: - Model

    /// Switch the active model via the daemon's `model_set` command.
    public func setModel(_ modelId: String) {
        // Ensure the message loop is running so we receive the model_info response.
        // VMs restored with an existing conversationId may not have started it yet.
        if messageLoopTask == nil {
            startMessageLoop()
        }
        do {
            try daemonClient.send(ModelSetRequestMessage(model: modelId))
        } catch {
            log.error("Failed to send ModelSetRequest: \(error)")
        }
    }

    // MARK: - Actions

    public func sendSurfaceAction(surfaceId: String, actionId: String, data: [String: AnyCodable]? = nil) {
        // For relay_prompt / agent_prompt actions from history-restored surfaces,
        // send the prompt as a regular message instead of a surface action.
        // This avoids requiring in-memory surface state on the daemon (which is
        // lost after restart) and ensures the full message send pipeline runs
        // (session creation, hub publisher setup, SSE event delivery).
        let isRelay = actionId == "relay_prompt" || actionId == "agent_prompt"
        if isRelay, let prompt = data?["prompt"]?.value as? String, !prompt.isEmpty {
            _ = sendSilently(prompt)
            return
        }

        guard let conversationId else { return }
        let msg = UiSurfaceActionMessage(
            conversationId: conversationId,
            surfaceId: surfaceId,
            actionId: actionId,
            data: data
        )
        do {
            try daemonClient.send(msg)
        } catch {
            log.error("Failed to send UiSurfaceAction: \(error)")
        }
    }

    // MARK: - Surface Refetch

    /// Lazily created manager that serializes surface content fetches.
    private lazy var surfaceRefetchManager = SurfaceRefetchManager { [weak self] surfaceId, conversationId in
        guard let self else { return nil }
        return await self.daemonClient.fetchSurfaceData(surfaceId: surfaceId, conversationId: conversationId)
    }

    /// In-flight refetch tasks, keyed by surface ID for cancellation.
    private var refetchTasks: [String: Task<Void, Never>] = [:]

    /// Re-fetch the full payload for a stripped surface and replace it in the message list.
    public func refetchStrippedSurface(surfaceId: String, conversationId: String) {
        guard refetchTasks[surfaceId] == nil else { return }
        refetchTasks[surfaceId] = Task { @MainActor [weak self] in
            defer { self?.refetchTasks.removeValue(forKey: surfaceId) }
            guard let self else { return }
            let result = await self.surfaceRefetchManager.enqueue(surfaceId: surfaceId, conversationId: conversationId)
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
    }

    /// Cancel all in-flight surface refetch tasks and reset the manager's
    /// failure counts so surfaces can be retried in the new session.
    private func cancelRefetchTasks() {
        for task in refetchTasks.values { task.cancel() }
        refetchTasks.removeAll()
        Task { await surfaceRefetchManager.resetFailureCounts() }
    }

    /// Cancel the queued user message without clearing `bootstrapCorrelationId`.
    /// Used when archiving a thread before conversation_info arrives: we want to
    /// discard the pending message (so it isn't sent once the session is claimed)
    /// but preserve the correlation ID so the VM only claims its own session.
    public func cancelPendingMessage() {
        pendingUserMessage = nil
        pendingUserMessageDisplayText = nil
        pendingUserAttachments = nil
        isWorkspaceRefinementInFlight = false
        refinementMessagePreview = nil
        refinementStreamingText = nil
        isThinking = false
        isSending = false
    }

    public func stopGenerating() {
        guard isSending else { return }

        pendingVoiceMessage = false

        // If we're still bootstrapping (no session yet), cancel locally:
        // discard the pending message so it won't be sent when conversation_info
        // arrives, and reset UI state immediately since there's nothing to
        // cancel on the daemon side.
        if conversationId == nil {
            pendingUserMessage = nil
            pendingUserMessageDisplayText = nil
            pendingUserAttachments = nil
            bootstrapCorrelationId = nil
            isWorkspaceRefinementInFlight = false
            refinementMessagePreview = nil
            refinementStreamingText = nil
            isThinking = false
            isSending = false
            dispatchPendingSendDirect()
            return
        }

        // If the daemon is not connected, the cancel message cannot reach it
        // and no acknowledgment (generation_cancelled / message_complete) will
        // arrive.  Reset all transient state immediately to avoid a permanently
        // stuck isCancelling flag that would suppress future assistant deltas.
        guard daemonClient.isConnected else {
            log.warning("Cannot send cancel: daemon not connected")
            isWorkspaceRefinementInFlight = false
            refinementMessagePreview = nil
            refinementStreamingText = nil
            cancelledDuringRefinement = false
            isSending = false
            isThinking = false
            isCancelling = false
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                messages[index].isStreaming = false
                messages[index].streamingCodePreview = nil
                messages[index].streamingCodeToolName = nil
                for j in messages[index].toolCalls.indices where !messages[index].toolCalls[j].isComplete {
                    messages[index].toolCalls[j].isComplete = true
                    messages[index].toolCalls[j].completedAt = Date()
                }
            }
            currentAssistantMessageId = nil
            currentTurnUserText = nil
            currentAssistantHasText = false
            lastContentWasToolCall = false
            discardStreamingBuffer()
            discardPartialOutputBuffer()
            pendingQueuedCount = 0
            pendingMessageIds = []
            requestIdToMessageId = [:]
            activeRequestIdToMessageId = [:]
            pendingLocalDeletions.removeAll()
            for i in messages.indices {
                if case .queued = messages[i].status, messages[i].role == .user {
                    messages[i].status = .sent
                } else if messages[i].role == .user && messages[i].status == .processing {
                    messages[i].status = .sent
                }
            }
            dispatchPendingSendDirect()
            return
        }

        do {
            try daemonClient.send(CancelMessage(conversationId: conversationId!))
        } catch {
            log.error("Failed to send cancel: \(error.localizedDescription)")
            // Cancel failed to send, so no generationCancelled or
            // messageComplete event will arrive from the daemon. Reset
            // all transient state now to avoid stuck UI.
            isWorkspaceRefinementInFlight = false
            refinementMessagePreview = nil
            refinementStreamingText = nil
            cancelledDuringRefinement = false
            isSending = false
            isThinking = false
            isCancelling = false
            // Mark current assistant message as stopped
            if let existingId = currentAssistantMessageId,
               let index = messages.firstIndex(where: { $0.id == existingId }) {
                messages[index].isStreaming = false
                messages[index].streamingCodePreview = nil
                messages[index].streamingCodeToolName = nil
                for j in messages[index].toolCalls.indices where !messages[index].toolCalls[j].isComplete {
                    messages[index].toolCalls[j].isComplete = true
                    messages[index].toolCalls[j].completedAt = Date()
                }
            }
            currentAssistantMessageId = nil
            currentTurnUserText = nil
            currentAssistantHasText = false
            lastContentWasToolCall = false
            discardStreamingBuffer()
            discardPartialOutputBuffer()
            pendingQueuedCount = 0
            pendingMessageIds = []
            requestIdToMessageId = [:]
            activeRequestIdToMessageId = [:]
            pendingLocalDeletions.removeAll()
            // Reset processing/queued messages to sent
            for i in messages.indices {
                if case .queued = messages[i].status, messages[i].role == .user {
                    messages[i].status = .sent
                } else if messages[i].role == .user && messages[i].status == .processing {
                    messages[i].status = .sent
                }
            }
            dispatchPendingSendDirect()
            return
        }

        // Flush any buffered streaming text so already-received tokens are
        // visible before we set isCancelling (which suppresses future deltas).
        flushStreamingBuffer()

        // Set cancelling flag so late-arriving deltas are suppressed.
        // isSending stays true until the daemon acknowledges the cancel
        // (via generation_cancelled or message_complete) to prevent the
        // user from sending a new message before the daemon has stopped.
        isCancelling = true
        cancelledDuringRefinement = isWorkspaceRefinementInFlight
        isWorkspaceRefinementInFlight = false
        isThinking = false

        // Mark current assistant message as stopped and complete any in-progress tool calls
        // so their chips don't show an endless spinner.
        if let existingId = currentAssistantMessageId,
           let index = messages.firstIndex(where: { $0.id == existingId }) {
            messages[index].isStreaming = false
            messages[index].streamingCodePreview = nil
            messages[index].streamingCodeToolName = nil
            for j in messages[index].toolCalls.indices where !messages[index].toolCalls[j].isComplete {
                messages[index].toolCalls[j].isComplete = true
                messages[index].toolCalls[j].completedAt = Date()
            }
        }

        // Safety timeout: if the daemon never acknowledges the cancel (e.g. a
        // tool is stuck and blocks the response), force-reset the UI so the
        // user can start a new interaction.
        cancelTimeoutTask?.cancel()
        cancelTimeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 5_000_000_000) // 5 seconds
            guard let self, !Task.isCancelled else { return }
            guard self.isCancelling else { return }
            log.warning("Cancel acknowledgment timed out after 5s — force-resetting UI state")
            self.isWorkspaceRefinementInFlight = false
            self.refinementMessagePreview = nil
            self.refinementStreamingText = nil
            self.cancelledDuringRefinement = false
            self.isCancelling = false
            self.isSending = false
            self.currentAssistantMessageId = nil
            self.currentTurnUserText = nil
            self.currentAssistantHasText = false
            self.lastContentWasToolCall = false
            self.discardStreamingBuffer()
            self.discardPartialOutputBuffer()
            self.pendingQueuedCount = 0
            self.pendingMessageIds = []
            self.requestIdToMessageId = [:]
            self.activeRequestIdToMessageId = [:]
            self.pendingLocalDeletions.removeAll()
            // Reset queued/processing messages to sent (matches other cancel-failure paths)
            for i in self.messages.indices {
                if case .queued = self.messages[i].status, self.messages[i].role == .user {
                    self.messages[i].status = .sent
                } else if self.messages[i].role == .user && self.messages[i].status == .processing {
                    self.messages[i].status = .sent
                }
            }
            self.dispatchPendingSendDirect()
        }
    }

    /// Regenerate the last assistant response. Removes the old reply from
    /// all memory systems (including Qdrant) and re-runs the agent loop.
    public func regenerateLastMessage() {
        guard let conversationId, !isSending else { return }
        guard daemonClient.isConnected else {
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
        isSending = true
        isThinking = true
        suggestion = nil
        pendingSuggestionRequestId = nil

        // Make sure we're listening for the response
        if messageLoopTask == nil {
            startMessageLoop()
        }

        do {
            try daemonClient.send(RegenerateMessage(conversationId: conversationId))
        } catch {
            log.error("Failed to send regenerate: \(error.localizedDescription)")
            isSending = false
            isThinking = false
            errorText = "Failed to regenerate message."
        }
    }

    /// Revert the last refinement on the active workspace surface.
    public func undoSurfaceRefinement() {
        guard let conversationId, let surfaceId = activeSurfaceId else { return }
        guard surfaceUndoCount > 0 else { return }
        do {
            try daemonClient.send(UiSurfaceUndoMessage(conversationId: conversationId, surfaceId: surfaceId))
        } catch {
            log.error("Failed to send surface undo: \(error.localizedDescription)")
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

        do {
            try daemonClient.send(DeleteQueuedMessageMessage(conversationId: conversationId, requestId: entry.key))
        } catch {
            log.error("Failed to send delete_queued_message: \(error.localizedDescription)")
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
        guard let index = messages.firstIndex(where: { $0.id == messageId }),
              case .queued = messages[index].status else { return }

        // Save content before stop clears everything
        let text = messages[index].text
        let attachments = messages[index].attachments
        let skillInvocation = messages[index].skillInvocation

        // Remove this message from local state (it will be re-added by sendMessage)
        messages.remove(at: index)

        // If nothing is actively sending, stopGenerating() will no-op and no
        // cancel-completion event will fire. Dispatch immediately instead.
        guard isSending else {
            inputText = text
            pendingAttachments = attachments
            pendingSkillInvocation = skillInvocation
            sendMessage()
            return
        }

        // Store for dispatch after cancellation completes.
        // Must be set BEFORE stopGenerating() because synchronous cancel paths
        // (bootstrap, disconnected, send-failure) dispatch immediately.
        pendingSendDirectText = text
        pendingSendDirectAttachments = attachments
        pendingSendDirectSkillInvocation = skillInvocation

        // Stop current generation — this clears all queued messages on the daemon
        stopGenerating()
    }

    /// If a send-direct is pending, populate the composer and fire sendMessage.
    /// Called from all cancel-completion paths (generationCancelled, timeout, disconnected, etc.).
    func dispatchPendingSendDirect() {
        guard let directText = pendingSendDirectText else { return }
        let directAttachments = pendingSendDirectAttachments ?? []
        let directSkillInvocation = pendingSendDirectSkillInvocation
        pendingSendDirectText = nil
        pendingSendDirectAttachments = nil
        pendingSendDirectSkillInvocation = nil
        inputText = directText
        pendingAttachments = directAttachments
        pendingSkillInvocation = directSkillInvocation
        sendMessage()
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
        lastFailedMessageText = nil
        lastFailedMessageDisplayText = nil
        lastFailedMessageAttachments = nil
        lastFailedSendError = nil
        connectionDiagnosticHint = nil
        secretBlockedMessageText = nil
        secretBlockedAttachments = nil
        secretBlockedActiveSurfaceId = nil
        secretBlockedCurrentPage = nil
    }

    /// Dismiss the typed session error state. Clears both the typed error
    /// and any corresponding `errorText` so the UI can return to normal.
    public func dismissConversationError() {
        conversationError = nil
        errorText = nil
    }

    /// Copy conversation error details to the clipboard for debugging.
    public func copyConversationErrorDebugDetails() {
        guard let error = conversationError else { return }
        var details = """
        Error: \(error.message)
        Category: \(error.category)
        Session: \(error.conversationId)
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
    public func retryAfterConversationError() {
        guard let error = conversationError, error.isRetryable else { return }
        guard conversationId != nil else { return }
        // Reset sending state that may still be set if the session error arrived
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
        // would fail with 404 because the daemon never received the message.
        if let lastMsg = messages.last, lastMsg.role == .user {
            lastFailedMessageText = lastMsg.text
            lastFailedMessageDisplayText = nil
            // Preserve attachments so they are resent with the retry.
            // ChatAttachment.data may already be cleared for older messages,
            // but for a just-sent 429'd message it is still populated.
            // Also keep file-path-based attachments even when data is empty,
            // since the daemon can read the file from disk.
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
        guard let text = secretBlockedMessageText, let conversationId else { return }

        guard daemonClient.isConnected else {
            errorText = "Cannot connect to assistant. Please ensure it's running."
            return
        }

        // Snapshot and clear stashed context
        let attachments = secretBlockedAttachments
        let surfaceId = secretBlockedActiveSurfaceId
        let page = secretBlockedCurrentPage

        secretBlockedMessageText = nil
        secretBlockedAttachments = nil
        secretBlockedActiveSurfaceId = nil
        secretBlockedCurrentPage = nil
        errorText = nil

        isSending = true
        isThinking = true

        if messageLoopTask == nil {
            startMessageLoop()
        }

        do {
            let pttMeta = Self.currentPttMetadata()
            try daemonClient.send(UserMessageMessage(
                conversationId: conversationId,
                content: text,
                attachments: attachments,
                activeSurfaceId: surfaceId,
                currentPage: surfaceId != nil ? page : nil,
                bypassSecretCheck: true,
                pttActivationKey: pttMeta.activationKey,
                microphonePermissionGranted: pttMeta.microphonePermissionGranted
            ))
        } catch {
            log.error("Failed to send bypassed message: \(error.localizedDescription)")
            isSending = false
            isThinking = false
            errorText = "Failed to send message."
        }
    }

    /// Retry sending the last user message that failed (e.g. due to daemon disconnection).
    public func retryLastMessage() {
        guard let text = lastFailedMessageText else { return }
        let displayText = lastFailedMessageDisplayText
        let attachments = lastFailedMessageAttachments

        // Clear failed message state and error
        lastFailedMessageText = nil
        lastFailedMessageDisplayText = nil
        lastFailedMessageAttachments = nil
        lastFailedSendError = nil
        errorText = nil
        connectionDiagnosticHint = nil

        if conversationId == nil {
            pendingUserMessageDisplayText = displayText
            bootstrapConversation(userMessage: text, attachments: attachments)
        } else {
            // When retrying while another turn is in progress, the retried
            // message will be queued by the daemon. Track it in
            // pendingMessageIds so subsequent messageQueued/messageDequeued
            // events can update the user message's status correctly.
            var queuedMessageId: UUID?
            if isSending {
                // Find the user message that corresponds to the failed text
                // (it was already appended to messages[] during the original
                // sendMessage() call). Use the last user message with matching
                // text as the queue entry.
                let matchText = displayText ?? text
                if let idx = messages.lastIndex(where: { $0.role == .user && $0.text == matchText }) {
                    pendingMessageIds.append(messages[idx].id)
                    queuedMessageId = messages[idx].id
                    messages[idx].status = .queued(position: 0)
                }
            }
            sendUserMessage(text, displayText: displayText, attachments: attachments, queuedMessageId: queuedMessageId)
        }
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

        // Resend — bootstrap a new session if needed (mirrors retryLastMessage)
        if conversationId == nil {
            bootstrapConversation(userMessage: message.text, attachments: userAttachments)
        } else {
            sendUserMessage(message.text, attachments: userAttachments)
        }
    }

    /// Respond to a tool confirmation request displayed inline in the chat.
    public func respondToConfirmation(requestId: String, decision: String) {
        // DaemonClient.send silently returns when connection is nil (it does
        // not throw), so we must check connectivity explicitly before calling
        // sendConfirmationResponse. Without this guard the UI would show the
        // decision as finalized even though the daemon never received it.
        guard daemonClient.isConnected else {
            errorText = "Failed to send confirmation response."
            return
        }
        // Send the response to the daemon first, then update UI state only on success.
        // This prevents the UI from showing a finalized decision when the
        // message was never delivered (e.g. daemon disconnected).
        do {
            try daemonClient.send(ConfirmationResponseMessage(requestId: requestId, decision: decision, selectedPattern: nil, selectedScope: nil))
        } catch {
            log.error("Failed to send confirmation response: \(error.localizedDescription)")
            errorText = "Failed to send confirmation response."
            return
        }
        // Send succeeded — update the message state
        if let index = messages.firstIndex(where: { $0.confirmation?.requestId == requestId }) {
            let isApproval = decision == "allow" || decision == "allow_10m" || decision == "allow_conversation"
            messages[index].confirmation?.state = isApproval ? .approved : .denied
            if isApproval {
                messages[index].confirmation?.approvedDecision = decision
            }
        }
        clearPendingConfirmation(requestId: requestId)
        // Dismiss the corresponding floating panel / native notification if one exists
        onInlineConfirmationResponse?(requestId, decision)
    }

    /// Respond to a tool confirmation with "always_allow", sending the selected pattern and scope
    /// so the backend atomically persists the trust rule alongside the confirmation response.
    /// If the daemon is disconnected, shows an error without attempting a fallback (since
    /// respondToConfirmation would also fail). On send errors, attempts a one-time allow
    /// fallback and only claims success if the fallback actually went through.
    public func respondToAlwaysAllow(requestId: String, selectedPattern: String, selectedScope: String, decision: String = "always_allow") {
        guard daemonClient.isConnected else {
            log.warning("Cannot persist always-allow: daemon not connected")
            errorText = "Cannot send confirmation — daemon is not connected."
            return
        }
        do {
            try daemonClient.send(ConfirmationResponseMessage(requestId: requestId, decision: decision, selectedPattern: selectedPattern, selectedScope: selectedScope))
        } catch {
            log.warning("Always-allow send failed: \(error.localizedDescription)")
            // Try one-time allow as fallback (daemon may still be connected)
            respondToConfirmation(requestId: requestId, decision: "allow")
            // respondToConfirmation sets errorText on failure; override with more context if it succeeded
            if let index = messages.firstIndex(where: { $0.confirmation?.requestId == requestId }),
               messages[index].confirmation?.state == .approved {
                errorText = "Preference could not be saved. This action was allowed once."
            }
            return
        }
        // Send succeeded — update the message state
        if let index = messages.firstIndex(where: { $0.confirmation?.requestId == requestId }) {
            messages[index].confirmation?.state = .approved
            messages[index].confirmation?.approvedDecision = decision
        }
        clearPendingConfirmation(requestId: requestId)
        // Dismiss the corresponding floating panel / native notification if one exists
        onInlineConfirmationResponse?(requestId, "allow")
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

    /// Send an add_trust_rule message to persist a trust rule.
    /// Returns `true` if the send succeeded, `false` otherwise.
    public func addTrustRule(toolName: String, pattern: String, scope: String, decision: String) -> Bool {
        guard daemonClient.isConnected else {
            log.warning("Cannot send add_trust_rule: daemon not connected")
            return false
        }
        do {
            try daemonClient.send(AddTrustRuleMessage(
                toolName: toolName,
                pattern: pattern,
                scope: scope,
                decision: decision
            ))
            return true
        } catch {
            log.error("Failed to send add_trust_rule: \(error.localizedDescription)")
            return false
        }
    }

    /// Parse string-encoded content order entries ("text:0", "tool:1", "surface:0")
    /// into ContentBlockRef values.
    private static func parseContentOrder(_ strings: [String]) -> [ContentBlockRef] {
        strings.compactMap { str in
            let parts = str.split(separator: ":", maxSplits: 1)
            guard parts.count == 2, let idx = Int(parts[1]) else { return nil }
            switch parts[0] {
            case "text": return .text(idx)
            case "tool": return .toolCall(idx)
            case "surface": return .surface(idx)
            default: return nil
            }
        }
    }

    /// Ask the daemon for a follow-up suggestion for the current session.
    func fetchSuggestion() {
        guard let conversationId, daemonClient.isConnected else { return }

        let requestId = UUID().uuidString
        pendingSuggestionRequestId = requestId

        do {
            try daemonClient.send(SuggestionRequestMessage(
                conversationId: conversationId,
                requestId: requestId
            ))
        } catch {
            log.error("Failed to send suggestion_request: \(error.localizedDescription)")
            pendingSuggestionRequestId = nil
        }
    }

    /// Accept the current suggestion, appending the ghost suffix to input.
    public func acceptSuggestion() {
        guard let suggestion else { return }
        if suggestion.hasPrefix(inputText) {
            inputText = suggestion
        } else if inputText.isEmpty {
            inputText = suggestion
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
        var chatMessages: [ChatMessage] = []
        var reconstructedSubagents: [SubagentInfo] = []
        var spawnParentMap: [String: UUID] = [:]  // subagentId → spawning assistant message UUID
        for item in historyMessages {
            let role: ChatRole = item.role == "assistant" ? .assistant : .user
            var toolCalls: [ToolCallData] = []
            let toolsBeforeText = item.toolCallsBeforeText ?? true
            if let historyToolCalls = item.toolCalls {
                toolCalls = historyToolCalls.map { tc in
                    // Truncate tool result for memory safety
                    let truncatedResult: String? = {
                        guard let result = tc.result else { return nil }
                        return result.count > 2000 ? String(result.prefix(2000)) + "...[truncated]" : result
                    }()

                    // Decode image once — pass decoded image directly to avoid double-decode
                    // (ToolCallData.init also decodes base64, so skip that by passing imageData: nil)
                    let decodedImage = ToolCallData.decodeImage(from: tc.imageData)

                    var toolCall = ToolCallData(
                        toolName: tc.name,
                        inputSummary: summarizeToolInput(tc.input),
                        inputFull: "",
                        inputRawValue: extractToolInput(tc.input),
                        result: truncatedResult,
                        isError: tc.isError ?? false,
                        isComplete: true,
                        arrivedBeforeText: toolsBeforeText,
                        imageData: nil
                    )
                    toolCall.cachedImage = decodedImage
                    toolCall.reasonDescription = (tc.input["reason"]?.value as? String)
                        ?? (tc.input["reasoning"]?.value as? String)
                    // Restore persisted timing and confirmation data
                    if let startMs = tc.startedAt {
                        toolCall.startedAt = Date(timeIntervalSince1970: Double(startMs) / 1000.0)
                    }
                    if let endMs = tc.completedAt {
                        toolCall.completedAt = Date(timeIntervalSince1970: Double(endMs) / 1000.0)
                    }
                    if let decision = tc.confirmationDecision {
                        switch decision {
                        case "approved": toolCall.confirmationDecision = .approved
                        case "denied": toolCall.confirmationDecision = .denied
                        case "timed_out": toolCall.confirmationDecision = .timedOut
                        default: break
                        }
                    }
                    toolCall.confirmationLabel = tc.confirmationLabel
                    // Cap tool input size to prevent unbounded memory from large history
                    // restores. Check size synchronously to avoid a race where a deferred
                    // Task might run before self.messages is populated with these new items.
                    let input = tc.input
                    let estimatedSize: Int = (try? JSONSerialization.data(withJSONObject: input.mapValues { $0.value ?? NSNull() }))?.count ?? 0
                    if estimatedSize > 10_000 {
                        // Too large — format eagerly (with truncation) to free the raw dict.
                        let formatted = ToolCallData.formatAllToolInput(input)
                        toolCall.inputFull = formatted
                        toolCall.inputFullLength = formatted.count
                    } else {
                        toolCall.inputRawDict = input
                    }
                    return toolCall
                }
            }
            let attachments: [ChatAttachment] = mapMessageAttachments(item.attachments ?? [])

            // Map surfaces from history to inlineSurfaces
            var inlineSurfaces: [InlineSurfaceData] = []
            if let historySurfaces = item.surfaces {
                for surf in historySurfaces {
                    if let conversationId = self.conversationId,
                       let surface = Surface.from(surf, conversationId: conversationId) {
                        // Build a lightweight SurfaceRef so the card remains
                        // clickable after the app restarts (history restore).
                        // The full UiSurfaceShowMessage is not retained to avoid
                        // keeping entire HTML payloads in memory.
                        // Extract appId from DynamicPageSurfaceData so the
                        // ref can re-open the real app via app_open_request.
                        let appId: String? = {
                            if case .dynamicPage(let dpData) = surface.data {
                                return dpData.appId
                            }
                            return nil
                        }()
                        let ref = SurfaceRef(
                            surfaceId: surf.surfaceId,
                            conversationId: conversationId,
                            surfaceType: surf.surfaceType,
                            title: surf.title,
                            appId: appId
                        )
                        let inlineSurface = InlineSurfaceData(
                            id: surface.id,
                            surfaceType: surface.type,
                            title: surface.title,
                            data: surface.data,
                            actions: surface.actions,
                            surfaceRef: ref
                        )
                        inlineSurfaces.append(inlineSurface)
                    }
                }
            }

            // Log surface parsing for debugging widget restoration
            if !inlineSurfaces.isEmpty {
                log.info("Mapped \(inlineSurfaces.count) surfaces from history: \(inlineSurfaces.map { $0.id })")
            } else if let historySurfaces = item.surfaces, !historySurfaces.isEmpty {
                log.warning("Failed to parse \(historySurfaces.count) surfaces from history")
            }

            // Skip empty messages (internal tool-result-only turns already filtered by daemon)
            if item.text.isEmpty && toolCalls.isEmpty && attachments.isEmpty && inlineSurfaces.isEmpty { continue }
            let timestamp = Date(timeIntervalSince1970: TimeInterval(item.timestamp) / 1000.0)

            let displayText = item.text

            // Use the database message ID if available (for matching surfaces)
            var chatMsg: ChatMessage
            if let dbId = item.id, let uuid = UUID(uuidString: dbId) {
                chatMsg = ChatMessage(
                    id: uuid,
                    role: role,
                    text: displayText,
                    timestamp: timestamp,
                    attachments: attachments,
                    toolCalls: toolCalls
                )
            } else {
                chatMsg = ChatMessage(
                    role: role,
                    text: displayText,
                    timestamp: timestamp,
                    attachments: attachments,
                    toolCalls: toolCalls
                )
            }

            // Store the daemon's persisted message ID so diagnostics exports can
            // anchor to it. This is the database ID from the daemon, not the
            // client-side UUID.
            chatMsg.daemonMessageId = item.id

            // Preserve truncation flag so the UI can offer on-demand rehydration.
            chatMsg.wasTruncated = item.wasTruncated ?? false

            // Drop base64 data from history attachments — the daemon already
            // persisted them, so we only need thumbnails for display.
            for i in chatMsg.attachments.indices {
                chatMsg.attachments[i].data = ""
            }

            // Populate inlineSurfaces from history
            chatMsg.inlineSurfaces = inlineSurfaces

            // Use daemon-provided segments/order.
            if let segments = item.textSegments {
                chatMsg.textSegments = segments
            }
            if let orderStrings = item.contentOrder {
                chatMsg.contentOrder = Self.parseContentOrder(orderStrings)
            }

            // Log contentOrder for debugging widget restoration
            let surfaceRefs = chatMsg.contentOrder.filter {
                if case .surface = $0 { return true }
                return false
            }
            if !inlineSurfaces.isEmpty || !surfaceRefs.isEmpty {
                log.info("Message contentOrder: \(item.contentOrder ?? []), surface refs: \(surfaceRefs.count), inlineSurfaces: \(chatMsg.inlineSurfaces.count)")
            }

            // Build a map of subagentId → spawning assistant message UUID
            // by scanning tool call results for subagent_spawn.
            if role == .assistant {
                for tc in toolCalls where tc.toolName == "subagent_spawn" {
                    if let result = tc.result,
                       let data = result.data(using: .utf8),
                       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let spawnedId = json["subagentId"] as? String {
                        spawnParentMap[spawnedId] = chatMsg.id
                    }
                }
            }

            // Reconstruct subagent chips from structured notification metadata
            if let notification = item.subagentNotification {
                var info = SubagentInfo(
                    id: notification.subagentId,
                    label: notification.label,
                    status: SubagentStatus(wire: notification.status),
                    parentMessageId: spawnParentMap[notification.subagentId],
                    conversationId: notification.conversationId
                )
                info.error = notification.error
                reconstructedSubagents.append(info)
                chatMsg.isSubagentNotification = true
            }

            chatMessages.append(chatMsg)
        }

        // Merge reconstructed subagents into activeSubagents (avoid duplicates)
        for info in reconstructedSubagents where !activeSubagents.contains(where: { $0.id == info.id }) {
            activeSubagents.append(info)
        }

        // Tag assistant messages that follow "/model" or "/models" user messages
        // so the client renders the picker/table UI instead of plain text.
        var hasModelCommand = false
        for i in chatMessages.indices {
            guard chatMessages[i].role == .user,
                  i + 1 < chatMessages.count && chatMessages[i + 1].role == .assistant else { continue }
            let userText = chatMessages[i].text.trimmingCharacters(in: .whitespacesAndNewlines)
            if userText == "/model" {
                chatMessages[i + 1].modelPicker = ModelPickerData()
                hasModelCommand = true
            } else if userText == "/models" {
                chatMessages[i + 1].modelList = ModelListData()
                hasModelCommand = true
            } else if userText == "/commands" {
                chatMessages[i + 1].commandList = CommandListData()
            }
        }
        // Refresh model/provider state so the picker/table has correct data on restart
        if hasModelCommand {
            do {
                try daemonClient.send(ModelGetRequestMessage())
            } catch {
                log.error("Failed to send ModelGetRequest: \(error)")
            }
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
            self.messages = chatMessages + self.messages
            // Expand the display window by the number of messages prepended so
            // the user sees them immediately. Use Int.max if no more pages exist.
            if hasMore {
                displayedMessageCount = displayedMessageCount == Int.max
                    ? Int.max
                    : displayedMessageCount + chatMessages.count
            } else {
                displayedMessageCount = Int.max
            }
            self.loadMoreTimeoutTask?.cancel()
            self.loadMoreTimeoutTask = nil
            self.isLoadingMoreMessages = false
            trimOldMessagesIfNeeded()
            return
        }

        self.isLoadingHistory = true

        // Discard any in-flight streaming text that references the pre-replacement
        // message array. Without this, a scheduled flushStreamingBuffer() can fire
        // after the messages array is replaced, creating an orphan assistant message
        // or appending text to a stale currentAssistantMessageId.
        discardStreamingBuffer()
        discardPartialOutputBuffer()
        cancelRefetchTasks()
        currentAssistantMessageId = nil
        currentAssistantHasText = false
        lastContentWasToolCall = false

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
            self.messages = chatMessages + localOnly
            self.reconnectLatchTimeoutTask?.cancel()
            self.isReconnectHistoryLoading = false
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
            self.messages = uniqueHistory + self.messages
        } else {
            self.messages = chatMessages
        }
        self.isLoadingHistory = false
        self.isHistoryLoaded = true
        // Reset pagination so the view shows the most-recent page after history loads.
        self.displayedMessageCount = Self.messagePageSize
        // Surfaces are now included directly in the history response and populated above
        // Strip heavy data from old messages after a (potentially large) history load.
        trimOldMessagesIfNeeded()
        // Fetch pending guardian prompts when history loads (thread open/restore)
        refreshGuardianPrompts()
    }

    deinit {
        // Cancel all Combine subscriptions first so no new work can be scheduled
        // from incoming publisher events while the remaining cleanup runs.
        cancellables.removeAll()
        subManagerPublishTask?.cancel()
        messageLoopTask?.cancel()
        streamingFlushTask?.cancel()
        partialOutputFlushTask?.cancel()
        cancelTimeoutTask?.cancel()
        loadMoreTimeoutTask?.cancel()
        for task in refetchTasks.values { task.cancel() }
        refetchTasks.removeAll()
        // refinementFailureDismissTask and refinementFlushTask are accessed via
        // @MainActor computed properties (forwarded from ChatMessageManager), which
        // cannot be referenced from nonisolated deinit. Both tasks use [weak self],
        // so they will exit naturally when self is deallocated.
        reconnectLatchTimeoutTask?.cancel()
        reconnectDebounceTask?.cancel()
        btwTask?.cancel()
        greetingTask?.cancel()
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
        do {
            try daemonClient.send(GuardianActionsPendingRequestMessage(conversationId: conversationId))
        } catch {
            log.error("Failed to request pending guardian prompts: \(error)")
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

        do {
            try daemonClient.send(GuardianActionDecisionMessage(requestId: requestId, action: action, conversationId: conversationId))
        } catch {
            log.error("Failed to submit guardian decision: \(error)")
            pendingGuardianActions.removeValue(forKey: requestId)
            // Revert submitting state on failure
            if let idx = messages.firstIndex(where: { $0.guardianDecision?.requestId == requestId }) {
                messages[idx].guardianDecision?.isSubmitting = false
            }
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
        let key = UserDefaults.standard.string(forKey: "activationKey") ?? "fn"
        let micGranted = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        return PttMetadata(activationKey: key, microphonePermissionGranted: micGranted)
        #else
        return PttMetadata(activationKey: nil, microphonePermissionGranted: nil)
        #endif
    }
}
