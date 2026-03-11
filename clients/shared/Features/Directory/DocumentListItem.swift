import Foundation

/// A cross-platform model representing a document in the directory listing.
public struct DocumentListItem: Identifiable, Sendable {
    public let id: String  // surfaceId
    public let title: String
    public let wordCount: Int
    public let updatedAt: Date

    public init(id: String, title: String, wordCount: Int, updatedAt: Date) {
        self.id = id
        self.title = title
        self.wordCount = wordCount
        self.updatedAt = updatedAt
    }
}
