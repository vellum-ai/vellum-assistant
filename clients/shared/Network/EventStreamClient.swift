import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "EventStreamClient")

private struct SSEHandshakeSnapshot: Sendable {
    let statusCode: Int
    let contentType: String
    let contentLength: String
    let server: String
    let via: String
    let trace: String

    init(http: HTTPURLResponse) {
        statusCode = http.statusCode
        contentType = http.value(forHTTPHeaderField: "Content-Type") ?? "<nil>"
        contentLength = http.value(forHTTPHeaderField: "Content-Length") ?? "<nil>"
        server = http.value(forHTTPHeaderField: "Server") ?? "<nil>"
        via = http.value(forHTTPHeaderField: "Via") ?? "<nil>"
        trace = Self.firstHeaderValue(
            in: http,
            names: ["X-Request-Id", "X-Correlation-Id", "Cf-Ray", "X-Amzn-Trace-Id"]
        ) ?? "<nil>"
    }

    var summary: String {
        "status=\(statusCode) content-type=\(contentType) content-length=\(contentLength) server=\(server) via=\(via) trace=\(trace)"
    }

    var isEventStream: Bool {
        contentType.localizedCaseInsensitiveContains("text/event-stream")
    }

    private static func firstHeaderValue(in http: HTTPURLResponse, names: [String]) -> String? {
        for name in names {
            if let value = http.value(forHTTPHeaderField: name), !value.isEmpty {
                return "\(name)=\(value)"
            }
        }
        return nil
    }
}

private actor SSEHandshakeDiagnostics {
    private var lastResponse: SSEHandshakeSnapshot?

    func reset() {
        lastResponse = nil
    }

    func record(_ response: URLResponse) {
        if let http = response as? HTTPURLResponse {
            lastResponse = SSEHandshakeSnapshot(http: http)
        }
    }

    func snapshot() -> SSEHandshakeSnapshot? {
        lastResponse
    }
}

private final class SSEHandshakeCaptureDelegate: NSObject, URLSessionDataDelegate {
    private let diagnostics: SSEHandshakeDiagnostics

    init(diagnostics: SSEHandshakeDiagnostics) {
        self.diagnostics = diagnostics
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        Task {
            await diagnostics.record(response)
        }
        completionHandler(.allow)
    }
}

/// Client that manages an SSE connection to the assistant runtime and broadcasts
/// parsed `ServerMessage` values to multiple independent subscribers.
///
/// Backed by `GatewayHTTPClient.stream()` for authenticated SSE connections.
@MainActor
public final class EventStreamClient {

    // MARK: - Broadcast Subscribers

    /// Mutable filter that a subscriber can update as its conversation changes.
    /// Passed by reference so callers can set `conversationId` after subscribing
    /// (e.g. when `conversationInfo` arrives and assigns the conversation ID).
    public final class ConversationFilter: @unchecked Sendable {
        public var conversationId: String?
        public init(conversationId: String? = nil) { self.conversationId = conversationId }
    }

    private struct Subscription {
        let continuation: AsyncStream<ServerMessage>.Continuation
        let filter: ConversationFilter?
    }

    private var subscribers: [UUID: Subscription] = [:]

    /// Creates a new message stream for the caller.
    ///
    /// - Parameter filter: Optional conversation filter. When provided,
    ///   messages whose `conversationId` doesn't match are not delivered,
    ///   reducing unnecessary subscriber wakeups. Messages with no
    ///   `conversationId` (system-level) are always delivered.
    public func subscribe(filter: ConversationFilter? = nil) -> AsyncStream<ServerMessage> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<ServerMessage>.makeStream()
        subscribers[id] = Subscription(continuation: continuation, filter: filter)
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
    private var tokenRotationTask: Task<Void, Never>?
    private var sseReconnectDelay: TimeInterval = 1.0
    private let maxReconnectDelay: TimeInterval = 30.0
    private var shouldReconnect = true
    private var hasShownCreditsExhausted = false
    private var hasConnectedAtLeastOnce = false
    private let sseHandshakeDiagnostics = SSEHandshakeDiagnostics()

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
    ///
    /// Cancelling `sseTask` propagates through `URLSession.bytes(for:delegate:)`'s
    /// `withTaskCancellationHandler` to the underlying data task, so the Task-local
    /// `URLSession` is torn down by the `defer` block inside `startSSEStream`.
    public func stopSSE() {
        tokenRotationTask?.cancel()
        tokenRotationTask = nil
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
    }

    /// Disconnect and finish all subscriber streams.
    func teardown() {
        shouldReconnect = false
        stopSSE()
        for subscriber in subscribers.values {
            subscriber.continuation.finish()
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
        onboarding: PreChatOnboardingContext? = nil,
        clientMessageId: String? = nil,
        inferenceProfile: String? = nil,
        riskThreshold: String? = nil
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
            let isManaged = (try? GatewayHTTPClient.isConnectionManaged()) == true
            if let attachments, !attachments.isEmpty {
                for attachment in attachments {
                    var result: AttachmentUploadResult
                    if isManaged, let rawData = attachment.rawData {
                        // Try multipart first for managed connections
                        log.info("[send-pipeline] multipart upload — filename=\(attachment.filename, privacy: .public)")
                        result = await messageClient.uploadAttachmentMultipart(
                            filename: attachment.filename,
                            mimeType: attachment.mimeType,
                            data: rawData
                        )
                        // If server doesn't support multipart yet (400/415), retry with JSON+base64
                        if case .multipartNotSupported = result {
                            log.info("[send-pipeline] multipart failed, retrying with JSON+base64 — filename=\(attachment.filename, privacy: .public)")
                            result = await messageClient.uploadAttachment(
                                filename: attachment.filename,
                                mimeType: attachment.mimeType,
                                data: attachment.data,
                                filePath: attachment.filePath
                            )
                        }
                    } else {
                        // Local: file-backed or JSON+base64
                        result = await messageClient.uploadAttachment(
                            filename: attachment.filename,
                            mimeType: attachment.mimeType,
                            data: attachment.data,
                            filePath: attachment.filePath
                        )
                    }
                    switch result {
                    case .success(let id):
                        attachmentIds.append(id)
                    case .terminalAuthFailure:
                        return
                    case .transientFailure, .multipartNotSupported:
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
            let sendResult = await messageClient.sendMessage(
                content: content,
                conversationKey: conversationId,
                attachmentIds: attachmentIds,
                conversationType: conversationType,
                automated: automated,
                bypassSecretCheck: bypassSecretCheck,
                onboarding: onboarding,
                clientMessageId: clientMessageId,
                inferenceProfile: inferenceProfile,
                riskThreshold: riskThreshold
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
        sseTask?.cancel()

        // Keep the session local to this stream start and capture it into the
        // Task so nothing outside the Task can invalidate it mid-setup. The
        // delegate records the initial response headers, which lets us log the
        // last SSE handshake metadata when `bytes(for:)` later fails with a
        // generic parse error.
        let handshakeCaptureDelegate = SSEHandshakeCaptureDelegate(diagnostics: sseHandshakeDiagnostics)
        let session = URLSession(
            configuration: .default,
            delegate: handshakeCaptureDelegate,
            delegateQueue: nil
        )
        sseTask = Task { @MainActor [weak self] in
            defer { session.invalidateAndCancel() }

            guard let self, !Task.isCancelled else { return }

            do {
                await self.sseHandshakeDiagnostics.reset()
                let (bytes, response) = try await GatewayHTTPClient.stream(
                    path: "events",
                    timeout: .infinity,
                    session: session
                )

                guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                    let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
                    if let http = response as? HTTPURLResponse {
                        self.logSSEHandshakeFailure(http)
                    } else {
                        log.error("SSE connection failed with status \(statusCode, privacy: .public)")
                    }
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
                let handshake = SSEHandshakeSnapshot(http: http)
                log.info("SSE stream connected: \(handshake.summary, privacy: .public)")
                if !handshake.isEventStream {
                    log.error("SSE stream connected with unexpected content type: \(handshake.summary, privacy: .public)")
                }

                // On reconnect (not the first connect), broadcast a synthetic
                // conversation_list_invalidated so any events missed during the
                // disconnect window are recovered via the normal refetch path.
                // Without this, a pin/rename/reorder that landed while SSE was
                // reconnecting would leave the sidebar stale until app restart.
                if self.hasConnectedAtLeastOnce {
                    self.broadcastMessage(
                        .conversationListInvalidated(
                            ConversationListInvalidatedMessage(reason: "sse_reconnected")
                        )
                    )
                    NotificationCenter.default.post(name: .eventStreamDidReconnect, object: self)
                }
                self.hasConnectedAtLeastOnce = true

                for try await line in bytes.lines {
                    if Task.isCancelled { break }

                    if line.hasPrefix("data: ") {
                        let payload = String(line.dropFirst(6))
                        await self.parseSSEData(payload)
                    }
                }
            } catch {
                if !Task.isCancelled {
                    await self.logSSEStreamError(error)
                }
            }

            if !Task.isCancelled {
                self.handleSSEDisconnect()
            }
        }
    }

    private func logSSEHandshakeFailure(_ http: HTTPURLResponse) {
        let handshake = SSEHandshakeSnapshot(http: http)
        log.error("SSE connection failed: \(handshake.summary, privacy: .public)")
    }

    private func logSSEStreamError(_ error: Error) async {
        let nsError = error as NSError
        let metadata: String
        if let handshake = await sseHandshakeDiagnostics.snapshot() {
            metadata = handshake.summary
        } else {
            metadata = "no-response-metadata"
        }
        log.error(
            "SSE stream error: domain=\(nsError.domain, privacy: .public) code=\(nsError.code, privacy: .public) message=\(error.localizedDescription, privacy: .public) \(metadata, privacy: .public)"
        )
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
        // Track the final (remapped) conversation ID for broadcast filtering.
        var broadcastConversationId: String?
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
            broadcastConversationId = localId ?? conversationId
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
        handleParsedMessage(message, conversationId: broadcastConversationId)
    }

    private func shouldIgnoreHostToolRequest(_ message: ServerMessage) -> Bool {
        switch message {
        case .hostBashRequest(let msg):
            // Targeted cross-client requests carry a non-local conversationId by design.
            // Pass them through so AppDelegate+ConnectionSetup can perform the targetClientId check.
            if msg.targetClientId != nil { return false }
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
        case .hostAppControlRequest(let msg):
            if locallyOwnedConversationIds.contains(msg.conversationId) { return false }
            log.warning("Ignoring host_app_control_request for non-local conversation \(msg.conversationId, privacy: .public)")
            return true
        case .hostBrowserRequest(let msg):
            if locallyOwnedConversationIds.contains(msg.conversationId) { return false }
            log.warning("Ignoring host_browser_request for non-local conversation \(msg.conversationId, privacy: .public)")
            return true
        case .hostTransferRequest(let msg):
            if locallyOwnedConversationIds.contains(msg.conversationId) { return false }
            log.warning("Ignoring host_transfer_request for non-local conversation \(msg.conversationId, privacy: .public)")
            return true
        default:
            return false
        }
    }

    /// Handle a successfully parsed server message:
    /// 1. Intercept token_rotated (update credentials, reconnect SSE)
    /// 2. Call pre-processor (DaemonStatus state updates)
    /// 3. Broadcast to all subscribers
    private func handleParsedMessage(_ message: ServerMessage, conversationId: String? = nil) {
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
            tokenRotationTask?.cancel()
            tokenRotationTask = Task { @MainActor [weak self] in
                guard !Task.isCancelled else { return }
                guard let self, self.shouldReconnect else { return }
                self.stopSSE()
                self.startSSE()
            }
            return
        }

        messagePreProcessor?(message)
        broadcastMessage(message, conversationId: conversationId)
    }

    /// Broadcast a message to subscribers. When `conversationId` is provided,
    /// subscribers with a non-matching conversation filter are skipped.
    public func broadcastMessage(_ message: ServerMessage, conversationId: String? = nil) {
        for subscriber in subscribers.values {
            if let filterConvId = subscriber.filter?.conversationId,
               let messageConvId = conversationId,
               filterConvId != messageConvId {
                continue
            }
            subscriber.continuation.yield(message)
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

    deinit {
        tokenRotationTask?.cancel()
        sseReconnectTask?.cancel()
        sseTask?.cancel()
        for subscriber in subscribers.values {
            subscriber.continuation.finish()
        }
    }
}
