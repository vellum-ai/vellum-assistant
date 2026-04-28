import Foundation

/// The type of artifact associated with a conversation.
public enum ArtifactType: Sendable, Equatable, Hashable {
    case app
    case document
}

/// A unified representation of an artifact (app or document) associated with a conversation.
public struct ConversationArtifact: Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let type: ArtifactType
    public let title: String
    public let appId: String?
    public let surfaceId: String?

    public init(id: String, type: ArtifactType, title: String, appId: String? = nil, surfaceId: String? = nil) {
        self.id = id
        self.type = type
        self.title = title
        self.appId = appId
        self.surfaceId = surfaceId
    }
}
