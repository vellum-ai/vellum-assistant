import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ConversationHostAccessClient")

public struct ConversationHostAccessResponse: Decodable, Sendable {
    public let conversationId: String
    public let hostAccess: Bool

    public init(conversationId: String, hostAccess: Bool) {
        self.conversationId = conversationId
        self.hostAccess = hostAccess
    }
}

public protocol ConversationHostAccessClientProtocol {
    func fetchConversationHostAccess(conversationId: String) async -> ConversationHostAccessResponse?
    func updateConversationHostAccess(conversationId: String, hostAccess: Bool) async -> ConversationHostAccessResponse?
}

public struct ConversationHostAccessClient: ConversationHostAccessClientProtocol {
    nonisolated public init() {}

    public func fetchConversationHostAccess(conversationId: String) async -> ConversationHostAccessResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/conversations/\(conversationId)/host-access",
                quiet: true
            )
            guard response.isSuccess else {
                log.warning("GET /conversations/\(conversationId, privacy: .public)/host-access failed with status \(response.statusCode)")
                return nil
            }
            return try JSONDecoder().decode(ConversationHostAccessResponse.self, from: response.data)
        } catch {
            log.error("Failed to fetch conversation host access: \(error.localizedDescription)")
            return nil
        }
    }

    public func updateConversationHostAccess(
        conversationId: String,
        hostAccess: Bool
    ) async -> ConversationHostAccessResponse? {
        do {
            let response = try await GatewayHTTPClient.patch(
                path: "assistants/{assistantId}/conversations/\(conversationId)/host-access",
                json: ["hostAccess": hostAccess]
            )
            guard response.isSuccess else {
                log.warning("PATCH /conversations/\(conversationId, privacy: .public)/host-access failed with status \(response.statusCode)")
                return nil
            }
            return try JSONDecoder().decode(ConversationHostAccessResponse.self, from: response.data)
        } catch {
            log.error("Failed to update conversation host access: \(error.localizedDescription)")
            return nil
        }
    }
}
