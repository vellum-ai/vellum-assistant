import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ConversationInferenceProfileClient")

/// Response shape for `PUT /v1/conversations/:id/inference-profile`. The
/// server emits `{ conversationId, profile }` where `profile` is `null`
/// when the conversation override was cleared.
public struct ConversationInferenceProfileResponse: Decodable, Sendable {
    public let conversationId: String
    public let profile: String?

    public init(conversationId: String, profile: String?) {
        self.conversationId = conversationId
        self.profile = profile
    }
}

public protocol ConversationInferenceProfileClientProtocol {
    /// Update the conversation's inference profile override. Pass `nil` to
    /// clear the override and fall back to the workspace `llm.activeProfile`.
    func setConversationInferenceProfile(
        conversationId: String,
        profile: String?
    ) async -> ConversationInferenceProfileResponse?
}

public struct ConversationInferenceProfileClient: ConversationInferenceProfileClientProtocol {
    nonisolated public init() {}

    public func setConversationInferenceProfile(
        conversationId: String,
        profile: String?
    ) async -> ConversationInferenceProfileResponse? {
        // The daemon route accepts `{ profile: <string|null> }` — Foundation's
        // JSON serializer renders `NSNull()` as `null`, which is the wire shape
        // the daemon's Zod schema (`z.string().nullable()`) expects.
        let body: [String: Any] = ["profile": profile ?? NSNull()]
        do {
            let response = try await GatewayHTTPClient.put(
                path: "assistants/{assistantId}/conversations/\(conversationId)/inference-profile",
                json: body
            )
            guard response.isSuccess else {
                log.warning("PUT /conversations/\(conversationId, privacy: .public)/inference-profile failed with status \(response.statusCode)")
                return nil
            }
            return try JSONDecoder().decode(ConversationInferenceProfileResponse.self, from: response.data)
        } catch {
            log.error("Failed to update conversation inference profile: \(error.localizedDescription)")
            return nil
        }
    }
}
