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
                Task { await self.sendMessage(content: msg.content, conversationId: msg.conversationId, attachments: msg.attachments, automated: msg.automated) }
                return true
            } else if message is ConfirmationResponseMessage {
                // Handled by InteractionClient via GatewayHTTPClient.
                return true
            } else if message is SecretResponseMessage {
                // Handled by InteractionClient via GatewayHTTPClient.
                return true
            } else if let msg = message as? ConversationCreateMessage {
                // For HTTP transport, conversation creation is implicit — the conversationKey
                // acts as the conversation. Emit a synthetic conversation_info so ChatViewModel
                // records the conversation ID.
                let conversationId = (msg.correlationId.flatMap { $0.isEmpty ? nil : $0 }) ?? UUID().uuidString
                // Remember private conversations so sendMessage can pass conversationType to the backend.
                if msg.conversationType == "private" {
                    self.privateConversationIds.insert(conversationId)
                }
                let info = ServerMessage.conversationInfo(
                    ConversationInfoMessage(conversationId: conversationId, title: msg.title ?? "New Chat", correlationId: msg.correlationId)
                )
                self.onMessage?(info)
                return true
            } else if message is ConversationListRequestMessage {
                // Handled by ConversationListClient via GatewayHTTPClient.
                return true
            } else if message is ConversationSeenSignal {
                // Handled by ConversationListClient via GatewayHTTPClient.
                return true
            } else if message is ConversationUnreadSignal {
                // Handled by ConversationUnreadClient via GatewayHTTPClient.
                return true
            } else if message is GuardianActionsPendingRequestMessage
                        || message is GuardianActionDecisionMessage {
                // Handled by GuardianClient via GatewayHTTPClient.
                return true
            } else if message is UiSurfaceActionMessage {
                // Handled by SurfaceActionClient via GatewayHTTPClient.
                return true
            } else if message is AddTrustRuleMessage
                        || message is TrustRulesListMessage
                        || message is RemoveTrustRuleMessage
                        || message is UpdateTrustRuleMessage {
                // Handled by TrustRuleClient via GatewayHTTPClient.
                return true
            } else if message is PingMessage {
                // No-op for HTTP transport — SSE keepalive is handled by the connection
                return true
            }

            return false
        }
    }
}
