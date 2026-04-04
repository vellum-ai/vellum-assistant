import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ConversationAnalysisClient")

/// Focused client for triggering conversation analysis through the gateway.
public protocol ConversationAnalysisClientProtocol {
    func analyzeConversation(conversationId: String) async -> ConversationListResponseItem?
}

/// Gateway-backed implementation of ``ConversationAnalysisClientProtocol``.
public struct ConversationAnalysisClient: ConversationAnalysisClientProtocol {
    nonisolated public init() {}

    public func analyzeConversation(conversationId: String) async -> ConversationListResponseItem? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/conversations/\(conversationId)/analyze",
                json: [:],
                timeout: 30
            )
            guard response.isSuccess else {
                log.error("analyzeConversation failed (HTTP \(response.statusCode))")
                return nil
            }

            let decoded = try JSONDecoder().decode(ForkConversationResponse.self, from: response.data)
            return conversationSummary(from: decoded.conversation)
        } catch {
            log.error("analyzeConversation error: \(error.localizedDescription)")
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
            forkParent: conversation.forkParent
        )
    }
}
