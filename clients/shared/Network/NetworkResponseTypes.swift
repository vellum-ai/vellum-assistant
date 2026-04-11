import Foundation

// MARK: - SSE Event Envelope

/// Envelope around `ServerMessage` for SSE events from the gateway.
struct AssistantEvent: Decodable, Sendable {
    let id: String
    let assistantId: String
    let conversationId: String?
    let emittedAt: String
    let message: ServerMessage
}

// MARK: - Conversations List Response

/// Response shape from `GET /v1/conversations`.
public struct ConversationsListResponse: Decodable {
    public struct Conversation: Decodable {
        public let id: String
        public let title: String
        public let createdAt: Int?
        public let updatedAt: Int
        public let conversationType: String?
        public let source: String?
        public let hostAccess: Bool?
        public let scheduleJobId: String?
        public let channelBinding: ChannelBinding?
        public let conversationOriginChannel: String?
        public let conversationOriginInterface: String?
        public let assistantAttention: AssistantAttention?
        public let displayOrder: Double?
        public let isPinned: Bool?
        public let groupId: String?
        public let forkParent: ConversationForkParent?
    }
    public let conversations: [Conversation]
    public let hasMore: Bool?
}

/// Response shape from `GET /v1/conversations/:id`.
public struct SingleConversationResponse: Decodable {
    public let conversation: ConversationsListResponse.Conversation
}

/// Response shape from `POST /v1/conversations/:id/fork`.
public struct ForkConversationResponse: Decodable {
    public let conversation: ConversationsListResponse.Conversation
}

// MARK: - Workspace API Response Types

public struct WorkspaceTreeEntry: Codable, Identifiable, Hashable, Sendable {
    public let name: String
    public let path: String
    public let type: String  // "file" or "directory"
    public let size: Int?
    public let mimeType: String?
    public let modifiedAt: String

    public var id: String { path }
    public var isDirectory: Bool { type == "directory" }
}

public struct WorkspaceTreeResponse: Codable, Sendable {
    public let path: String
    public let entries: [WorkspaceTreeEntry]
}

public struct WorkspaceFileResponse: Codable, Sendable {
    public let path: String
    public let name: String
    public let size: Int
    public let mimeType: String
    public let modifiedAt: String
    public let content: String?
    public let isBinary: Bool

    public init(path: String, name: String, size: Int, mimeType: String, modifiedAt: String, content: String?, isBinary: Bool) {
        self.path = path
        self.name = name
        self.size = size
        self.mimeType = mimeType
        self.modifiedAt = modifiedAt
        self.content = content
        self.isBinary = isBinary
    }
}

// MARK: - Workspace files list (distinct from tree)

/// A single entry in the `GET /workspace-files` response.
///
/// This endpoint is distinct from the workspace tree API: it returns a flat,
/// server-curated list of the well-known workspace files the UI cares about
/// (`IDENTITY.md`, `SOUL.md`, the user persona file, `skills/`), including
/// dynamic entries such as the guardian's per-user persona path at
/// `users/<slug>.md`.
public struct WorkspaceFilesListEntry: Codable, Sendable {
    public let path: String
    public let name: String
    public let exists: Bool
}

/// Response shape from `GET /workspace-files`.
public struct WorkspaceFilesListResponse: Codable, Sendable {
    public let files: [WorkspaceFilesListEntry]
}
