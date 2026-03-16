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
                Task { await self.switchSession(conversationId: msg.conversationId) }
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
            } else if let msg = message as? RegenerateMessage {
                Task { await self.regenerateLastResponse(conversationId: msg.conversationId) }
                return true
            } else if message is ModelGetRequestMessage {
                Task { await self.fetchModelInfo() }
                return true
            } else if let msg = message as? ModelSetRequestMessage {
                Task { await self.setModel(modelId: msg.model) }
                return true
            } else if let msg = message as? ImageGenModelSetRequestMessage {
                Task { await self.setImageGenModel(modelId: msg.model) }
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
            } else if let msg = message as? MessageContentRequest {
                Task { await self.fetchMessageContent(conversationId: msg.conversationId, messageId: msg.messageId) }
                return true
            } else if let msg = message as? DeleteQueuedMessageMessage {
                Task { await self.deleteQueuedMessage(conversationId: msg.conversationId, requestId: msg.requestId) }
                return true
            } else if let msg = message as? ReorderConversationsRequest {
                Task { await self.reorderConversations(updates: msg.updates) }
                return true
            }

            return false
        }
    }
}
