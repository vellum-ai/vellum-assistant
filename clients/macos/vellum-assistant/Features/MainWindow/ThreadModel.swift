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
    /// Explicit display order set by the user via drag-and-drop reordering.
    /// nil means no explicit order — thread is sorted by recency.
    var displayOrder: Int?
    var lastInteractedAt: Date
    var kind: ThreadKind
    var source: String?
    /// The schedule job ID that created this thread, if any.
    /// Threads sharing the same scheduleJobId belong to the same schedule group.
    var scheduleJobId: String?
    var hasUnseenLatestAssistantMessage: Bool = false
    var latestAssistantMessageAt: Date?
    var lastSeenAssistantMessageAt: Date?

    init(id: UUID = UUID(), title: String = "New Conversation", createdAt: Date = Date(), sessionId: String? = nil, isArchived: Bool = false, isPinned: Bool = false, pinnedOrder: Int? = nil, displayOrder: Int? = nil, lastInteractedAt: Date? = nil, kind: ThreadKind = .standard, source: String? = nil, scheduleJobId: String? = nil, hasUnseenLatestAssistantMessage: Bool = false, latestAssistantMessageAt: Date? = nil, lastSeenAssistantMessageAt: Date? = nil) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.sessionId = sessionId
        self.isArchived = isArchived
        self.isPinned = isPinned
        self.pinnedOrder = pinnedOrder
        self.displayOrder = displayOrder
        self.lastInteractedAt = lastInteractedAt ?? createdAt
        self.kind = kind
        self.source = source
        self.scheduleJobId = scheduleJobId
        self.hasUnseenLatestAssistantMessage = hasUnseenLatestAssistantMessage
        self.latestAssistantMessageAt = latestAssistantMessageAt
        self.lastSeenAssistantMessageAt = lastSeenAssistantMessageAt
    }

    /// Whether this thread was created by a schedule trigger (including one-shot/reminders).
    /// Checks for legacy "reminder" source for threads created before unification.
    /// Falls back to title prefix when source is nil (HTTP mode).
    var isScheduleThread: Bool {
        if let source = source {
            return source == "schedule" || source == "reminder"
        }
        return title.hasPrefix("Schedule: ") || title.hasPrefix("Schedule (manual): ") || title.hasPrefix("Reminder: ")
    }
}
