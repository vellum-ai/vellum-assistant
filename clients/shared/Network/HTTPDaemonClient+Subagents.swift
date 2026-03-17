import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HTTPTransport")

// MARK: - Subagents Domain Dispatcher

extension HTTPTransport {

    func registerSubagentsRoutes() {
        registerDomainDispatcher { [weak self] message in
            guard let self else { return false }

            if let msg = message as? SubagentMessageRequest {
                Task { await self.handleSubagentMessage(subagentId: msg.subagentId, content: msg.content, conversationId: msg.conversationId) }
                return true
            }

            return false
        }
    }

    // MARK: - Conversation ID Translation

    /// Given a client-local conversation ID, find the corresponding server conversation ID
    /// by doing a reverse lookup in `serverToLocalConversationMap`. Returns the original ID
    /// if no mapping exists (the ID is already a server conversation ID, e.g. restored conversations).
    func serverConversationId(forLocal localId: String) -> String {
        for (serverId, mappedLocalId) in serverToLocalConversationMap {
            if mappedLocalId == localId {
                return serverId
            }
        }
        return localId
    }

    // MARK: - Subagents HTTP Endpoints

    private func handleSubagentMessage(subagentId: String, content: String, conversationId: String? = nil, isRetry: Bool = false) async {
        guard let url = buildURL(for: .subagentMessage(id: subagentId)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        // Translate client-local conversation ID → server conversation ID so the
        // server's ownership check (parentConversationId) passes.
        var body: [String: Any] = ["content": content]
        if let conversationId = conversationId {
            body["conversationId"] = serverConversationId(forLocal: conversationId)
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result { await handleSubagentMessage(subagentId: subagentId, content: content, conversationId: conversationId, isRetry: true) }
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    log.error("Subagent message failed (\(http.statusCode))")
                    return
                }
            }

            log.info("Subagent message sent for \(subagentId)")
        } catch {
            log.error("Subagent message error: \(error.localizedDescription)")
        }
    }
}
