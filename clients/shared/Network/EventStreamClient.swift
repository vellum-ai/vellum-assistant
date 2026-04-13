import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "EventStreamClient")

/// Client that manages an SSE connection to the assistant runtime and broadcasts
/// parsed `ServerMessage` values to multiple independent subscribers.
///
/// Backed by `GatewayHTTPClient.stream()` for authenticated SSE connections.
@MainActor
public final class EventStreamClient {

    // MARK: - Broadcast Subscribers

    private var subscribers: [UUID: AsyncStream<ServerMessage>.Continuation] = [:]

    /// Creates a new message stream for the caller. Each subscriber receives all messages
    /// independently, enabling multiple consumers to filter for messages relevant to them
    /// without competing for elements.
    public func subscribe() -> AsyncStream<ServerMessage> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<ServerMessage>.makeStream()
        subscribers[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.subscribers.removeValue(forKey: id)
            }
        }
        return stream
    }

    // MARK: - SSE State

    private var sseTask: Task<Void, Never>?
    private var sseReconnectTask: Task<Void, Never>?
    private var sseReconnectDelay: TimeInterval = 1.0
    private let maxReconnectDelay: TimeInterval = 30.0
    private var shouldReconnect = true
    private var hasShownCreditsExhausted = false

    /// Dedicated URLSession for the current SSE connection. Each new stream
    /// gets its own session so that `invalidateAndCancel()` can tear down the
    /// underlying data task without racing against the `AsyncBytes` iterator
    /// on the cooperative thread pool (which causes EXC_BAD_ACCESS).
    private var sseSession: URLSession?

    // MARK: - SSE Parse Time Tracking

    private var sseParseTimeAccumulator: TimeInterval = 0
    private var sseParseCountInWindow: Int = 0
    private var sseWindowStart: CFAbsoluteTime = 0

    // MARK: - Conversation ID Mapping

    /// Maps the daemon's server-side conversationId → client-local conversationId.
    /// Used to remap conversationId in incoming SSE events so ChatViewModel's
    /// belongsToConversation() filter passes.
    var serverToLocalConversationMap: [String: String] = [:]
    private let serverToLocalConversationMapCap = 500

    /// Conversation IDs that originated from this client instance.
    /// Host tool requests are only executed for these conversation IDs.
    private(set) var locallyOwnedConversationIds: Set<String> = []

    /// Conversation IDs that belong to private (temporary) conversations.
    var privateConversationIds: Set<String> = []

    /// Local conversation IDs whose HTTP POST is in flight (server ID not yet known).
    /// Used by parseSSEData to speculatively remap unknown server IDs that arrive
    /// before the HTTP response creates the serverToLocalConversationMap entry.
    private var pendingMappingLocalIds: Set<String> = []

    // MARK: - Callbacks

    /// Called synchronously before broadcasting to subscribers.
    /// DaemonStatus uses this to update @Published state before subscribers see the message.
    var messagePreProcessor: ((ServerMessage) -> Void)?

    /// Called when the server-assigned conversation ID differs from the client-local ID.
    public var onConversationIdResolved: ((_ localId: String, _ serverId: String) -> Void)?

    /// Called when a token_rotated event is received.
    var onTokenRefreshed: ((String) -> Void)?


    // MARK: - Init

    public init() {}

    // MARK: - SSE Lifecycle

    /// Start the SSE event stream. Safe to call multiple times — no-ops if already running.
    public func startSSE() {
        guard sseTask == nil else {
            log.info("startSSE: already running, skipping")
            return
        }
        shouldReconnect = true
        log.info("startSSE: starting SSE stream")
        startSSEStream()
    }

    /// Stop the SSE event stream.
    public func stopSSE() {
        sseReconnectTask?.cancel()
        sseReconnectTask = nil
        invalidateSSESession()
        sseTask?.cancel()
        sseTask = nil
    }

    /// Register a conversation ID as locally owned (for host tool request filtering).
    public func registerConversationId(_ id: String) {
        locallyOwnedConversationIds.insert(id)
    }

    /// Clean up transport-level state after a synthetic conversation ID is resolved
    /// to the real server ID.
    public func cleanupAfterConversationIdResolution(localId: String, serverId: String) {
        serverToLocalConversationMap.removeValue(forKey: serverId)
        locallyOwnedConversationIds.remove(localId)
        if privateConversationIds.remove(localId) != nil {
            privateConversationIds.insert(serverId)
        }
    }

    /// Disconnect and finish all subscriber streams.
    func teardown() {
        shouldReconnect = false
        stopSSE()
        for continuation in subscribers.values {
            continuation.finish()
        }
        subscribers.removeAll()
    }

    // MARK: - Send User Message

    /// Fire-and-forget user message send. Registers the conversation ID for host tool
    /// filtering, uploads attachments, sends the message, and handles conversation ID
    /// resolution. Errors are broadcast as ConversationError messages.
    public func sendUserMessage(
        content: String?,
        conversationId: String,
        attachments: [UserMessageAttachment]? = nil,
        conversationType: String? = nil,
        automated: Bool? = nil,
        bypassSecretCheck: Bool? = nil,
        onboarding: PreChatOnboardingContext? = nil
    ) {
        locallyOwnedConversationIds.insert(conversationId)
        pendingMappingLocalIds.insert(conversationId)

        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.pendingMappingLocalIds.remove(conversationId) }
            let messageClient = MessageClient()
            let attachmentCount = attachments?.count ?? 0
            log.info("[send-pipeline] sendMessage start — attachmentCount=\(attachmentCount, privacy: .public)")

            // Upload attachments
            var attachmentIds: [String] = []
            if let attachments, !attachments.isEmpty {
                for attachment in attachments {
                    let result = await messageClient.uploadAttachment(
                        filename: attachment.filename,
                        mimeType: attachment.mimeType,
                        data: attachment.data,
                        filePath: attachment.filePath
                    )
                    switch result {
                    case .success(let id):
                        attachmentIds.append(id)
                    case .terminalAuthFailure:
                        return
                    case .transientFailure:
                        log.error("Failed to upload attachment: \(attachment.filename, privacy: .public)")
                        let failedCount = attachments.count - attachmentIds.count
                        self.broadcastMessage(.conversationError(ConversationErrorMessage(
                            conversationId: conversationId,
                            code: .providerApi,
                            userMessage: "Failed to upload \(failedCount) attachment\(failedCount == 1 ? "" : "s"). Please try again.",
                            retryable: true,
                            failedMessageContent: content
                        )))
                        return
                    }
                }
            }

            // Send the message
            let resolvedConversationType = conversationType ?? (self.privateConversationIds.contains(conversationId) ? "private" : nil)
            let sendResult = await messageClient.sendMessage(
                content: content,
                conversationKey: conversationId,
                attachmentIds: attachmentIds,
                conversationType: resolvedConversationType,
                automated: automated,
                bypassSecretCheck: bypassSecretCheck,
                onboarding: onboarding
            )

            switch sendResult {
            case .success(let serverConvId, let messageId):
                if let messageId {
                    self.broadcastMessage(.userMessagePersisted(
                        conversationId: conversationId,
                        content: content ?? "",
                        messageId: messageId
                    ))
                }
                if let serverConvId, serverConvId != conversationId {
                    self.serverToLocalConversationMap[serverConvId] = conversationId
                    self.locallyOwnedConversationIds.insert(serverConvId)
                    self.onConversationIdResolved?(conversationId, serverConvId)

                    while self.serverToLocalConversationMap.count > self.serverToLocalConversationMapCap {
                        if let key = self.serverToLocalConversationMap.keys.first {
                            self.serverToLocalConversationMap.removeValue(forKey: key)
                        }
                    }

                    log.info("Mapped conversation \(conversationId, privacy: .public) → server ID \(serverConvId, privacy: .public)")
                }
            case .authRequired:
                self.broadcastMessage(.conversationError(ConversationErrorMessage(
                    conversationId: conversationId,
                    code: .providerApi,
                    userMessage: "Failed to send message — authentication error. Please try again.",
                    retryable: true,
                    failedMessageContent: content
                )))
            case .secretBlocked(let message):
                self.broadcastMessage(.conversationError(ConversationErrorMessage(
                    conversationId: conversationId,
                    code: .providerApi,
                    userMessage: message,
                    retryable: false
                )))
            case .insufficientBalance(let detail, _):
                self.broadcastMessage(.conversationError(ConversationErrorMessage(
                    conversationId: conversationId,
                    code: .providerBilling,
                    userMessage: detail,
                    retryable: false,
                    errorCategory: "credits_exhausted"
                )))
            case .error(_, let message, _):
                self.broadcastMessage(.conversationError(ConversationErrorMessage(
                    conversationId: conversationId,
                    code: .providerApi,
                    userMessage: message,
                    retryable: true,
                    failedMessageContent: content
                )))
            }
        }
    }

    // MARK: - SSE Stream Implementation

    private func startSSEStream() {
        // Invalidate the previous session *before* cancelling the task.
        // `invalidateAndCancel()` tells URLSession to tear down the data task
        // on its own terms, which avoids the race where `Task.cancel()`
        // frees the internal `AsyncBytes` buffer while the cooperative-pool
        // iterator is still reading from it (EXC_BAD_ACCESS / PAC failure).
        invalidateSSESession()
        sseTask?.cancel()

        let session = URLSession(configuration: .default)
        sseSession = session

        sseTask = Task { @MainActor [weak self] in
            guard let self else { return }

            do {
                let (bytes, response) = try await GatewayHTTPClient.stream(
                    path: "assistants/{assistantId}/events",
                    timeout: .infinity,
                    session: session
                )

                guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                    let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
                    log.error("SSE connection failed with status \(statusCode, privacy: .public)")
                    if statusCode == 402, !self.hasShownCreditsExhausted {
                        self.hasShownCreditsExhausted = true
                        self.broadcastMessage(.conversationError(ConversationErrorMessage(
                            conversationId: "",
                            code: .providerBilling,
                            userMessage: "Your balance has run out. Add funds to continue using the assistant.",
                            retryable: false,
                            errorCategory: "credits_exhausted"
                        )))
                    }
                    if statusCode == 403 {
                        self.sseReconnectDelay = 1.0
                    }
                    self.handleSSEDisconnect()
                    return
                }

                self.hasShownCreditsExhausted = false
                log.info("SSE stream connected")

                for try await line in bytes.lines {
                    if Task.isCancelled { break }

                    if line.hasPrefix("data: ") {
                        let payload = String(line.dropFirst(6))
                        await self.parseSSEData(payload)
                    }
                }
            } catch {
                if !Task.isCancelled {
                    log.error("SSE stream error: \(error.localizedDescription, privacy: .public)")
                }
            }

            if !Task.isCancelled {
                self.handleSSEDisconnect()
            }
        }
    }

    // MARK: - SSE Parsing

    private func extractJsonStringValue(from jsonString: String, key: String) -> String? {
        for pattern in ["\"\(key)\":\"", "\"\(key)\": \""] {
            if let range = jsonString.range(of: pattern) {
                let valueStart = range.upperBound
                if let valueEnd = jsonString[valueStart...].firstIndex(of: "\"") {
                    return String(jsonString[valueStart..<valueEnd])
                }
            }
        }
        return nil
    }

    private func parseSSEData(_ data: String) async {
        let byteCount = data.utf8.count
        let start = CFAbsoluteTimeGetCurrent()

        var jsonString = data

        // Remap server conversation IDs to client-local conversation IDs.
        // When a mapping exists (HTTP response already processed), use it directly.
        // Otherwise, if there's exactly one pending send, speculatively remap to
        // that local ID — the server likely assigned a new ID that we haven't
        // mapped yet.  Pre-register the mapping so subsequent events in the same
        // window are handled by the fast path above.
        if let conversationId = extractJsonStringValue(from: jsonString, key: "conversationId") {
            let localId: String?
            if let mapped = serverToLocalConversationMap[conversationId] {
                localId = mapped
            } else if !locallyOwnedConversationIds.contains(conversationId),
                      pendingMappingLocalIds.count == 1,
                      let pendingLocalId = pendingMappingLocalIds.first {
                localId = pendingLocalId
                serverToLocalConversationMap[conversationId] = pendingLocalId
                locallyOwnedConversationIds.insert(conversationId)
                log.info("Speculative remap: \(conversationId, privacy: .public) → \(pendingLocalId, privacy: .public)")
            } else {
                localId = nil
            }
            if let localId {
                jsonString = jsonString.replacingOccurrences(
                    of: "\"conversationId\":\"\(conversationId)\"",
                    with: "\"conversationId\":\"\(localId)\""
                )
                jsonString = jsonString.replacingOccurrences(
                    of: "\"conversationId\": \"\(conversationId)\"",
                    with: "\"conversationId\": \"\(localId)\""
                )
            }
        }
        if let parentConversationId = extractJsonStringValue(from: jsonString, key: "parentConversationId"),
           let localId = serverToLocalConversationMap[parentConversationId] {
            jsonString = jsonString.replacingOccurrences(
                of: "\"parentConversationId\":\"\(parentConversationId)\"",
                with: "\"parentConversationId\":\"\(localId)\""
            )
            jsonString = jsonString.replacingOccurrences(
                of: "\"parentConversationId\": \"\(parentConversationId)\"",
                with: "\"parentConversationId\": \"\(localId)\""
            )
        }

        guard let jsonData = jsonString.data(using: .utf8) else { return }

        // Decode JSON off the main thread to avoid blocking UI during rapid SSE
        // streaming. A fresh JSONDecoder is created per call because JSONDecoder
        // is not documented as thread-safe by Apple.
        let message: ServerMessage? = await Task.detached(priority: .userInitiated) {
            let decoder = JSONDecoder()
            do {
                let event = try decoder.decode(AssistantEvent.self, from: jsonData)
                return event.message
            } catch {
                do {
                    return try decoder.decode(ServerMessage.self, from: jsonData)
                } catch {
                    let failedByteCount = jsonData.count
                    log.error("Failed to decode SSE event: \(error.localizedDescription, privacy: .public), bytes: \(failedByteCount, privacy: .public)")
                    return nil
                }
            }
        }.value

        // Timing instrumentation — tracks wall-clock time including the off-main
        // decode so the saturation metric still reflects total per-event cost.
        let elapsed = CFAbsoluteTimeGetCurrent() - start
        if elapsed > 0.05 || byteCount > 100_000 {
            log.warning("Slow SSE event: \(String(format: "%.1f", elapsed * 1000), privacy: .public)ms, \(byteCount, privacy: .public) bytes")
        }
        sseParseTimeAccumulator += elapsed
        sseParseCountInWindow += 1
        let now = CFAbsoluteTimeGetCurrent()
        if now - sseWindowStart > 1.0 {
            if sseParseTimeAccumulator > 0.5 {
                let totalMs = String(format: "%.0f", sseParseTimeAccumulator * 1000)
                let count = sseParseCountInWindow
                log.warning("SSE parse saturation: \(totalMs, privacy: .public)ms in \(count, privacy: .public) events over 1s")
            }
            sseParseTimeAccumulator = 0
            sseParseCountInWindow = 0
            sseWindowStart = now
        }

        // If the parent task was cancelled during the off-main decode (e.g.,
        // stopSSE() ran while we were suspended), discard the decoded message.
        // Without this guard, a stale .tokenRotated event could reopen the
        // stream after the caller explicitly stopped it.
        if Task.isCancelled { return }

        guard let message else { return }
        if shouldIgnoreHostToolRequest(message) { return }
        handleParsedMessage(message)
    }

    private func shouldIgnoreHostToolRequest(_ message: ServerMessage) -> Bool {
        switch message {
        case .hostBashRequest(let msg):
            if locallyOwnedConversationIds.contains(msg.conversationId) { return false }
            log.warning("Ignoring host_bash_request for non-local conversation \(msg.conversationId, privacy: .public)")
            return true
        case .hostFileRequest(let msg):
            if locallyOwnedConversationIds.contains(msg.conversationId) { return false }
            log.warning("Ignoring host_file_request for non-local conversation \(msg.conversationId, privacy: .public)")
            return true
        case .hostCuRequest(let msg):
            if locallyOwnedConversationIds.contains(msg.conversationId) { return false }
            log.warning("Ignoring host_cu_request for non-local conversation \(msg.conversationId, privacy: .public)")
            return true
        default:
            return false
        }
    }

    /// Handle a successfully parsed server message:
    /// 1. Intercept token_rotated (update credentials, reconnect SSE)
    /// 2. Call pre-processor (DaemonStatus state updates)
    /// 3. Broadcast to all subscribers
    private func handleParsedMessage(_ message: ServerMessage) {
        // Intercept token rotation — don't broadcast to subscribers
        if case .tokenRotated(let msg) = message {
            log.info("Received token_rotated event — reconnecting SSE")
            // Persist the new token so GatewayHTTPClient picks it up
            ActorTokenManager.setToken(msg.newToken)
            onTokenRefreshed?(msg.newToken)
            // Defer the stop/start to the next MainActor turn so the current
            // `bytes.lines` iteration can exit cleanly before we invalidate
            // the session. This avoids a self-cancellation race where
            // handleParsedMessage (called from inside the SSE loop) would
            // tear down the very session it's reading from.
            Task { @MainActor [weak self] in
                guard let self, self.shouldReconnect else { return }
                self.stopSSE()
                self.startSSE()
            }
            return
        }

        messagePreProcessor?(message)
        broadcastMessage(message)
    }

    /// Broadcast a message to all subscribers.
    public func broadcastMessage(_ message: ServerMessage) {
        for continuation in subscribers.values {
            continuation.yield(message)
        }
    }

    // MARK: - SSE Reconnect

    private func handleSSEDisconnect() {
        guard shouldReconnect, sseTask != nil else { return }
        scheduleSSEReconnect()
    }

    private func scheduleSSEReconnect() {
        sseReconnectTask?.cancel()

        let delay = sseReconnectDelay
        log.info("Scheduling SSE reconnect in \(delay, privacy: .public)s")

        sseReconnectTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            } catch {
                return
            }

            guard let self, self.shouldReconnect else { return }
            self.sseReconnectDelay = min(self.sseReconnectDelay * 2, self.maxReconnectDelay)
            self.startSSEStream()
        }
    }

    /// Reset SSE reconnect backoff to minimum (e.g. after an update completes).
    func resetSSEReconnectDelay() {
        sseReconnectDelay = 1.0
    }

    // MARK: - URLSession Lifecycle

    /// Invalidate the current SSE URLSession, cancelling its data task.
    /// Safe to call when `sseSession` is already nil.
    private func invalidateSSESession() {
        sseSession?.invalidateAndCancel()
        sseSession = nil
    }

    deinit {
        let continuations = subscribers.values
        for continuation in continuations {
            continuation.finish()
        }
    }
}
