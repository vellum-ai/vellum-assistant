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

    // MARK: - Channel Binding (external conversation sync)

    /// The source channel for externally-synced threads (e.g. "telegram").
    var sourceChannel: String?
    /// Display name of the external user who initiated the conversation.
    var displayName: String?
    /// Username of the external user (e.g. Telegram @handle).
    var username: String?
    /// External chat identifier for the synced conversation.
    var externalChatId: String?

    /// Whether this thread is bound to an external channel (e.g. Telegram).
    var isSynced: Bool { sourceChannel != nil }

    /// Best available label for the external sender: displayName, @username, or truncated chat ID.
    var senderLabel: String? {
        if let displayName, !displayName.isEmpty { return displayName }
        if let username, !username.isEmpty { return "@\(username)" }
        if let externalChatId, !externalChatId.isEmpty {
            let suffix = String(externalChatId.suffix(6))
            return "Telegram \(suffix)"
        }
        return nil
    }

    init(id: UUID = UUID(), title: String = "New Conversation", createdAt: Date = Date(), sessionId: String? = nil, isArchived: Bool = false, isPinned: Bool = false, pinnedOrder: Int? = nil, lastInteractedAt: Date? = nil, kind: ThreadKind = .standard, sourceChannel: String? = nil, displayName: String? = nil, username: String? = nil, externalChatId: String? = nil) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.sessionId = sessionId
        self.isArchived = isArchived
        self.isPinned = isPinned
        self.pinnedOrder = pinnedOrder
        self.lastInteractedAt = lastInteractedAt ?? createdAt
        self.kind = kind
        self.sourceChannel = sourceChannel
        self.displayName = displayName
        self.username = username
        self.externalChatId = externalChatId
    }
}
