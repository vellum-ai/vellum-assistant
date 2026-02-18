import Foundation

/// The kind of conversation thread.
public enum ThreadKind: String, Hashable, Sendable {
    case standard
    case `private`
}

/// Represents a single chat thread, shared between iOS and macOS.
///
/// On macOS, threads support pinning, archival, and daemon session IDs.
/// On iOS, only a subset of fields are used initially.
public struct ThreadModel: Identifiable, Hashable, Sendable {
    public let id: UUID
    public var title: String
    public let createdAt: Date
    /// Daemon conversation ID for restored threads. Nil for new, unsaved threads.
    /// Mutable so it can be backfilled when the daemon assigns a session to a new thread.
    public var sessionId: String?
    public var isArchived: Bool
    public var isPinned: Bool
    public var pinnedOrder: Int?
    public var lastInteractedAt: Date
    public var kind: ThreadKind

    public init(
        id: UUID = UUID(),
        title: String = "New Conversation",
        createdAt: Date = Date(),
        sessionId: String? = nil,
        isArchived: Bool = false,
        isPinned: Bool = false,
        pinnedOrder: Int? = nil,
        lastInteractedAt: Date? = nil,
        kind: ThreadKind = .standard
    ) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.sessionId = sessionId
        self.isArchived = isArchived
        self.isPinned = isPinned
        self.pinnedOrder = pinnedOrder
        self.lastInteractedAt = lastInteractedAt ?? createdAt
        self.kind = kind
    }
}
