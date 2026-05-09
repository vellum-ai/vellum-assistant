import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "BookmarkClient")

public enum BookmarkClientError: Error, LocalizedError {
    case requestFailed(Int)

    public var errorDescription: String? {
        switch self {
        case .requestFailed(let code):
            return "Bookmark request failed (HTTP \(code))"
        }
    }
}

/// Focused client for message-bookmark operations routed through the gateway.
///
/// Wraps `GET/POST /v1/bookmarks` plus the
/// `DELETE /v1/bookmarks/by-message/{messageId}` convenience route exposed by
/// the daemon.
public struct BookmarkClient {
    nonisolated public init() {}

    public func listBookmarks() async throws -> [BookmarkSummary] {
        let response = try await GatewayHTTPClient.get(
            path: "bookmarks", timeout: 10
        )
        guard response.isSuccess else {
            log.error("listBookmarks failed (HTTP \(response.statusCode))")
            throw BookmarkClientError.requestFailed(response.statusCode)
        }
        let decoded = try JSONDecoder().decode(BookmarksListResponse.self, from: response.data)
        return decoded.bookmarks
    }

    public func createBookmark(messageId: String, conversationId: String) async throws -> BookmarkSummary {
        let response = try await GatewayHTTPClient.post(
            path: "bookmarks",
            json: ["messageId": messageId, "conversationId": conversationId],
            timeout: 10
        )
        guard response.isSuccess else {
            log.error("createBookmark failed (HTTP \(response.statusCode))")
            throw BookmarkClientError.requestFailed(response.statusCode)
        }
        return try JSONDecoder().decode(BookmarkSummary.self, from: response.data)
    }

    public func deleteBookmarkByMessageId(_ messageId: String) async throws {
        let response = try await GatewayHTTPClient.delete(
            path: "bookmarks/by-message/\(messageId)", timeout: 10
        )
        guard response.isSuccess else {
            log.error("deleteBookmarkByMessageId failed (HTTP \(response.statusCode))")
            throw BookmarkClientError.requestFailed(response.statusCode)
        }
    }
}
