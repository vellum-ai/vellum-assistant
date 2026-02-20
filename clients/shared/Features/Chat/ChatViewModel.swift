import Foundation
import os
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#else
#error("Unsupported platform")
#endif

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ChatViewModel")

@MainActor
public final class ChatViewModel: ObservableObject {
    @Published public var messages: [ChatMessage] = []
    @Published public var inputText: String = ""
    @Published public var isThinking: Bool = false
    @Published public var isSending: Bool = false
    @Published public var errorText: String?
    @Published public var sessionError: SessionError?
    @Published public var pendingQueuedCount: Int = 0
    @Published public var suggestion: String?
    @Published public var pendingAttachments: [ChatAttachment] = []
    @Published public var isRecording: Bool = false
    @Published public var isWorkspaceRefinementInFlight: Bool = false
    @Published public var refinementMessagePreview: String?   // user's sent text
    @Published public var refinementStreamingText: String?     // AI response as it streams
    /// Tracks whether a cancel was initiated during a workspace refinement.
    /// Used by `messageComplete` to correctly suppress refinement side-effects
    /// even though `isWorkspaceRefinementInFlight` is cleared immediately for UI.
    var cancelledDuringRefinement: Bool = false
    /// Text buffered during a workspace refinement (normally suppressed from chat).
    /// Surfaced to the user if the refinement completes without a surface update.
    var refinementTextBuffer: String = ""
    var refinementReceivedSurfaceUpdate: Bool = false
    /// When non-nil, displays a toast in the workspace with the AI's response
    /// after a refinement that produced no surface update.
    @Published public var refinementFailureText: String?
    var refinementFailureDismissTask: Task<Void, Never>?
    /// Number of undo steps available for the active workspace surface.
    @Published public var surfaceUndoCount: Int = 0
    @Published public var pendingSkillInvocation: SkillInvocationData?
    @Published public var isWatchSessionActive: Bool = false
    @Published public var activeSubagents: [SubagentInfo] = []
    public let subagentDetailStore = SubagentDetailStore()
    /// Widget IDs dismissed by the user, persisted across view recreation.
    @Published public var dismissedDocumentSurfaceIds: Set<String> = []

    /// The currently active model ID, updated via `model_info` IPC messages.
    @Published public var selectedModel: String = "claude-opus-4-6"
    /// Set of provider keys with configured API keys, updated via `model_info` IPC messages.
    @Published public var configuredProviders: Set<String> = ["anthropic"]

    /// Maximum file size per attachment (20 MB).
    static let maxFileSize = 20 * 1024 * 1024
    /// Maximum image size before compression (4 MB - leaves headroom for base64 encoding).
    /// Anthropic has a 5MB limit per image; base64 encoding adds ~33% overhead.
    static let maxImageSize = 4 * 1024 * 1024
    /// Maximum number of attachments per message.
    public static let maxAttachments = 5

    let daemonClient: any DaemonClientProtocol
    public var sessionId: String?
    private var reconnectObserver: NSObjectProtocol?
    var pendingUserMessage: String?
    /// Optional callback for sending notifications when tool-use messages complete
    public var onToolCallsComplete: ((_ toolCalls: [ToolCallData]) -> Void)?
    /// Whether the current assistant response was triggered by a voice message.
    public var pendingVoiceMessage: Bool = false
    /// Called when a voice-triggered assistant response completes, with the response text.
    public var onVoiceResponseComplete: ((String) -> Void)?
    var pendingUserAttachments: [IPCAttachment]?
    /// Stores the last user message that failed to send, enabling retry.
    private(set) var lastFailedMessageText: String?
    private(set) var lastFailedMessageAttachments: [IPCAttachment]?
    /// Set only when a send operation (bootstrapSession or sendUserMessage) fails.
    /// Used by `isRetryableError` to ensure the retry button only appears for
    /// actual send failures, not for unrelated errors (attachment validation,
    /// confirmation response failures, regenerate errors, etc.).
    private(set) var lastFailedSendError: String?
    /// Stores the text of a message that was blocked by the secret-ingress check.
    /// Set when an error with category "secret_blocked" arrives.
    var secretBlockedMessageText: String?
    /// Stashed context from the blocked send, so sendAnyway() can reconstruct
    /// the original UserMessageMessage with attachments and surface metadata.
    var secretBlockedAttachments: [IPCAttachment]?
    var secretBlockedActiveSurfaceId: String?
    var secretBlockedCurrentPage: String?
    /// Nonce sent with `session_create` and echoed back in `session_info`.
    /// Used to ensure this ChatViewModel only claims its own session.
    var bootstrapCorrelationId: String?
    /// Thread type sent with `session_create` (e.g. "private").
    /// Set by `createSessionIfNeeded(threadType:)` and included in the IPC
    /// message so the daemon can persist the correct thread kind.
    public var threadType: String?
    /// Skill IDs to pre-activate in the session. Included in the
    /// `session_create` request for deterministic skill activation.
    public var preactivatedSkillIds: [String]?
    /// Whether this view model is currently bootstrapping a new session
    /// (session_create sent, awaiting session_info). Used by ThreadManager
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
    /// FIFO queue of user message UUIDs awaiting requestId assignment from the daemon.
    var pendingMessageIds: [UUID] = []
    /// Messages deleted locally before the daemon's `message_queued` ack arrived.
    /// Once the ack provides the requestId, the deletion is forwarded to the daemon.
    var pendingLocalDeletions: Set<UUID> = []
    /// Tracks the current in-flight suggestion request so stale responses are ignored.
    var pendingSuggestionRequestId: String?
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

    /// Called when the daemon assigns a session ID to this chat (via session_info).
    /// Used by ThreadManager to backfill ThreadModel.sessionId for new threads.
    public var onSessionCreated: ((String) -> Void)?

    /// Called once when the first user message is sent, with the message text.
    /// Used by ThreadManager to auto-title the thread.
    public var onFirstUserMessage: ((String) -> Void)?

    /// Whether this view model has had its history loaded from the daemon.
    public var isHistoryLoaded: Bool = false

    /// True while `populateFromHistory` is actively inserting messages.
    /// Observers can check this to avoid treating the history hydration as new activity.
    public private(set) var isLoadingHistory: Bool = false

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
        reconnectObserver = NotificationCenter.default.addObserver(
            forName: .daemonDidReconnect,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.pendingQueuedCount = 0
                self?.pendingMessageIds.removeAll()
                self?.requestIdToMessageId.removeAll()
                self?.pendingLocalDeletions.removeAll()
            }
        }
    }

    // MARK: - Deep Link

    /// Check for a buffered deep-link message and apply it to `inputText`.
    /// Called by the iOS view layer when this `ChatViewModel` becomes the
    /// active/visible thread, ensuring only one VM ever consumes the message.
    #if os(iOS)
    public func consumeDeepLinkIfNeeded() {
        guard let message = DeepLinkManager.pendingMessage else { return }
        DeepLinkManager.pendingMessage = nil
        inputText = message
    }
    #endif

    // MARK: - Sending

    public func sendMessage() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasAttachments = !pendingAttachments.isEmpty
        let hasSkillInvocation = pendingSkillInvocation != nil
        guard !text.isEmpty || hasAttachments || hasSkillInvocation else { return }

        // When "/model" or "/models" is sent, refresh model state so the picker/table has fresh data
        if (text == "/model" || text == "/models") && !hasSkillInvocation {
            try? daemonClient.send(ModelGetRequestMessage())
        }

        // Fire auto-title callback on the first user message (skip slash commands
        // like /model so the thread title isn't set to a command string)
        if !text.isEmpty, !text.hasPrefix("/"), let callback = onFirstUserMessage {
            onFirstUserMessage = nil
            callback(text)
        }

        // Block rapid-fire only when bootstrapping with a queued message.
        // When a message-less bootstrap is in flight (e.g. private thread
        // pre-allocation), adopt the user's message as the pending message
        // so it gets sent when session_info arrives instead of being dropped.
        if (isSending || isBootstrapping) && sessionId == nil {
            if pendingUserMessage == nil {
                isSending = true
                let attachments = pendingAttachments
                pendingAttachments = []
                pendingUserMessage = text
                pendingUserAttachments = attachments.isEmpty ? nil : attachments.map {
                    IPCAttachment(filename: $0.filename, mimeType: $0.mimeType, data: $0.data, extractedText: nil)
                }
                isThinking = true
                messages.append(ChatMessage(role: .user, text: text, status: .sent, skillInvocation: pendingSkillInvocation, attachments: attachments))
                pendingSkillInvocation = nil
                inputText = ""
                suggestion = nil
                pendingSuggestionRequestId = nil
                errorText = nil
                sessionError = nil
                lastFailedMessageText = nil
                lastFailedMessageAttachments = nil
                lastFailedSendError = nil
                secretBlockedMessageText = nil
                secretBlockedAttachments = nil
                secretBlockedActiveSurfaceId = nil
                secretBlockedCurrentPage = nil
                currentTurnUserText = text
                return
            }
            pendingSkillInvocation = nil
            return
        }

        // Snapshot and clear pending attachments
        let attachments = pendingAttachments
        pendingAttachments = []

        let isModelCommand = text == "/model" || text == "/models" || text.hasPrefix("/model ")
        let isWorkspaceRefinement = activeSurfaceId != nil && !isChatDockedToSide && !isModelCommand

        let willBeQueued = isSending && sessionId != nil
        var queuedMessageId: UUID?
        if !isWorkspaceRefinement {
            let status: ChatMessageStatus = willBeQueued ? .queued(position: 0) : .sent
            let userMessage = ChatMessage(role: .user, text: text, status: status, skillInvocation: pendingSkillInvocation, attachments: attachments)
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
        sessionError = nil
        lastFailedMessageText = nil
        lastFailedMessageAttachments = nil
        lastFailedSendError = nil
        secretBlockedMessageText = nil
        secretBlockedAttachments = nil
        secretBlockedActiveSurfaceId = nil
        secretBlockedCurrentPage = nil

        let ipcAttachments: [IPCAttachment]? = attachments.isEmpty ? nil : attachments.map {
            IPCAttachment(filename: $0.filename, mimeType: $0.mimeType, data: $0.data, extractedText: nil)
        }

        // Track the user text for this turn so assistantTextDelta can tag the
        // response correctly (e.g. modelList for "/models") without scanning the
        // whole transcript. For queued messages this is set in messageDequeued.
        if !willBeQueued {
            currentTurnUserText = text
        }

        if sessionId == nil {
            // First message: need to bootstrap session
            bootstrapSession(userMessage: text, attachments: ipcAttachments)
        } else {
            // Subsequent messages: send directly (daemon queues if busy)
            sendUserMessage(text, attachments: ipcAttachments, queuedMessageId: queuedMessageId)
        }
    }

    private func bootstrapSession(userMessage: String?, attachments: [IPCAttachment]?) {
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
        // the session_info response that belongs to its own session_create request.
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
                    self.lastFailedMessageAttachments = self.pendingUserAttachments
                    self.lastFailedSendError = "Cannot connect to daemon. Please ensure it's running."
                    self.pendingUserMessage = nil
                    self.pendingUserAttachments = nil
                    self.errorText = self.lastFailedSendError
                    return
                }
            }

            // Subscribe to daemon stream
            self.startMessageLoop()

            // Send session_create with correlation ID and thread type
            do {
                try daemonClient.send(SessionCreateMessage(title: nil, correlationId: correlationId, threadType: self.threadType, preactivatedSkillIds: self.preactivatedSkillIds))
                // Clear one-shot preactivated skills so they don't leak into a
                // later session if this bootstrap is interrupted before completion.
                self.preactivatedSkillIds = nil
            } catch {
                log.error("Failed to send session_create: \(error.localizedDescription)")
                self.isThinking = false
                self.isSending = false
                self.bootstrapCorrelationId = nil
                self.lastFailedMessageText = self.pendingUserMessage
                self.lastFailedMessageAttachments = self.pendingUserAttachments
                self.lastFailedSendError = "Failed to create session."
                self.pendingUserMessage = nil
                self.pendingUserAttachments = nil
                self.errorText = self.lastFailedSendError
            }
        }
    }

    private func sendUserMessage(_ text: String, attachments: [IPCAttachment]? = nil, queuedMessageId: UUID? = nil) {
        guard let sessionId else { return }

        // Check connectivity before entering sending state so the UI
        // doesn't get stuck with isSending/isThinking = true when the
        // daemon has disconnected between turns.
        guard daemonClient.isConnected else {
            log.error("Cannot send user_message: daemon not connected")
            // Always track the failed message for retry support.
            lastFailedMessageText = text
            lastFailedMessageAttachments = attachments
            // Only update UI error state for the primary send (not a queued
            // retry). A queued retry failing must not clobber the active turn's
            // isSending/isThinking flags or show an error banner over it.
            if queuedMessageId == nil {
                lastFailedSendError = "Cannot connect to daemon. Please ensure it's running."
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
            try daemonClient.send(UserMessageMessage(
                sessionId: sessionId,
                content: text,
                attachments: attachments,
                activeSurfaceId: activeSurfaceId,
                currentPage: activeSurfaceId != nil ? currentPage : nil
            ))
        } catch {
            log.error("Failed to send user_message: \(error.localizedDescription)")
            // Always track the failed message for retry support.
            lastFailedMessageText = text
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
                // Reset spinner state — if IPC drops mid-turn the client
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
                // If a send-direct was pending when the stream dropped,
                // dispatch it now so the message isn't silently lost.
                self?.dispatchPendingSendDirect()
            }
        }
    }

    /// Send a message to the daemon without showing a user bubble in the chat.
    /// Used for automated actions like inline model picker selections.
    /// Returns `true` if the message was sent (or a session bootstrap was started),
    /// `false` if the message was silently dropped (e.g. bootstrap already in flight).
    @discardableResult
    public func sendSilently(_ text: String) -> Bool {
        // Don't re-enter bootstrap if a session creation is already in progress —
        // that would overwrite pendingUserMessage and orphan the in-flight session.
        if sessionId == nil && (isSending || isBootstrapping) {
            return false
        }
        if sessionId == nil {
            bootstrapSession(userMessage: text, attachments: nil)
        } else {
            sendUserMessage(text)
        }
        return true
    }

    /// Create a daemon session immediately, without a user message.
    /// Used by private threads that need a persistent session ID right away
    /// (e.g. to store the thread in the database before the user types anything).
    /// No-op if a session already exists or a bootstrap is already in flight.
    public func createSessionIfNeeded(threadType: String? = nil) {
        guard sessionId == nil, !isBootstrapping else { return }
        if let threadType {
            self.threadType = threadType
        }
        bootstrapSession(userMessage: nil, attachments: nil)
    }

    // MARK: - Model

    /// Switch the active model via the daemon's `model_set` IPC command.
    public func setModel(_ modelId: String) {
        // Ensure the message loop is running so we receive the model_info response.
        // VMs restored with an existing sessionId may not have started it yet.
        if messageLoopTask == nil {
            startMessageLoop()
        }
        try? daemonClient.send(ModelSetRequestMessage(model: modelId))
    }

    // MARK: - Actions

    public func sendSurfaceAction(surfaceId: String, actionId: String, data: [String: AnyCodable]? = nil) {
        guard let sessionId = sessionId else { return }
        let msg = UiSurfaceActionMessage(
            sessionId: sessionId,
            surfaceId: surfaceId,
            actionId: actionId,
            data: data
        )
        try? daemonClient.send(msg)
    }

    /// Cancel the queued user message without clearing `bootstrapCorrelationId`.
    /// Used when archiving a thread before session_info arrives: we want to
    /// discard the pending message (so it isn't sent once the session is claimed)
    /// but preserve the correlation ID so the VM only claims its own session.
    public func cancelPendingMessage() {
        pendingUserMessage = nil
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
        // discard the pending message so it won't be sent when session_info
        // arrives, and reset UI state immediately since there's nothing to
        // cancel on the daemon side.
        if sessionId == nil {
            pendingUserMessage = nil
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
            pendingQueuedCount = 0
            pendingMessageIds = []
            requestIdToMessageId = [:]
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
            try daemonClient.send(CancelMessage(sessionId: sessionId!))
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
            pendingQueuedCount = 0
            pendingMessageIds = []
            requestIdToMessageId = [:]
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
            self.pendingQueuedCount = 0
            self.pendingMessageIds = []
            self.requestIdToMessageId = [:]
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
        guard let sessionId, !isSending else { return }
        guard daemonClient.isConnected else {
            errorText = "Cannot connect to daemon. Please ensure it's running."
            return
        }

        // Remove inline error messages before regenerating so they don't
        // linger above the new response.
        while messages.last?.isError == true {
            messages.removeLast()
        }
        errorText = nil
        sessionError = nil
        isSending = true
        isThinking = true
        suggestion = nil
        pendingSuggestionRequestId = nil

        // Make sure we're listening for the response
        if messageLoopTask == nil {
            startMessageLoop()
        }

        do {
            try daemonClient.send(RegenerateMessage(sessionId: sessionId))
        } catch {
            log.error("Failed to send regenerate: \(error.localizedDescription)")
            isSending = false
            isThinking = false
            errorText = "Failed to regenerate message."
        }
    }

    /// Revert the last refinement on the active workspace surface.
    public func undoSurfaceRefinement() {
        guard let sessionId, let surfaceId = activeSurfaceId else { return }
        guard surfaceUndoCount > 0 else { return }
        do {
            try daemonClient.send(UiSurfaceUndoMessage(sessionId: sessionId, surfaceId: surfaceId))
        } catch {
            log.error("Failed to send surface undo: \(error.localizedDescription)")
        }
    }

    /// Delete a queued message by its local message ID.
    /// Finds the daemon requestId for the message and sends a delete request.
    public func deleteQueuedMessage(messageId: UUID) {
        guard let sessionId else { return }

        // Find the requestId for this message
        guard let entry = requestIdToMessageId.first(where: { $0.value == messageId }) else {
            // Message hasn't been assigned a requestId yet — remove it from the UI
            // and defer the daemon-side cancellation until the ack arrives.
            pendingLocalDeletions.insert(messageId)
            removeQueuedMessageLocally(messageId: messageId)
            return
        }

        do {
            try daemonClient.send(DeleteQueuedMessageMessage(sessionId: sessionId, requestId: entry.key))
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
        sessionError = nil
        errorText = nil
        lastFailedMessageText = nil
        lastFailedMessageAttachments = nil
        lastFailedSendError = nil
        secretBlockedMessageText = nil
        secretBlockedAttachments = nil
        secretBlockedActiveSurfaceId = nil
        secretBlockedCurrentPage = nil
    }

    /// Dismiss the typed session error state. Clears both the typed error
    /// and any corresponding `errorText` so the UI can return to normal.
    public func dismissSessionError() {
        sessionError = nil
        errorText = nil
    }

    /// Copy session error details to the clipboard for debugging.
    public func copySessionErrorDebugDetails() {
        guard let error = sessionError else { return }
        var details = """
        Error: \(error.message)
        Category: \(error.category)
        Session: \(error.sessionId)
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

    /// Retry the last message after a session error, if the error is retryable.
    public func retryAfterSessionError() {
        guard let error = sessionError, error.isRetryable else { return }
        guard sessionId != nil else { return }
        // Reset sending state that may still be set if the session error arrived
        // while queued messages were pending (pendingQueuedCount > 0).
        // Without this, regenerateLastMessage() silently bails at its
        // `!isSending` guard, leaving the UI stuck with no error and no retry.
        isSending = false
        pendingQueuedCount = 0
        pendingMessageIds = []
        requestIdToMessageId = [:]
        pendingLocalDeletions.removeAll()
        for i in messages.indices {
            if case .queued = messages[i].status, messages[i].role == .user {
                messages[i].status = .sent
            }
        }
        dismissSessionError()
        regenerateLastMessage()
    }

    /// Whether the current error has a failed user message that can be retried.
    /// Only true when `lastFailedSendError` is set, which restricts the retry
    /// button to actual send failures and prevents unrelated errors (attachment
    /// validation, confirmation response failures, regenerate errors) from
    /// offering to resend a stale cached message.
    public var isRetryableError: Bool {
        lastFailedMessageText != nil && lastFailedSendError != nil
    }

    /// Whether the current error is a secret-ingress block that can be bypassed.
    public var isSecretBlockError: Bool {
        secretBlockedMessageText != nil
    }

    /// Resend the secret-blocked message with the bypass flag so the backend skips the check.
    public func sendAnyway() {
        guard let text = secretBlockedMessageText, let sessionId else { return }

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
            try daemonClient.send(UserMessageMessage(
                sessionId: sessionId,
                content: text,
                attachments: attachments,
                activeSurfaceId: surfaceId,
                currentPage: surfaceId != nil ? page : nil,
                bypassSecretCheck: true
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
        let attachments = lastFailedMessageAttachments

        // Clear failed message state and error
        lastFailedMessageText = nil
        lastFailedMessageAttachments = nil
        lastFailedSendError = nil
        errorText = nil

        if sessionId == nil {
            bootstrapSession(userMessage: text, attachments: attachments)
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
                if let idx = messages.lastIndex(where: { $0.role == .user && $0.text == text }) {
                    pendingMessageIds.append(messages[idx].id)
                    queuedMessageId = messages[idx].id
                    messages[idx].status = .queued(position: 0)
                }
            }
            sendUserMessage(text, attachments: attachments, queuedMessageId: queuedMessageId)
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
        // This prevents the UI from showing a finalized decision when the IPC
        // message was never delivered (e.g. daemon disconnected).
        do {
            try daemonClient.send(ConfirmationResponseMessage(requestId: requestId, decision: decision, selectedPattern: nil, selectedScope: nil))
        } catch {
            log.error("Failed to send confirmation response: \(error.localizedDescription)")
            errorText = "Failed to send confirmation response."
            return
        }
        // IPC send succeeded — update the message state
        if let index = messages.firstIndex(where: { $0.confirmation?.requestId == requestId }) {
            messages[index].confirmation?.state = decision == "allow" ? .approved : .denied
        }
        // Dismiss the corresponding floating panel / native notification if one exists
        onInlineConfirmationResponse?(requestId, decision)
    }

    /// Respond to a tool confirmation with "always_allow", sending the selected pattern and scope
    /// so the backend atomically persists the trust rule alongside the confirmation response.
    /// On failure (daemon disconnected or IPC error), falls back to a one-time allow so the
    /// current action isn't blocked, and shows a warning that the persistent preference wasn't saved.
    public func respondToAlwaysAllow(requestId: String, selectedPattern: String, selectedScope: String) {
        guard daemonClient.isConnected else {
            // Fallback: try one-time allow so the current action isn't blocked
            respondToConfirmation(requestId: requestId, decision: "allow")
            log.warning("Always-allow failed (daemon disconnected) — fell back to one-time allow")
            errorText = "Preference could not be saved (daemon disconnected). This action was allowed once."
            return
        }
        do {
            try daemonClient.send(ConfirmationResponseMessage(requestId: requestId, decision: "always_allow", selectedPattern: selectedPattern, selectedScope: selectedScope))
        } catch {
            // Fallback: try one-time allow so the current action isn't blocked
            respondToConfirmation(requestId: requestId, decision: "allow")
            log.warning("Always-allow IPC failed — fell back to one-time allow: \(error.localizedDescription)")
            errorText = "Preference could not be saved. This action was allowed once."
            return
        }
        // IPC send succeeded — update the message state
        if let index = messages.firstIndex(where: { $0.confirmation?.requestId == requestId }) {
            messages[index].confirmation?.state = .approved
        }
        // Dismiss the corresponding floating panel / native notification if one exists
        onInlineConfirmationResponse?(requestId, "allow")
    }

    /// Update the inline confirmation message state without sending a response to the daemon.
    /// Used when the floating panel handles the response.
    public func updateConfirmationState(requestId: String, decision: String) {
        if let index = messages.firstIndex(where: { $0.confirmation?.requestId == requestId }) {
            switch decision {
            case "allow":
                messages[index].confirmation?.state = .approved
            case "deny":
                messages[index].confirmation?.state = .denied
            default:
                break
            }
        }
    }

    /// Send an add_trust_rule message to persist a trust rule.
    /// Returns `true` if the IPC send succeeded, `false` otherwise.
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
        guard let sessionId, daemonClient.isConnected else { return }

        let requestId = UUID().uuidString
        pendingSuggestionRequestId = requestId

        do {
            try daemonClient.send(SuggestionRequestMessage(
                sessionId: sessionId,
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
    public func populateFromHistory(_ historyMessages: [HistoryResponseMessage.HistoryMessageItem]) {
        var chatMessages: [ChatMessage] = []
        var reconstructedSubagents: [SubagentInfo] = []
        var spawnParentMap: [String: UUID] = [:]  // subagentId → spawning assistant message UUID
        for item in historyMessages {
            let role: ChatRole = item.role == "assistant" ? .assistant : .user
            var toolCalls: [ToolCallData] = []
            let toolsBeforeText = item.toolCallsBeforeText ?? true
            if let historyToolCalls = item.toolCalls {
                toolCalls = historyToolCalls.map { tc in
                    ToolCallData(
                        toolName: tc.name,
                        inputSummary: summarizeToolInput(tc.input),
                        inputFull: formatAllToolInput(tc.input),
                        result: tc.result,
                        isError: tc.isError ?? false,
                        isComplete: true,
                        arrivedBeforeText: toolsBeforeText,
                        imageData: tc.imageData
                    )
                }
            }
            let attachments: [ChatAttachment] = mapIPCAttachments(item.attachments ?? [])

            // Map surfaces from history to inlineSurfaces
            var inlineSurfaces: [InlineSurfaceData] = []
            if let historySurfaces = item.surfaces {
                for surf in historySurfaces {
                    // Use sessionId from the view model (assumes history is for current session)
                    if let sessionId = self.sessionId,
                       let surface = Surface.from(surf, sessionId: sessionId) {
                        let inlineSurface = InlineSurfaceData(
                            id: surface.id,
                            surfaceType: surface.type,
                            title: surface.title,
                            data: surface.data,
                            actions: surface.actions,
                            surfaceMessage: nil  // No IPC message for history surfaces
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

            // Use the database message ID if available (for matching surfaces)
            var chatMsg: ChatMessage
            if let dbId = item.id, let uuid = UUID(uuidString: dbId) {
                chatMsg = ChatMessage(
                    id: uuid,
                    role: role,
                    text: item.text,
                    timestamp: timestamp,
                    attachments: attachments,
                    toolCalls: toolCalls
                )
            } else {
                chatMsg = ChatMessage(
                    role: role,
                    text: item.text,
                    timestamp: timestamp,
                    attachments: attachments,
                    toolCalls: toolCalls
                )
            }

            // Store the daemon's persisted message ID so diagnostics exports can
            // anchor to it. This is the database ID from the daemon, not the
            // client-side UUID.
            chatMsg.daemonMessageId = item.id

            // Populate inlineSurfaces from history
            chatMsg.inlineSurfaces = inlineSurfaces

            // Use daemon-provided segments/order when available; fall back to legacy.
            // The daemon always provides contentOrder when there are any content blocks,
            // so we should use it even when textSegments is empty (e.g., widget-only turns).
            if let segments = item.textSegments, let orderStrings = item.contentOrder {
                chatMsg.textSegments = segments
                chatMsg.contentOrder = Self.parseContentOrder(orderStrings)
            } else {
                chatMsg.contentOrder = ChatMessage.buildDefaultContentOrder(
                    textSegmentCount: chatMsg.textSegments.count,
                    toolCallCount: toolCalls.count,
                    arrivedBeforeText: toolsBeforeText,
                    surfaceCount: inlineSurfaces.count
                )
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
                    parentMessageId: spawnParentMap[notification.subagentId]
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
            try? daemonClient.send(ModelGetRequestMessage())
        }

        self.isLoadingHistory = true
        let hasUserSentMessages = messages.contains { $0.role == .user }
        if hasUserSentMessages {
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
        // Surfaces are now included directly in the history response and populated above
    }

    deinit {
        messageLoopTask?.cancel()
        if let observer = reconnectObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }
}
