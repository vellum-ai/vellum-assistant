import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "HomeStateClient")

/// Focused client for fetching the current `RelationshipState` from the
/// assistant runtime via the gateway.
///
/// The protocol is expressed in a `throws` style (unlike most sibling
/// clients that return optionals) so that `HomeStore` can distinguish a
/// successful empty state from a transport or decode failure, and leave
/// its cached `state` untouched on error instead of blanking it.
public protocol HomeStateClient: Sendable {
    func fetchRelationshipState() async throws -> RelationshipState
}

/// Errors produced by ``DefaultHomeStateClient``.
public enum HomeStateClientError: LocalizedError {
    case httpError(statusCode: Int)
    case decodingFailed(underlying: Error)

    public var errorDescription: String? {
        switch self {
        case .httpError(let statusCode):
            return "Home state request failed (HTTP \(statusCode))"
        case .decodingFailed(let underlying):
            return "Failed to decode home state: \(underlying.localizedDescription)"
        }
    }
}

/// Gateway-backed implementation of ``HomeStateClient``.
///
/// Hits `GET /v1/home/state` via ``GatewayHTTPClient`` — the assistant-scoped
/// path prefix (`assistants/{assistantId}/`) is rewritten to the flat daemon
/// path by the gateway's runtime proxy, matching the pattern used by
/// `IdentityClient`, `AppsClient`, etc.
public struct DefaultHomeStateClient: HomeStateClient {
    nonisolated public init() {}

    public func fetchRelationshipState() async throws -> RelationshipState {
        let response: GatewayHTTPClient.Response
        do {
            response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/home/state", timeout: 10
            )
        } catch {
            log.error("fetchRelationshipState transport error: \(error.localizedDescription)")
            throw error
        }

        guard response.isSuccess else {
            log.error("fetchRelationshipState failed (HTTP \(response.statusCode))")
            throw HomeStateClientError.httpError(statusCode: response.statusCode)
        }

        do {
            return try JSONDecoder().decode(RelationshipState.self, from: response.data)
        } catch {
            log.error("fetchRelationshipState decode error: \(error.localizedDescription)")
            throw HomeStateClientError.decodingFailed(underlying: error)
        }
    }
}
