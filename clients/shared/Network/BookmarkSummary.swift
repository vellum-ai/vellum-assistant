import Foundation

/// A bookmarked message, joined against its conversation for display.
///
/// Wire-compatible Swift mirror of the TypeScript `BookmarkSummary` type
/// emitted by `assistant/src/memory/bookmark-crud.ts`. The daemon emits
/// timestamps as unix-millisecond integers (matching the convention used
/// across the rest of `clients/shared/Network/` for daemon-sourced
/// types), so the wire fields are stored as `Int64` and exposed as
/// `Date` via computed accessors.
public struct BookmarkSummary: Codable, Identifiable, Equatable, Sendable, Hashable {
    public let id: String
    public let messageId: String
    public let conversationId: String
    public let conversationTitle: String?
    public let messagePreview: String
    /// "user" or "assistant".
    public let messageRole: String
    /// Unix-millisecond timestamp the underlying message was created.
    public let messageCreatedAt: Int64
    /// Unix-millisecond timestamp the bookmark itself was created.
    public let createdAt: Int64

    public var messageCreatedAtDate: Date {
        Date(timeIntervalSince1970: TimeInterval(messageCreatedAt) / 1000)
    }

    public var createdAtDate: Date {
        Date(timeIntervalSince1970: TimeInterval(createdAt) / 1000)
    }

    public init(
        id: String,
        messageId: String,
        conversationId: String,
        conversationTitle: String?,
        messagePreview: String,
        messageRole: String,
        messageCreatedAt: Int64,
        createdAt: Int64
    ) {
        self.id = id
        self.messageId = messageId
        self.conversationId = conversationId
        self.conversationTitle = conversationTitle
        self.messagePreview = messagePreview
        self.messageRole = messageRole
        self.messageCreatedAt = messageCreatedAt
        self.createdAt = createdAt
    }
}

/// Response shape for `GET /v1/bookmarks`.
public struct BookmarksListResponse: Codable, Sendable {
    public let bookmarks: [BookmarkSummary]

    public init(bookmarks: [BookmarkSummary]) {
        self.bookmarks = bookmarks
    }
}
