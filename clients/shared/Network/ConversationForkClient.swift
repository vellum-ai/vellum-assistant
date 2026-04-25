import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ConversationForkClient")

/// Focused client for creating conversation forks through the gateway.
public protocol ConversationForkClientProtocol {
    func forkConversation(conversationId: String, throughMessageId: String?) async -> ConversationListResponseItem?
}

/// Gateway-backed implementation of ``ConversationForkClientProtocol``.
public struct ConversationForkClient: ConversationForkClientProtocol {
    nonisolated public init() {}

    public func forkConversation(conversationId: String, throughMessageId: String? = nil) async -> ConversationListResponseItem? {
        do {
            var body: [String: Any] = ["conversationId": conversationId]
            if let throughMessageId {
                body["throughMessageId"] = throughMessageId
            }

            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/conversations/fork",
                json: body,
                timeout: 15
            )
            guard response.isSuccess else {
                log.error("forkConversation failed (HTTP \(response.statusCode))")
                return nil
            }

            let decoded = try JSONDecoder().decode(ForkConversationResponse.self, from: response.data)
            return conversationSummary(from: decoded.conversation)
        } catch {
            log.error("forkConversation error: \(error.localizedDescription)")
            return nil
        }
    }

    private func conversationSummary(from conversation: ConversationsListResponse.Conversation) -> ConversationListResponseItem {
        // Old-daemon fallback: derive groupId from isPinned when the server doesn't send groupId.
        // Uses the literal "system:pinned" to avoid a cross-module dependency on ConversationGroup.
        let groupId = conversation.groupId ?? (conversation.isPinned == true ? "system:pinned" : nil)
        return ConversationListResponseItem(
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
            groupId: groupId,
            forkParent: conversation.forkParent,
            inferenceProfile: conversation.inferenceProfile
        )
    }
}
