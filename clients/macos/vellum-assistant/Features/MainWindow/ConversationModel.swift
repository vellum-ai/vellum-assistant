import Foundation
import VellumAssistantShared

enum ConversationKind: String, Hashable, Sendable {
    case standard
    case `private`
}

/// Composite view identity for conversation rows. Combines the conversation UUID
/// with its current groupId so that SwiftUI treats a group change as a view identity
/// change — destroying the old row and creating a fresh one. This prevents stale
/// rendered bodies when conversations move between ForEach sections in a LazyVStack.
struct ConversationRowIdentity: Hashable {
    let conversationId: UUID
    let groupId: String?
}

struct ConversationModel: Identifiable, Hashable {
    let id: UUID
    var title: String
    let createdAt: Date
    /// Daemon conversation ID for restored conversations. Nil for new, unsaved conversations.
    /// Mutable so it can be backfilled when the daemon assigns a session ID to a new conversation.
    var conversationId: String?
    var isArchived: Bool
    /// The conversation group this conversation belongs to.
    /// nil means ungrouped. System groups: "system:pinned", "system:scheduled", "system:background".
    var groupId: String?
    /// Whether this conversation is pinned. Computed from `groupId`.
    var isPinned: Bool {
        get { groupId == ConversationGroup.pinned.id }
        set {
            if newValue { groupId = ConversationGroup.pinned.id }
            else if groupId == ConversationGroup.pinned.id { groupId = ConversationGroup.all.id }
        }
    }
    /// Explicit display order set by the user via drag-and-drop reordering.
    /// nil means no explicit order — conversation is sorted by recency.
    var displayOrder: Int?
    var lastInteractedAt: Date
    var kind: ConversationKind
    var source: String?
    /// The daemon-side conversation classification: "standard", "private", "background", "scheduled".
    /// This is the canonical signal for unread-suppression of automated threads — keys off the
    /// `conversationType` column the daemon sets at creation time, and is stable across pin/move
    /// operations (which can mutate `groupId` but never `conversationType`). `nil` for rows returned
    /// by older daemons that predate the field; callers should treat `nil` as non-suppressed.
    var conversationType: String?
    var hostAccess: Bool
    /// Per-conversation override for the LLM inference profile. `nil` means
    /// the conversation inherits the workspace `llm.activeProfile`.
    var inferenceProfile: String?
    /// The schedule job ID that created this conversation, if any.
    /// Conversations sharing the same scheduleJobId belong to the same schedule group.
    var scheduleJobId: String?
    var hasUnseenLatestAssistantMessage: Bool = false
    var latestAssistantMessageAt: Date?
    var lastSeenAssistantMessageAt: Date?
    var forkParent: ConversationForkParent?
    var originChannel: String?

    init(id: UUID = UUID(), title: String = "New Conversation", createdAt: Date = Date(), conversationId: String? = nil, isArchived: Bool = false, groupId: String? = nil, displayOrder: Int? = nil, lastInteractedAt: Date? = nil, kind: ConversationKind = .standard, source: String? = nil, conversationType: String? = nil, hostAccess: Bool = false, inferenceProfile: String? = nil, scheduleJobId: String? = nil, hasUnseenLatestAssistantMessage: Bool = false, latestAssistantMessageAt: Date? = nil, lastSeenAssistantMessageAt: Date? = nil, forkParent: ConversationForkParent? = nil, originChannel: String? = nil) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.conversationId = conversationId
        self.isArchived = isArchived
        self.groupId = groupId
        self.displayOrder = displayOrder
        self.lastInteractedAt = lastInteractedAt ?? createdAt
        self.kind = kind
        self.source = source
        self.conversationType = conversationType
        self.hostAccess = hostAccess
        self.inferenceProfile = inferenceProfile
        self.scheduleJobId = scheduleJobId
        self.hasUnseenLatestAssistantMessage = hasUnseenLatestAssistantMessage
        self.latestAssistantMessageAt = latestAssistantMessageAt
        self.lastSeenAssistantMessageAt = lastSeenAssistantMessageAt
        self.forkParent = forkParent
        self.originChannel = originChannel
    }

    /// Whether this conversation was created by a background process (heartbeat, etc.).
    var isBackgroundConversation: Bool {
        source == "heartbeat"
    }

    /// Whether this conversation should return to the background group on unpin.
    /// Covers heartbeat AND task-run backgrounds for consistent pin->unpin behavior.
    var shouldReturnToBackgroundOnUnpin: Bool {
        source == "heartbeat" || source == "task" || source == "auto-analysis"
    }

    /// Whether this conversation was created by a schedule trigger (including one-shot/reminders).
    /// Checks for legacy "reminder" source for conversations created before unification.
    /// Falls back to title prefix when source is nil (HTTP mode).
    var isScheduleConversation: Bool {
        if let source = source {
            return source == "schedule" || source == "reminder"
        }
        return title.hasPrefix("Schedule: ") || title.hasPrefix("Schedule (manual): ") || title.hasPrefix("Reminder: ")
    }

    /// Whether this conversation was produced by the auto-analysis loop.
    var isAutoAnalysisConversation: Bool {
        source == "auto-analysis"
    }

    /// Whether this conversation is automated (heartbeat, schedule, background/task,
    /// auto-analysis, watcher, filing, and any future daemon-classified background thread)
    /// and should never show unread indicators on individual rows.
    ///
    /// Primary signal is `conversationType` — the daemon's canonical field — so any
    /// server-created background/scheduled conversation is suppressed regardless of its
    /// `source`. The source-based fallbacks cover locally-created conversations (before
    /// the server round-trip sets `conversationType`) and older daemons that don't return
    /// the field.
    var shouldSuppressUnreadIndicator: Bool {
        conversationType == "background" || conversationType == "scheduled"
            || isScheduleConversation || shouldReturnToBackgroundOnUnpin
    }

    /// Whether this conversation should be excluded from *global* unread
    /// aggregations — the dock badge and the Conversations header unread dot.
    var shouldSuppressGlobalUnreadAggregations: Bool {
        shouldSuppressUnreadIndicator
    }

    var isChannelConversation: Bool {
        guard let originChannel else { return false }
        if originChannel == "vellum" { return false }
        // `notification:*` channels are outbound-only delivery (e.g. Slack push
        // for a scheduled reminder). The conversation itself still lives in the
        // app, so treat it like a native conversation for sidebar affordances
        // (archive, mark-as-unread, drag-to-reorder, analyze).
        if originChannel.hasPrefix("notification:") { return false }
        return true
    }

    /// Derive the groupId for a conversation from server metadata when the server
    /// doesn't provide an explicit groupId. Shared by ConversationManager and
    /// ConversationRestorer to avoid duplicated classification logic.
    static func deriveGroupId(serverGroupId: String?, isPinned: Bool, source: String?, title: String) -> String? {
        if let serverGroupId { return serverGroupId }
        if isPinned { return ConversationGroup.pinned.id }
        if source == "schedule" || source == "reminder" {
            return ConversationGroup.scheduled.id
        }
        if source == "heartbeat" || source == "task" || source == "auto-analysis" {
            return ConversationGroup.background.id
        }
        if title.hasPrefix("Schedule: ") || title.hasPrefix("Schedule (manual): ") || title.hasPrefix("Reminder: ") {
            return ConversationGroup.scheduled.id
        }
        return "system:all"
    }

    static func == (lhs: ConversationModel, rhs: ConversationModel) -> Bool {
        lhs.id == rhs.id &&
            lhs.title == rhs.title &&
            lhs.createdAt == rhs.createdAt &&
            lhs.conversationId == rhs.conversationId &&
            lhs.isArchived == rhs.isArchived &&
            lhs.groupId == rhs.groupId &&
            lhs.displayOrder == rhs.displayOrder &&
            lhs.lastInteractedAt == rhs.lastInteractedAt &&
            lhs.kind == rhs.kind &&
            lhs.source == rhs.source &&
            lhs.conversationType == rhs.conversationType &&
            lhs.hostAccess == rhs.hostAccess &&
            lhs.inferenceProfile == rhs.inferenceProfile &&
            lhs.scheduleJobId == rhs.scheduleJobId &&
            lhs.hasUnseenLatestAssistantMessage == rhs.hasUnseenLatestAssistantMessage &&
            lhs.latestAssistantMessageAt == rhs.latestAssistantMessageAt &&
            lhs.lastSeenAssistantMessageAt == rhs.lastSeenAssistantMessageAt &&
            lhs.forkParent?.conversationId == rhs.forkParent?.conversationId &&
            lhs.forkParent?.messageId == rhs.forkParent?.messageId &&
            lhs.forkParent?.title == rhs.forkParent?.title &&
            lhs.originChannel == rhs.originChannel
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
        hasher.combine(title)
        hasher.combine(createdAt)
        hasher.combine(conversationId)
        hasher.combine(isArchived)
        hasher.combine(groupId)
        hasher.combine(displayOrder)
        hasher.combine(lastInteractedAt)
        hasher.combine(kind)
        hasher.combine(source)
        hasher.combine(conversationType)
        hasher.combine(hostAccess)
        hasher.combine(inferenceProfile)
        hasher.combine(scheduleJobId)
        hasher.combine(hasUnseenLatestAssistantMessage)
        hasher.combine(latestAssistantMessageAt)
        hasher.combine(lastSeenAssistantMessageAt)
        hasher.combine(forkParent?.conversationId)
        hasher.combine(forkParent?.messageId)
        hasher.combine(forkParent?.title)
        hasher.combine(originChannel)
    }
}
