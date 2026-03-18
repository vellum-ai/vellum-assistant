import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HTTPTransport")

// MARK: - Conversation Domain Dispatcher

/// Registers a domain dispatcher that translates conversation-related message
/// types into HTTP API calls. Handles:
///   conversation_switch, conversation_rename, conversations_clear, cancel, undo,
///   regenerate, model_get, model_set, image_gen_model_set,
///   conversation_search, message_content_request, delete_queued_message
extension HTTPTransport {

    func registerConversationRoutes() {
        registerDomainDispatcher { [weak self] message in
            guard let self else { return false }

            if let msg = message as? ConversationSwitchRequest {
                Task { await self.switchConversation(conversationId: msg.conversationId) }
                return true
            } else if let msg = message as? ConversationRenameRequest {
                Task { await self.renameConversation(conversationId: msg.conversationId, name: msg.title) }
                return true
            } else if message is ConversationsClearRequest {
                Task { await self.clearAllConversations() }
                return true
            } else if let msg = message as? CancelMessage {
                Task { await self.cancelGeneration(conversationId: msg.conversationId ?? "") }
                return true
            } else if let msg = message as? UndoRequest {
                Task { await self.undoLastMessage(conversationId: msg.conversationId) }
                return true
            } else if message is RegenerateMessage {
                // Handled by ConversationListClient via GatewayHTTPClient.
                return true
            } else if message is ModelGetRequestMessage || message is ModelSetRequestMessage {
                // Handled by SettingsClient via GatewayHTTPClient.
                return true
            } else if message is ImageGenModelSetRequestMessage {
                // Handled by SettingsClient via GatewayHTTPClient.
                return true
            } else if let msg = message as? ConversationSearchRequest {
                Task {
                    await self.searchConversations(
                        query: msg.query,
                        limit: msg.limit.flatMap { Int($0) },
                        maxMessagesPerConversation: msg.maxMessagesPerConversation.flatMap { Int($0) }
                    )
                }
                return true
            } else if message is MessageContentRequest {
                // Handled by ConversationListClient via GatewayHTTPClient.
                return true
            } else if message is DeleteQueuedMessageMessage {
                // Handled by ConversationListClient via GatewayHTTPClient.
                return true
            } else if let msg = message as? ReorderConversationsRequest {
                Task { await self.reorderConversations(updates: msg.updates) }
                return true
            }

            return false
        }
    }
}
