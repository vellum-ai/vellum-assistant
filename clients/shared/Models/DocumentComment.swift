import Foundation

/// A single comment on a document surface, matching the daemon's REST response shape.
public struct DocumentComment: Codable, Identifiable, Sendable {
    public let id: String
    public let surfaceId: String
    public let conversationId: String
    public let author: String
    public let content: String
    public let anchorStart: Int?
    public let anchorEnd: Int?
    public let anchorText: String?
    public let parentCommentId: String?
    public let status: String
    public let resolvedBy: String?
    public let resolvedAt: Int?
    public let createdAt: Int
    public let updatedAt: Int

    public init(
        id: String,
        surfaceId: String,
        conversationId: String,
        author: String,
        content: String,
        anchorStart: Int? = nil,
        anchorEnd: Int? = nil,
        anchorText: String? = nil,
        parentCommentId: String? = nil,
        status: String,
        resolvedBy: String? = nil,
        resolvedAt: Int? = nil,
        createdAt: Int,
        updatedAt: Int
    ) {
        self.id = id
        self.surfaceId = surfaceId
        self.conversationId = conversationId
        self.author = author
        self.content = content
        self.anchorStart = anchorStart
        self.anchorEnd = anchorEnd
        self.anchorText = anchorText
        self.parentCommentId = parentCommentId
        self.status = status
        self.resolvedBy = resolvedBy
        self.resolvedAt = resolvedAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}
