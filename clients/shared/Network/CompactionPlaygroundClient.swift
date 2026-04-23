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
    /// On a 404, the daemon now distinguishes the two cases via a
    /// machine-readable `code` field in the JSON body: `playground_disabled`
    /// (the `compaction-playground` feature flag is off, surfaced as
    /// ``CompactionPlaygroundError/notAvailable``) and
    /// `conversation_not_found` (the requested conversation doesn't exist,
    /// surfaced as ``CompactionPlaygroundError/notFound``). The body-based
    /// classifier is required for conversation-scoped routes
    /// (`forceCompact`, `injectFailures`, `resetCircuit`, `getState`)
    /// because the daemon's `assertPlaygroundEnabled` guard runs *before*
    /// the conversation lookup — a flag-off 404 and a missing-conversation
    /// 404 hit the same URL, so a URL-path heuristic alone misclassifies
    /// flag-off as `.notFound`.
    ///
    /// A URL-path fallback remains for deploy-time version skew: an updated
    /// client may briefly talk to an old daemon that returns the legacy
    /// generic `NOT_FOUND` body (or no parseable body at all). The fallback
    /// preserves the previous classification heuristic so the UX doesn't
    /// regress during the rollout window.
    private func throwIfUnsuccessful(_ response: GatewayHTTPClient.Response, path: String) throws {
        guard !response.isSuccess else { return }

        if response.statusCode == 404 {
            if let code = parseErrorCode(from: response.data) {
                switch code {
                case "playground_disabled":
                    log.error("compaction playground 404 (flag off) for path \(path, privacy: .public)")
                    throw CompactionPlaygroundError.notAvailable
                case "conversation_not_found":
                    log.error("compaction playground 404 (conversation not found) for path \(path, privacy: .public)")
                    throw CompactionPlaygroundError.notFound
                default:
                    // Unknown body code — fall through to the path heuristic
                    // rather than swallowing as a generic HTTP 404.
                    break
                }
            }

            // Path-based fallback for old daemons that don't include the
            // distinguishing `code` field. Conversation-scoped routes 404 if
            // the conversation is missing; flat `/playground/*` routes 404
            // if the flag is off. This matches the pre-fix behavior.
            if path.contains("/conversations/") {
                log.error("compaction playground 404 (not found, fallback) for path \(path, privacy: .public)")
                throw CompactionPlaygroundError.notFound
            } else {
                log.error("compaction playground 404 (flag off, fallback) for path \(path, privacy: .public)")
                throw CompactionPlaygroundError.notAvailable
            }
        }

        log.error("compaction playground HTTP \(response.statusCode, privacy: .public) for path \(path, privacy: .public)")
        throw CompactionPlaygroundError.http(statusCode: response.statusCode)
    }

    /// Best-effort parse of `{ "error": { "code": "<string>" } }` from the
    /// response body. Returns `nil` on any structural mismatch so the caller
    /// can fall back to a URL-path heuristic rather than throwing on
    /// malformed bodies.
    private func parseErrorCode(from data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let errorObj = json["error"] as? [String: Any],
              let code = errorObj["code"] as? String else {
            return nil
        }
        return code
    }
}
