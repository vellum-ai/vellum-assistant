import Foundation

struct ThreadModel: Identifiable, Hashable {
    let id: UUID
    var title: String
    let createdAt: Date
    /// Daemon conversation ID for restored threads. Nil for new, unsaved threads.
    /// Mutable so it can be backfilled when the daemon assigns a session to a new thread.
    var sessionId: String?
    var isArchived: Bool
    var isPinned: Bool
    var pinnedOrder: Int?
    var lastInteractedAt: Date

    init(id: UUID = UUID(), title: String = "New Conversation", createdAt: Date = Date(), sessionId: String? = nil, isArchived: Bool = false, isPinned: Bool = false, pinnedOrder: Int? = nil, lastInteractedAt: Date? = nil) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.sessionId = sessionId
        self.isArchived = isArchived
        self.isPinned = isPinned
        self.pinnedOrder = pinnedOrder
        self.lastInteractedAt = lastInteractedAt ?? createdAt
    }
}
