import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "CompactionPlaygroundClient")

/// Errors surfaced by ``CompactionPlaygroundClient``.
///
/// The 404 mapping distinguishes between "the playground feature is disabled"
/// (flat `/playground/*` routes returning 404 means the flag is off on the
/// daemon) and "this specific conversation doesn't exist" (a 404 on a
/// conversation-scoped route).
public enum CompactionPlaygroundError: Error {
    /// The playground feature flag is off — flat `/playground/*` routes
    /// returned 404.
    case notAvailable
    /// The requested conversation was not found.
    case notFound
    /// A non-2xx response that does not fit the other cases.
    case http(statusCode: Int)
}

/// Focused client for the daemon's compaction-playground HTTP surface.
///
/// All paths are gateway-relative and the gateway proxies to the daemon's
/// `/v1/*` routes. Paths with a `/conversations/<id>/` segment target a
/// specific conversation; paths without one target the global playground
/// namespace and surface 404 as ``CompactionPlaygroundError/notAvailable``
/// (a flag-off indicator).
public protocol CompactionPlaygroundClientProtocol {
    func forceCompact(conversationId: String) async throws -> CompactionForceResponse
    func seedConversation(turns: Int, avgTokensPerTurn: Int?, title: String?) async throws -> SeedConversationResponse
    func injectFailures(conversationId: String, consecutiveFailures: Int?, circuitOpenForMs: Int?) async throws
    func resetCircuit(conversationId: String) async throws
    func getState(conversationId: String) async throws -> CompactionStateResponse
    func listSeededConversations() async throws -> SeededConversationsListResponse
    func deleteSeededConversation(id: String) async throws -> DeleteSeededConversationsResponse
    func deleteAllSeededConversations() async throws -> DeleteSeededConversationsResponse
}

/// Gateway-backed implementation of ``CompactionPlaygroundClientProtocol``.
public struct CompactionPlaygroundClient: CompactionPlaygroundClientProtocol {
    nonisolated public init() {}

    // MARK: - Compaction actions (conversation-scoped)

    public func forceCompact(conversationId: String) async throws -> CompactionForceResponse {
        let path = "assistants/{assistantId}/conversations/\(conversationId)/playground/compact"
        let response = try await GatewayHTTPClient.post(path: path, json: [:], timeout: 120)
        try throwIfUnsuccessful(response, path: path)
        return try JSONDecoder().decode(CompactionForceResponse.self, from: response.data)
    }

    public func injectFailures(
        conversationId: String,
        consecutiveFailures: Int?,
        circuitOpenForMs: Int?
    ) async throws {
        let path = "assistants/{assistantId}/conversations/\(conversationId)/playground/inject-compaction-failures"
        let body = InjectFailuresRequest(
            consecutiveFailures: consecutiveFailures,
            circuitOpenForMs: circuitOpenForMs
        )
        let response = try await GatewayHTTPClient.post(
            path: path,
            json: try jsonObject(from: body),
            timeout: 15
        )
        try throwIfUnsuccessful(response, path: path)
    }

    public func resetCircuit(conversationId: String) async throws {
        let path = "assistants/{assistantId}/conversations/\(conversationId)/playground/reset-compaction-circuit"
        let response = try await GatewayHTTPClient.post(path: path, json: [:], timeout: 15)
        try throwIfUnsuccessful(response, path: path)
    }

    public func getState(conversationId: String) async throws -> CompactionStateResponse {
        let path = "assistants/{assistantId}/conversations/\(conversationId)/playground/compaction-state"
        let response = try await GatewayHTTPClient.get(path: path, timeout: 15)
        try throwIfUnsuccessful(response, path: path)
        return try JSONDecoder().decode(CompactionStateResponse.self, from: response.data)
    }

    // MARK: - Seeded conversations (global playground)

    public func seedConversation(
        turns: Int,
        avgTokensPerTurn: Int?,
        title: String?
    ) async throws -> SeedConversationResponse {
        let path = "assistants/{assistantId}/playground/seed-conversation"
        let body = SeedConversationRequest(
            turns: turns,
            avgTokensPerTurn: avgTokensPerTurn,
            title: title
        )
        let response = try await GatewayHTTPClient.post(
            path: path,
            json: try jsonObject(from: body),
            timeout: 60
        )
        try throwIfUnsuccessful(response, path: path)
        return try JSONDecoder().decode(SeedConversationResponse.self, from: response.data)
    }

    public func listSeededConversations() async throws -> SeededConversationsListResponse {
        let path = "assistants/{assistantId}/playground/seeded-conversations"
        let response = try await GatewayHTTPClient.get(path: path, timeout: 15)
        try throwIfUnsuccessful(response, path: path)
        return try JSONDecoder().decode(SeededConversationsListResponse.self, from: response.data)
    }

    public func deleteSeededConversation(id: String) async throws -> DeleteSeededConversationsResponse {
        let path = "assistants/{assistantId}/playground/seeded-conversations/\(id)"
        let response = try await GatewayHTTPClient.delete(path: path, timeout: 15)
        try throwIfUnsuccessful(response, path: path)
        return try JSONDecoder().decode(DeleteSeededConversationsResponse.self, from: response.data)
    }

    public func deleteAllSeededConversations() async throws -> DeleteSeededConversationsResponse {
        let path = "assistants/{assistantId}/playground/seeded-conversations"
        let response = try await GatewayHTTPClient.delete(path: path, timeout: 30)
        try throwIfUnsuccessful(response, path: path)
        return try JSONDecoder().decode(DeleteSeededConversationsResponse.self, from: response.data)
    }

    // MARK: - Helpers

    /// Serializes a `Codable` request body into the `[String: Any]` shape
    /// expected by `GatewayHTTPClient.post(path:json:timeout:)`.
    ///
    /// Optional properties set to `nil` are omitted from the JSON output by
    /// `JSONEncoder` (the default behaviour), matching the daemon's expected
    /// partial-update semantics for the playground requests.
    private func jsonObject<T: Encodable>(from value: T) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return object
    }

    /// Maps non-success responses to ``CompactionPlaygroundError``.
    ///
    /// 404 on a path without a `/conversations/` segment indicates the
    /// playground feature flag is disabled on the daemon — the daemon's
    /// `/v1/assistants/{id}/playground/*` routes aren't mounted when the flag
    /// is off. 404 on a conversation-scoped path indicates the conversation
    /// doesn't exist.
    private func throwIfUnsuccessful(_ response: GatewayHTTPClient.Response, path: String) throws {
        guard !response.isSuccess else { return }

        if response.statusCode == 404 {
            if path.contains("/conversations/") {
                log.error("compaction playground 404 (not found) for path \(path, privacy: .public)")
                throw CompactionPlaygroundError.notFound
            } else {
                log.error("compaction playground 404 (flag off) for path \(path, privacy: .public)")
                throw CompactionPlaygroundError.notAvailable
            }
        }

        log.error("compaction playground HTTP \(response.statusCode, privacy: .public) for path \(path, privacy: .public)")
        throw CompactionPlaygroundError.http(statusCode: response.statusCode)
    }
}
