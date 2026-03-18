import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ConversationListClient")

/// Focused client for fetching the conversation list via the gateway.
@MainActor
public protocol ConversationListClientProtocol {
    func fetchConversationList(offset: Int, limit: Int) async -> ConversationListResponse?
}

/// Gateway-backed implementation of ``ConversationListClientProtocol``.
@MainActor
public struct ConversationListClient: ConversationListClientProtocol {
    nonisolated public init() {}

    public func fetchConversationList(offset: Int = 0, limit: Int = 50) async -> ConversationListResponse? {
        do {
            var params: [String: String] = [
                "limit": "\(limit)",
                "offset": "\(offset)",
            ]
            if offset == 0 { params.removeValue(forKey: "offset") }

            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/conversations", params: params, timeout: 15
            )
            guard response.isSuccess else {
                log.error("fetchConversationList failed (HTTP \(response.statusCode))")
                return nil
            }
            let decoded = try JSONDecoder().decode(HTTPConversationsListResponse.self, from: response.data)
            let items = decoded.conversations.map {
                ConversationListResponseItem(
                    id: $0.id, title: $0.title,
                    createdAt: $0.createdAt ?? $0.updatedAt,
                    updatedAt: $0.updatedAt,
                    conversationType: $0.conversationType,
                    source: $0.source,
                    scheduleJobId: $0.scheduleJobId,
                    channelBinding: $0.channelBinding,
                    conversationOriginChannel: $0.conversationOriginChannel,
                    conversationOriginInterface: $0.conversationOriginInterface,
                    assistantAttention: $0.assistantAttention,
                    displayOrder: $0.displayOrder,
                    isPinned: $0.isPinned
                )
            }
            return ConversationListResponse(
                type: "conversation_list_response",
                conversations: items,
                hasMore: decoded.hasMore
            )
        } catch {
            log.error("fetchConversationList error: \(error.localizedDescription)")
            return nil
        }
    }
}

// MARK: - Private HTTP Response DTO

/// Mirrors the HTTP API's conversation list response shape. The public
/// ``ConversationListResponse`` type requires a `type` discriminant that
/// the HTTP endpoint omits, so we decode into this private DTO first.
private struct HTTPConversationsListResponse: Decodable {
    struct Conversation: Decodable {
        let id: String
        let title: String
        let createdAt: Int?
        let updatedAt: Int
        let conversationType: String?
        let source: String?
        let scheduleJobId: String?
        let channelBinding: ChannelBinding?
        let conversationOriginChannel: String?
        let conversationOriginInterface: String?
        let assistantAttention: AssistantAttention?
        let displayOrder: Double?
        let isPinned: Bool?
    }
    let conversations: [Conversation]
    let hasMore: Bool?
}
