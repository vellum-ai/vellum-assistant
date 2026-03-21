import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "EventStreamClient")

/// Client that manages an SSE connection to the assistant runtime and broadcasts
/// parsed `ServerMessage` values to multiple independent subscribers.
///
/// Replaces the SSE portion of `HTTPTransport` and the broadcast portion of
/// `GatewayConnectionManager`. Backed by `GatewayHTTPClient.stream()` for authenticated
/// SSE connections.
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

    // MARK: - SSE Parse Time Tracking

    private var sseParseTimeAccumulator: TimeInterval = 0
    private var sseParseCountInWindow: Int = 0
    private var sseWindowStart: CFAbsoluteTime = 0

    private let decoder = JSONDecoder()

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
        bypassSecretCheck: Bool? = nil
    ) {
        locallyOwnedConversationIds.insert(conversationId)

        Task { @MainActor [weak self] in
            guard let self else { return }
            let messageClient = MessageClient()
            let attachmentCount = attachments?.count ?? 0
            log.info("[send-pipeline] sendMessage start — attachmentCount=\(attachmentCount)")

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
                        log.error("Failed to upload attachment: \(attachment.filename)")
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
                bypassSecretCheck: bypassSecretCheck
            )

            switch sendResult {
            case .success(let serverConvId):
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
        sseTask?.cancel()

        sseTask = Task { @MainActor [weak self] in
            guard let self else { return }

            do {
                let (bytes, response) = try await GatewayHTTPClient.stream(
                    path: "assistants/{assistantId}/events",
                    timeout: .infinity
                )

                guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                    let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
                    log.error("SSE connection failed with status \(statusCode)")
                    if statusCode == 403 {
                        self.sseReconnectDelay = 1.0
                    }
                    self.handleSSEDisconnect()
                    return
                }

                log.info("SSE stream connected")

                for try await line in bytes.lines {
                    if Task.isCancelled { break }

                    if line.hasPrefix("data: ") {
                        let payload = String(line.dropFirst(6))
                        self.parseSSEData(payload)
                    }
                }
            } catch {
                if !Task.isCancelled {
                    log.error("SSE stream error: \(error.localizedDescription)")
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

    private func parseSSEData(_ data: String) {
        let byteCount = data.utf8.count
        let start = CFAbsoluteTimeGetCurrent()
        defer {
            let elapsed = CFAbsoluteTimeGetCurrent() - start
            if elapsed > 0.05 || byteCount > 100_000 {
                log.warning("Slow SSE event: \(String(format: "%.1f", elapsed * 1000))ms, \(byteCount) bytes")
            }
            sseParseTimeAccumulator += elapsed
            sseParseCountInWindow += 1
            let now = CFAbsoluteTimeGetCurrent()
            if now - sseWindowStart > 1.0 {
                if sseParseTimeAccumulator > 0.5 {
                    let totalMs = String(format: "%.0f", sseParseTimeAccumulator * 1000)
                    let count = sseParseCountInWindow
                    log.warning("SSE main-thread saturation: \(totalMs)ms in \(count) events over 1s")
                }
                sseParseTimeAccumulator = 0
                sseParseCountInWindow = 0
                sseWindowStart = now
            }
        }

        var jsonString = data

        // Remap server conversation IDs to client-local conversation IDs
        if let conversationId = extractJsonStringValue(from: jsonString, key: "conversationId"),
           let localId = serverToLocalConversationMap[conversationId] {
            jsonString = jsonString.replacingOccurrences(
                of: "\"conversationId\":\"\(conversationId)\"",
                with: "\"conversationId\":\"\(localId)\""
            )
            jsonString = jsonString.replacingOccurrences(
                of: "\"conversationId\": \"\(conversationId)\"",
                with: "\"conversationId\": \"\(localId)\""
            )
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

        do {
            let event = try decoder.decode(AssistantEvent.self, from: jsonData)
            if shouldIgnoreHostToolRequest(event.message) { return }
            handleParsedMessage(event.message)
        } catch {
            do {
                let message = try decoder.decode(ServerMessage.self, from: jsonData)
                if shouldIgnoreHostToolRequest(message) { return }
                handleParsedMessage(message)
            } catch {
                let byteCount = jsonData.count
                log.error("Failed to decode SSE event: \(error.localizedDescription), bytes: \(byteCount)")
            }
        }
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
            stopSSE()
            startSSE()
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
        log.info("Scheduling SSE reconnect in \(delay)s")

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

    deinit {
        let continuations = subscribers.values
        for continuation in continuations {
            continuation.finish()
        }
    }
}
