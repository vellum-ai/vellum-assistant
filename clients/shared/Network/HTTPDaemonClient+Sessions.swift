import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HTTPTransport")

// MARK: - Session Domain Dispatcher

/// Registers a domain dispatcher that translates session-related message
/// types into HTTP API calls. Handles:
///   session_switch, session_rename, sessions_clear, cancel, undo,
///   regenerate, model_get, model_set, image_gen_model_set,
///   conversation_search, message_content_request, delete_queued_message
extension HTTPTransport {

    func registerSessionRoutes() {
        registerDomainDispatcher { [weak self] message in
            guard let self else { return false }

            if let msg = message as? IPCSessionSwitchRequest {
                Task { await self.switchSession(conversationId: msg.sessionId) }
                return true
            } else if let msg = message as? IPCSessionRenameRequest {
                Task { await self.renameSession(sessionId: msg.sessionId, name: msg.title) }
                return true
            } else if message is IPCSessionsClearRequest {
                Task { await self.clearAllSessions() }
                return true
            } else if let msg = message as? CancelMessage {
                Task { await self.cancelGeneration(sessionId: msg.sessionId ?? "") }
                return true
            } else if let msg = message as? IPCUndoRequest {
                Task { await self.undoLastMessage(sessionId: msg.sessionId) }
                return true
            } else if let msg = message as? RegenerateMessage {
                Task { await self.regenerateLastResponse(sessionId: msg.sessionId) }
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
            } else if let msg = message as? IPCConversationSearchRequest {
                Task {
                    await self.searchConversations(
                        query: msg.query,
                        limit: msg.limit.flatMap { Int($0) },
                        maxMessagesPerConversation: msg.maxMessagesPerConversation.flatMap { Int($0) }
                    )
                }
                return true
            } else if let msg = message as? IPCMessageContentRequest {
                Task { await self.fetchMessageContent(sessionId: msg.sessionId, messageId: msg.messageId) }
                return true
            } else if let msg = message as? DeleteQueuedMessageMessage {
                Task { await self.deleteQueuedMessage(sessionId: msg.sessionId, requestId: msg.requestId) }
                return true
            }

            return false
        }
    }
}
