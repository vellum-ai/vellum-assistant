import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HTTPTransport")

// MARK: - Conversation Domain Dispatcher

/// Registers a domain dispatcher that translates conversation-related message
/// types into HTTP API calls. Handles:
///   conversation_switch, conversation_rename, conversations_clear, cancel, undo,
///   model_get, model_set, image_gen_model_set,
///   conversation_search, message_content_request
extension HTTPTransport {

    func registerConversationRoutes() {
        registerDomainDispatcher { message in
            if message is ConversationSwitchRequest {
                // Handled by ConversationListClient via GatewayHTTPClient.
                return true
            } else if message is ConversationRenameRequest {
                // Handled by ConversationListClient via GatewayHTTPClient.
                return true
            } else if message is ConversationsClearRequest {
                // Handled by ConversationListClient via GatewayHTTPClient.
                return true
            } else if message is CancelMessage {
                // Handled by ConversationListClient via GatewayHTTPClient.
                return true
            } else if message is UndoRequest {
                // Handled by ConversationListClient via GatewayHTTPClient.
                return true
            } else if message is ModelGetRequestMessage || message is ModelSetRequestMessage {
                // Handled by SettingsClient via GatewayHTTPClient.
                return true
            } else if message is ImageGenModelSetRequestMessage {
                // Handled by SettingsClient via GatewayHTTPClient.
                return true
            } else if message is ConversationSearchRequest {
                // Handled by ConversationListClient via GatewayHTTPClient.
                return true
            } else if message is MessageContentRequest {
                // Handled by ConversationClient via GatewayHTTPClient.
                return true
            } else if message is DeleteQueuedMessageMessage {
                // Handled by ConversationQueueClient via GatewayHTTPClient.
                return true
            } else if message is ReorderConversationsRequest {
                // Handled by ConversationListClient via GatewayHTTPClient.
                return true
            }

            return false
        }
    }
}
