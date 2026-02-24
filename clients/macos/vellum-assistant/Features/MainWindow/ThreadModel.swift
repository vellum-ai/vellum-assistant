import Foundation

enum ThreadKind: String, Hashable, Sendable {
    case standard
    case `private`
}

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
    var kind: ThreadKind
    var source: String?

    init(id: UUID = UUID(), title: String = "New Conversation", createdAt: Date = Date(), sessionId: String? = nil, isArchived: Bool = false, isPinned: Bool = false, pinnedOrder: Int? = nil, lastInteractedAt: Date? = nil, kind: ThreadKind = .standard, source: String? = nil) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.sessionId = sessionId
        self.isArchived = isArchived
        self.isPinned = isPinned
        self.pinnedOrder = pinnedOrder
        self.lastInteractedAt = lastInteractedAt ?? createdAt
        self.kind = kind
        self.source = source
    }

    /// Whether this thread was created by a schedule or reminder trigger.
    /// Falls back to title prefix when source is nil (HTTP mode).
    var isScheduleThread: Bool {
        if let source = source {
            return source == "schedule" || source == "reminder"
        }
        return title.hasPrefix("Schedule: ") || title.hasPrefix("Schedule (manual): ") || title.hasPrefix("Reminder: ")
    }
}
