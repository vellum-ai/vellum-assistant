import Foundation

/// Standalone client that talks directly to the Anthropic Messages API,
/// bypassing the Mac daemon entirely.
///
/// Implements `DaemonClientProtocol` so `ChatViewModel` can use it
/// interchangeably with `DaemonClient`.
@MainActor
public final class DirectClaudeClient: ObservableObject, DaemonClientProtocol {

    /// Always `true` — standalone mode doesn't require a persistent connection.
    /// API key presence is checked at send time so the chat UI is always accessible.
    public var isConnected: Bool { true }
    public var isBlobTransportAvailable: Bool { false }

    private var apiKey: String? {
        // First check the secure Keychain store, then fall back to the environment
        // (useful for CI or local dev without a keychain entry).
        APIKeyManager.shared.getAPIKey(provider: "anthropic")
        ?? ProcessInfo.processInfo.environment["ANTHROPIC_API_KEY"]
    }

    private var continuations: [UUID: AsyncStream<ServerMessage>.Continuation] = [:]
    private var activeTasks: [String: Task<Void, Never>] = [:] // sessionId → stream task
    private var pendingMessages: [String: [[String: Any]]] = [:] // sessionId → conversation history

    public init() {}

    // MARK: - DaemonClientProtocol

    public func subscribe() -> AsyncStream<ServerMessage> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<ServerMessage>.makeStream()
        continuations[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.continuations.removeValue(forKey: id)
            }
        }
        return stream
    }

    public func send<T: Encodable>(_ message: T) throws {
        if let msg = message as? SessionCreateMessage {
            handleSessionCreate(msg)
        } else if let msg = message as? UserMessageMessage {
            handleUserMessage(msg)
        } else if let msg = message as? CancelMessage {
            handleCancel(msg)
        }
        // Other message types are silently ignored — no daemon features in standalone mode
    }

    public func connect() async throws {
        // No persistent connection needed — the Anthropic API is stateless HTTP.
        // API key presence is validated at send time to keep the chat UI accessible
        // even when no key is yet configured.
    }

    public func disconnect() {
        for task in activeTasks.values { task.cancel() }
        activeTasks.removeAll()
        pendingMessages.removeAll()
        for continuation in continuations.values { continuation.finish() }
        continuations.removeAll()
    }

    // MARK: - Private Message Handlers

    private func handleSessionCreate(_ msg: SessionCreateMessage) {
        // Emit session_info so ChatViewModel can record the session ID.
        // Use correlationId as the session ID when available, otherwise generate one.
        let sessionId = msg.correlationId ?? UUID().uuidString
        let sessionInfo = ServerMessage.sessionInfo(
            SessionInfoMessage(sessionId: sessionId, title: msg.title ?? "New Chat", correlationId: msg.correlationId)
        )
        broadcast(sessionInfo)
    }

    private func handleUserMessage(_ msg: UserMessageMessage) {
        guard let key = apiKey else {
            // No API key — emit an error message so the user sees actionable feedback
            let sessionId = msg.sessionId
            let errMsg = ServerMessage.sessionError(SessionErrorMessage(
                sessionId: sessionId,
                code: .providerApi,
                userMessage: "No API key configured. Go to Settings → Anthropic API Key to add your key.",
                retryable: false
            ))
            broadcast(errMsg)
            broadcast(.messageComplete(MessageCompleteMessage(sessionId: sessionId)))
            return
        }
        let sessionId = msg.sessionId

        // Add user message to this session's conversation history
        let userContent = msg.content ?? ""
        pendingMessages[sessionId, default: []].append(["role": "user", "content": userContent])

        let task = Task { @MainActor in
            await self.streamCompletion(sessionId: sessionId, apiKey: key, messages: self.pendingMessages[sessionId] ?? [])
        }
        activeTasks[sessionId] = task
    }

    private func handleCancel(_ msg: CancelMessage) {
        let sessionId = msg.sessionId ?? ""
        activeTasks[sessionId]?.cancel()
        activeTasks.removeValue(forKey: sessionId)
        // Roll back any trailing user message that has no assistant reply yet,
        // in case the task was cancelled before streamCompletion could do it.
        if var history = pendingMessages[sessionId],
           !history.isEmpty,
           history.last?["role"] as? String == "user" {
            history.removeLast()
            pendingMessages[sessionId] = history.isEmpty ? nil : history
        }
        broadcast(.generationCancelled(GenerationCancelledMessage(sessionId: sessionId)))
    }

    // MARK: - Streaming Completion

    private func streamCompletion(sessionId: String, apiKey: String, messages: [[String: Any]]) async {
        var request = URLRequest(url: URL(string: "https://api.anthropic.com/v1/messages")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")

        let body: [String: Any] = [
            "model": "claude-opus-4-6",
            "max_tokens": 8192,
            "stream": true,
            "messages": messages
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        var assistantText = ""

        do {
            let (bytes, response) = try await URLSession.shared.bytes(for: request)

            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                let body = try await { () async throws -> String in
                    var raw = ""
                    for try await line in bytes.lines { raw += line }
                    return raw
                }()
                let userMessage: String
                if let data = body.data(using: .utf8),
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let error = json["error"] as? [String: Any],
                   let msg = error["message"] as? String {
                    userMessage = msg
                } else {
                    userMessage = "API error \(http.statusCode). Check your API key in Settings."
                }
                broadcast(.sessionError(SessionErrorMessage(sessionId: sessionId, code: .providerApi, userMessage: userMessage, retryable: false)))
                broadcast(.messageComplete(MessageCompleteMessage(sessionId: sessionId)))
                activeTasks.removeValue(forKey: sessionId)
                // Roll back the user message — no assistant reply was produced
                if var history = pendingMessages[sessionId], !history.isEmpty {
                    history.removeLast()
                    pendingMessages[sessionId] = history.isEmpty ? nil : history
                }
                return
            }

            for try await line in bytes.lines {
                if Task.isCancelled { break }
                guard line.hasPrefix("data: ") else { continue }
                let data = String(line.dropFirst(6))
                if data == "[DONE]" { break }

                guard let jsonData = data.data(using: .utf8),
                      let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else { continue }

                let eventType = json["type"] as? String ?? ""

                switch eventType {
                case "content_block_delta":
                    if let delta = json["delta"] as? [String: Any],
                       delta["type"] as? String == "text_delta",
                       let text = delta["text"] as? String {
                        assistantText += text
                        broadcast(.assistantTextDelta(AssistantTextDeltaMessage(text: text, sessionId: sessionId)))
                    }
                case "message_stop":
                    break
                default:
                    break
                }
            }
        } catch {
            if !Task.isCancelled {
                broadcast(.sessionError(SessionErrorMessage(
                    sessionId: sessionId,
                    code: .providerApi,
                    userMessage: error.localizedDescription,
                    retryable: true
                )))
            }
        }

        // Roll back the user message if no assistant text was produced (error or cancellation),
        // to preserve the alternating user/assistant invariant required by the Anthropic API.
        if assistantText.isEmpty {
            if var history = pendingMessages[sessionId], !history.isEmpty {
                history.removeLast()
                pendingMessages[sessionId] = history.isEmpty ? nil : history
            }
        }

        // Append the full assistant reply to this session's history for multi-turn support
        if !assistantText.isEmpty {
            pendingMessages[sessionId, default: []].append(["role": "assistant", "content": assistantText])
        }

        broadcast(.messageComplete(MessageCompleteMessage(sessionId: sessionId)))
        activeTasks.removeValue(forKey: sessionId)
    }

    // MARK: - Broadcast

    private func broadcast(_ message: ServerMessage) {
        for continuation in continuations.values {
            continuation.yield(message)
        }
    }

    // MARK: - Errors

    public enum DirectClientError: Error, LocalizedError {
        case noAPIKey

        public var errorDescription: String? {
            "No Anthropic API key configured. Go to Settings to add one."
        }
    }
}
