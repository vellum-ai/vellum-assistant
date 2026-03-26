import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ConversationDetailClient")

/// Focused client for fetching a single conversation summary through the gateway.
@MainActor
public protocol ConversationDetailClientProtocol {
    func fetchConversation(conversationId: String) async -> ConversationListResponseItem?
}

/// Gateway-backed implementation of ``ConversationDetailClientProtocol``.
@MainActor
public struct ConversationDetailClient: ConversationDetailClientProtocol {
    nonisolated public init() {}

    public func fetchConversation(conversationId: String) async -> ConversationListResponseItem? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/conversations/\(conversationId)",
                timeout: 15
            )
            guard response.isSuccess else {
                log.error("fetchConversation failed (HTTP \(response.statusCode))")
                return nil
            }

            let decoded = try JSONDecoder().decode(SingleConversationResponse.self, from: response.data)
            return conversationSummary(from: decoded.conversation)
        } catch {
            log.error("fetchConversation error: \(error.localizedDescription)")
            return nil
        }
    }

    private func conversationSummary(from conversation: ConversationsListResponse.Conversation) -> ConversationListResponseItem {
        ConversationListResponseItem(
            id: conversation.id,
            title: conversation.title,
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
            conversationType: conversation.conversationType,
            source: conversation.source,
            scheduleJobId: conversation.scheduleJobId,
            channelBinding: conversation.channelBinding,
            conversationOriginChannel: conversation.conversationOriginChannel,
            conversationOriginInterface: conversation.conversationOriginInterface,
            assistantAttention: conversation.assistantAttention,
            displayOrder: conversation.displayOrder,
            isPinned: conversation.isPinned,
            forkParent: conversation.forkParent
        )
    }
}
