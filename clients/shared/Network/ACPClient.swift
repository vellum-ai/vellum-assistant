import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ACPClient")

/// Errors surfaced by ``ACPClient``.
///
/// Distinguishes the three failure modes the UI cares about so the
/// observable store (PR 15) can render network outages, server-side
/// failures, and decoding mismatches differently from "session simply
/// not found anymore" (which the methods report as a successful no-op).
public enum ACPClientError: LocalizedError {
    /// Request failed before reaching the daemon (network, auth, URL
    /// construction). Wraps the original ``GatewayHTTPClient/ClientError``.
    case transport(underlying: GatewayHTTPClient.ClientError)
    /// Daemon responded with a non-2xx, non-404 status.
    case httpError(statusCode: Int)
    /// Response body did not match the expected schema.
    case decodingFailed(underlying: Error)

    public var errorDescription: String? {
        switch self {
        case .transport(let underlying):
            return underlying.localizedDescription
        case .httpError(let statusCode):
            return "ACP request failed (HTTP \(statusCode))"
        case .decodingFailed(let underlying):
            return "Failed to decode ACP response: \(underlying.localizedDescription)"
        }
    }
}

/// Static HTTP client for ACP (Agent Client Protocol) session management.
///
/// Routes through ``GatewayHTTPClient`` so managed assistants use the
/// platform proxy with session-token auth while local assistants hit the
/// local gateway with bearer-token auth.
public enum ACPClient {

    /// Lists active ACP sessions known to the daemon.
    ///
    /// - Parameters:
    ///   - limit: Maximum number of sessions to return. Defaults to 50.
    ///   - conversationId: Optional filter — when set, only sessions whose
    ///     `parentConversationId` matches are returned.
    public static func listSessions(
        limit: Int = 50,
        conversationId: String? = nil
    ) async -> Result<[ACPSessionState], ACPClientError> {
        var params: [String: String] = ["limit": String(limit)]
        if let conversationId {
            params["conversationId"] = conversationId
        }

        let response: GatewayHTTPClient.Response
        do {
            response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/acp/sessions",
                params: params,
                timeout: 15
            )
        } catch let error as GatewayHTTPClient.ClientError {
            log.error("listSessions transport error: \(error.localizedDescription)")
            return .failure(.transport(underlying: error))
        } catch {
            log.error("listSessions error: \(error.localizedDescription)")
            return .failure(.transport(underlying: .invalidURL))
        }

        guard response.isSuccess else {
            log.error("listSessions failed (HTTP \(response.statusCode))")
            return .failure(.httpError(statusCode: response.statusCode))
        }
        do {
            let decoded = try JSONDecoder().decode(SessionsListResponse.self, from: response.data)
            return .success(decoded.sessions)
        } catch {
            log.error("listSessions decode error: \(error.localizedDescription)")
            return .failure(.decodingFailed(underlying: error))
        }
    }

    /// Cancels an active ACP session.
    ///
    /// - Parameter id: The ACP session id (the daemon's `acpSessionId`).
    /// - Returns: `.success(true)` on a 2xx response, `.success(false)` on a
    ///   404 (session already terminal or unknown — treated as a positive
    ///   "not running" signal), `.failure` on transport or other server errors.
    public static func cancelSession(
        id: String
    ) async -> Result<Bool, ACPClientError> {
        return await postExpectingAck(
            path: "assistants/{assistantId}/acp/\(id)/cancel",
            body: [:],
            label: "cancelSession"
        )
    }

    /// Sends a steering instruction to an active ACP session.
    ///
    /// - Parameters:
    ///   - id: The ACP session id (the daemon's `acpSessionId`).
    ///   - instruction: Free-form natural-language instruction the agent
    ///     should incorporate into its next turn.
    /// - Returns: `.success(true)` on a 2xx response, `.success(false)` on a
    ///   404, `.failure` on transport or other server errors.
    public static func steerSession(
        id: String,
        instruction: String
    ) async -> Result<Bool, ACPClientError> {
        return await postExpectingAck(
            path: "assistants/{assistantId}/acp/\(id)/steer",
            body: ["instruction": instruction],
            label: "steerSession"
        )
    }

    // MARK: - Helpers

    /// Sends a POST that returns an acknowledgement (200) or 404 (already gone).
    /// 404 is mapped to `.success(false)` so callers can distinguish "definitely
    /// not running" from "we don't know" — matching the Subagent abort contract.
    private static func postExpectingAck(
        path: String,
        body: [String: Any],
        label: String
    ) async -> Result<Bool, ACPClientError> {
        let response: GatewayHTTPClient.Response
        do {
            response = try await GatewayHTTPClient.post(
                path: path,
                json: body,
                timeout: 10
            )
        } catch let error as GatewayHTTPClient.ClientError {
            log.error("\(label) transport error: \(error.localizedDescription)")
            return .failure(.transport(underlying: error))
        } catch {
            log.error("\(label) error: \(error.localizedDescription)")
            return .failure(.transport(underlying: .invalidURL))
        }

        if response.isSuccess {
            return .success(true)
        }
        if response.statusCode == 404 {
            log.info("\(label) returned 404 — session already terminal or unknown")
            return .success(false)
        }
        log.error("\(label) failed (HTTP \(response.statusCode))")
        return .failure(.httpError(statusCode: response.statusCode))
    }

    /// Wire envelope for `GET /v1/acp/sessions`.
    private struct SessionsListResponse: Decodable {
        let sessions: [ACPSessionState]
    }
}
