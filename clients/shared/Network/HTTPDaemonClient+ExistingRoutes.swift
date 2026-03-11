import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HTTPTransport")

// MARK: - Existing HTTP Route Dispatchers

/// Registers domain dispatchers for the ~29 already-migrated message types
/// that are transported over HTTP (user_message, confirmation_response, etc.).
/// This keeps the main `send()` method thin and extensible — new domain
/// dispatchers can be added in separate extension files without modifying the
/// core dispatch loop.
extension HTTPTransport {

    func registerExistingRoutes() {
        registerDomainDispatcher { [weak self] message in
            guard let self else { return false }

            if let msg = message as? UserMessageMessage {
                Task { await self.sendMessage(content: msg.content, sessionId: msg.sessionId, attachments: msg.attachments) }
                return true
            } else if let msg = message as? ConfirmationResponseMessage {
                Task { await self.sendDecision(requestId: msg.requestId, decision: msg.decision, selectedPattern: msg.selectedPattern, selectedScope: msg.selectedScope) }
                return true
            } else if let msg = message as? SecretResponseMessage {
                Task { await self.sendSecret(requestId: msg.requestId, value: msg.value, delivery: msg.delivery) }
                return true
            } else if let msg = message as? SessionCreateMessage {
                // For HTTP transport, session creation is implicit — the conversationKey
                // acts as the session. Emit a synthetic session_info so ChatViewModel
                // records the session ID.
                let sessionId = (msg.correlationId.flatMap { $0.isEmpty ? nil : $0 }) ?? UUID().uuidString
                self.activeLocalSessionId = sessionId
                self.remoteSessionId = nil  // Reset — will be learned from the first SSE event
                let info = ServerMessage.sessionInfo(
                    SessionInfoMessage(sessionId: sessionId, title: msg.title ?? "New Chat", correlationId: msg.correlationId)
                )
                self.onMessage?(info)
                return true
            } else if let msg = message as? SessionListRequestMessage {
                Task { await self.fetchSessionList(offset: Int(msg.offset ?? 0), limit: Int(msg.limit ?? 50)) }
                return true
            } else if let msg = message as? HistoryRequestMessage {
                Task { await self.fetchHistory(sessionId: msg.sessionId) }
                return true
            } else if let msg = message as? IPCConversationSeenSignal {
                Task { await self.sendConversationSeen(msg) }
                return true
            } else if let msg = message as? IPCConversationUnreadSignal {
                Task {
                    do {
                        try await self.sendConversationUnread(msg)
                    } catch {
                        log.error("Conversation unread signal error: \(error.localizedDescription)")
                    }
                }
                return true
            } else if let msg = message as? GuardianActionsPendingRequestMessage {
                Task { await self.fetchGuardianActionsPending(conversationId: msg.conversationId) }
                return true
            } else if let msg = message as? GuardianActionDecisionMessage {
                Task { await self.submitGuardianActionDecision(requestId: msg.requestId, action: msg.action, conversationId: msg.conversationId) }
                return true
            } else if let msg = message as? UiSurfaceActionMessage {
                Task { await self.sendSurfaceAction(msg) }
                return true
            } else if let msg = message as? AddTrustRuleMessage {
                Task { await self.sendAddTrustRule(msg) }
                return true
            } else if message is TrustRulesListMessage {
                Task { await self.fetchTrustRules() }
                return true
            } else if let msg = message as? RemoveTrustRuleMessage {
                Task { await self.sendRemoveTrustRule(msg) }
                return true
            } else if let msg = message as? UpdateTrustRuleMessage {
                Task { await self.sendUpdateTrustRule(msg) }
                return true
            } else if let msg = message as? ContactsRequestMessage {
                Task { await self.handleContactsRequest(msg) }
                return true
            } else if message is PingMessage {
                // No-op for HTTP transport — SSE keepalive is handled by the connection
                return true
            }

            return false
        }
    }
}
