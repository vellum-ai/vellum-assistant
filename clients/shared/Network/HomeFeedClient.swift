import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "HomeFeedClient")

/// Response envelope returned by `GET /v1/home/feed`.
///
/// Mirrors the JSON shape emitted by
/// `assistant/src/runtime/routes/home-feed-routes.ts::handleGetHomeFeed`:
/// `{ items, updatedAt, contextBanner }`.
public struct HomeFeedResponse: Codable, Sendable, Hashable {
    public let items: [FeedItem]
    public let updatedAt: Date
    public let contextBanner: ContextBanner

    public init(items: [FeedItem], updatedAt: Date, contextBanner: ContextBanner) {
        self.items = items
        self.updatedAt = updatedAt
        self.contextBanner = contextBanner
    }
}

/// Focused client for the Home activity feed.
///
/// Expressed in a `throws` style so `HomeFeedStore` can distinguish a
/// successful empty feed from a transport or decode failure and leave
/// its cached `items` alone on error instead of blanking the UI.
public protocol HomeFeedClient: Sendable {
    /// `GET /v1/home/feed?timeAwaySeconds=<int>`.
    func fetchFeed(timeAwaySeconds: TimeInterval) async throws -> HomeFeedResponse

    /// `PATCH /v1/home/feed/<itemId>` with body `{ "status": <raw> }`.
    /// Returns the updated `FeedItem` on success.
    func patchStatus(
        itemId: String,
        status: FeedItemStatus
    ) async throws -> FeedItem

    /// `POST /v1/home/feed/<itemId>/actions/<actionId>`.
    /// Returns the `conversationId` of the conversation the daemon created
    /// from the action's pre-seeded prompt.
    func triggerAction(
        itemId: String,
        actionId: String
    ) async throws -> String
}

/// Errors produced by ``DefaultHomeFeedClient``.
public enum HomeFeedClientError: LocalizedError {
    case httpError(statusCode: Int)
    case decodingFailed(underlying: Error)
    case missingConversationId

    public var errorDescription: String? {
        switch self {
        case .httpError(let statusCode):
            return "Home feed request failed (HTTP \(statusCode))"
        case .decodingFailed(let underlying):
            return "Failed to decode home feed response: \(underlying.localizedDescription)"
        case .missingConversationId:
            return "Home feed action response did not include a conversationId"
        }
    }
}

/// Gateway-backed implementation of ``HomeFeedClient``.
///
/// Hits `/v1/home/feed*` via ``GatewayHTTPClient`` — the assistant-scoped
/// path prefix (`assistants/{assistantId}/`) is rewritten to the flat
/// daemon path by the gateway's runtime proxy, matching the pattern used
/// by ``DefaultHomeStateClient``.
public struct DefaultHomeFeedClient: HomeFeedClient {
    nonisolated public init() {}

    public func fetchFeed(timeAwaySeconds: TimeInterval) async throws -> HomeFeedResponse {
        let seconds = max(0, Int(timeAwaySeconds.rounded()))
        let response: GatewayHTTPClient.Response
        do {
            response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/home/feed",
                params: ["timeAwaySeconds": String(seconds)],
                timeout: 10
            )
        } catch {
            log.error("fetchFeed transport error: \(error.localizedDescription)")
            throw error
        }

        guard response.isSuccess else {
            log.error("fetchFeed failed (HTTP \(response.statusCode))")
            throw HomeFeedClientError.httpError(statusCode: response.statusCode)
        }

        do {
            return try Self.makeDecoder().decode(HomeFeedResponse.self, from: response.data)
        } catch {
            log.error("fetchFeed decode error: \(error.localizedDescription)")
            throw HomeFeedClientError.decodingFailed(underlying: error)
        }
    }

    public func patchStatus(
        itemId: String,
        status: FeedItemStatus
    ) async throws -> FeedItem {
        let response: GatewayHTTPClient.Response
        do {
            response = try await GatewayHTTPClient.patch(
                path: "assistants/{assistantId}/home/feed/\(itemId)",
                json: ["status": status.rawValue],
                timeout: 10
            )
        } catch {
            log.error("patchStatus transport error: \(error.localizedDescription)")
            throw error
        }

        guard response.isSuccess else {
            log.error("patchStatus failed (HTTP \(response.statusCode))")
            throw HomeFeedClientError.httpError(statusCode: response.statusCode)
        }

        do {
            return try Self.makeDecoder().decode(FeedItem.self, from: response.data)
        } catch {
            log.error("patchStatus decode error: \(error.localizedDescription)")
            throw HomeFeedClientError.decodingFailed(underlying: error)
        }
    }

    public func triggerAction(
        itemId: String,
        actionId: String
    ) async throws -> String {
        let response: GatewayHTTPClient.Response
        do {
            response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/home/feed/\(itemId)/actions/\(actionId)",
                json: [:],
                timeout: 10
            )
        } catch {
            log.error("triggerAction transport error: \(error.localizedDescription)")
            throw error
        }

        guard response.isSuccess else {
            log.error("triggerAction failed (HTTP \(response.statusCode))")
            throw HomeFeedClientError.httpError(statusCode: response.statusCode)
        }

        struct TriggerActionResponse: Decodable { let conversationId: String }
        let decoded: TriggerActionResponse
        do {
            decoded = try Self.makeDecoder().decode(TriggerActionResponse.self, from: response.data)
        } catch {
            log.error("triggerAction decode error: \(error.localizedDescription)")
            throw HomeFeedClientError.decodingFailed(underlying: error)
        }
        guard !decoded.conversationId.isEmpty else {
            throw HomeFeedClientError.missingConversationId
        }
        return decoded.conversationId
    }

    /// Decoder configured to parse ISO-8601 timestamps so `FeedItem.timestamp`,
    /// `FeedItem.createdAt`, and `FeedItem.expiresAt` decode from the wire
    /// format written by the daemon (`toISOString()` output).
    private static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
