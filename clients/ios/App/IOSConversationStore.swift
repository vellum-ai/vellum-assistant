#if canImport(UIKit)
import Combine
import Observation
import SwiftUI
import VellumAssistantShared
import os

private let pinDebugLog = Logger(subsystem: Bundle.appBundleIdentifier, category: "pin-debug")

// MARK: - IOSConversation

/// Represents a single chat conversation on iOS.
struct IOSConversation: Identifiable {
    let id: UUID
    var title: String
    let createdAt: Date
    /// Tracks the most recent activity (message sent/received). Defaults to createdAt.
    var lastActivityAt: Date
    /// When non-nil, this conversation is backed by a daemon conversation (Connected mode).
    var conversationId: String?
    var isArchived: Bool
    var isPinned: Bool
    var displayOrder: Int?
    /// Private conversations are excluded from the normal conversation list and persist only
    /// for the current session. They match the macOS "temporary chat" behavior.
    var isPrivate: Bool
    /// The schedule job ID that created this conversation, if any.
    /// Conversations sharing the same scheduleJobId belong to the same schedule group.
    var scheduleJobId: String?
    /// The parent conversation/message this conversation forked from, if any.
    var forkParent: ConversationForkParent?
    /// The conversation group this conversation belongs to, if any.
    var groupId: String?
    /// The source that created this conversation (e.g. "heartbeat", "task", "schedule", "reminder", "notification").
    /// Immutable after creation — pinning/moving a conversation changes groupId but never source.
    var source: String?
    /// The daemon-side conversation classification: "standard", "private", "background", "scheduled".
    /// Canonical signal for unread-suppression of automated threads. `nil` for rows written by
    /// older daemons or for locally-created conversations that have not yet round-tripped to the
    /// server; callers should treat `nil` as non-suppressed.
    var conversationType: String?
    /// The originating channel for this conversation (e.g. "vellum", "telegram", "notification:...").
    /// Derived from `channelBinding.sourceChannel` (preferred) or `conversationOriginChannel`.
    /// Used to gate destructive actions on channel-bound conversations — see `isChannelConversation`.
    var originChannel: String?
    var hasUnseenLatestAssistantMessage: Bool
    var latestAssistantMessageAt: Date?
    var lastSeenAssistantMessageAt: Date?

    /// Whether this conversation was created by a schedule trigger (including one-shot/reminders).
    /// Keeps legacy "Reminder: " prefix check for conversations created before unification.
    var isScheduleConversation: Bool {
        if scheduleJobId != nil { return true }
        return title.hasPrefix("Schedule: ") || title.hasPrefix("Schedule (manual): ") || title.hasPrefix("Reminder: ")
    }

    /// Whether this conversation is bound to an external channel (Telegram, Slack, etc.).
    /// Channel conversations cannot be archived — matches macOS behavior in
    /// `ConversationModel.isChannelConversation` so destructive actions stay consistent
    /// across platforms.
    var isChannelConversation: Bool {
        guard let originChannel else { return false }
        if originChannel == "vellum" { return false }
        if originChannel.hasPrefix("notification:") { return false }
        return true
    }

    /// Whether this conversation is automated (heartbeat, schedule, background/task)
    /// and should never show unread indicators. Per Apple HIG, badges and unread
    /// indicators should only reflect content requiring user attention — system-generated
    /// messages from automated threads do not qualify.
    ///
    /// Primary signal is `conversationType` (the daemon's canonical classification) so any
    /// server-created `background` or `scheduled` conversation is suppressed regardless of source.
    /// The source/title fallbacks cover locally-created conversations and older daemons that
    /// don't return the field.
    var shouldSuppressUnreadIndicator: Bool {
        conversationType == "background" || conversationType == "scheduled"
            || isScheduleConversation || source == "heartbeat" || source == "task" || source == "auto-analysis"
    }

    init(id: UUID = UUID(), title: String = "New Chat", createdAt: Date = Date(), lastActivityAt: Date? = nil, conversationId: String? = nil, isArchived: Bool = false, isPinned: Bool = false, displayOrder: Int? = nil, isPrivate: Bool = false, scheduleJobId: String? = nil, forkParent: ConversationForkParent? = nil, groupId: String? = nil, source: String? = nil, conversationType: String? = nil, originChannel: String? = nil, hasUnseenLatestAssistantMessage: Bool = false, latestAssistantMessageAt: Date? = nil, lastSeenAssistantMessageAt: Date? = nil) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.lastActivityAt = lastActivityAt ?? createdAt
        self.conversationId = conversationId
        self.isArchived = isArchived
        self.isPinned = isPinned
        self.displayOrder = displayOrder
        self.isPrivate = isPrivate
        self.scheduleJobId = scheduleJobId
        self.forkParent = forkParent
        self.groupId = groupId
        self.source = source
        self.conversationType = conversationType
        self.originChannel = originChannel
        self.hasUnseenLatestAssistantMessage = hasUnseenLatestAssistantMessage
        self.latestAssistantMessageAt = latestAssistantMessageAt
        self.lastSeenAssistantMessageAt = lastSeenAssistantMessageAt
    }
}

// MARK: - PersistedConversation

/// Codable representation of IOSConversation for UserDefaults persistence.
private struct PersistedConversation: Codable {
    var id: UUID
    var title: String
    var createdAt: Date
    var lastActivityAt: Date?
    var isArchived: Bool?
    var isPinned: Bool?
    var displayOrder: Int?
    var isPrivate: Bool?
    var conversationId: String?
    var scheduleJobId: String?
    var forkParent: ConversationForkParent?
    var source: String?
    var conversationType: String?
    var originChannel: String?
    var hasUnseenLatestAssistantMessage: Bool?
    var latestAssistantMessageAt: Date?
    var lastSeenAssistantMessageAt: Date?

    // Decode both the legacy "sessionId" key and the current "conversationId"
    // key so UserDefaults data written by any version (pre-rename, intermediate,
    // or current) is read correctly.  Encoding always uses "conversationId".
    enum CodingKeys: String, CodingKey {
        case id, title, createdAt, lastActivityAt, isArchived, isPinned, displayOrder, isPrivate
        case conversationId
        case scheduleJobId, forkParent, source, conversationType, originChannel, hasUnseenLatestAssistantMessage, latestAssistantMessageAt, lastSeenAssistantMessageAt
        // Legacy key used before the session-to-conversation rename.
        case legacySessionId = "sessionId"
    }
}

// Custom Codable conformance lives in an extension so that Swift's
// synthesized memberwise initializer is preserved for call sites like
// saveConnectedCache() and save().
extension PersistedConversation {
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        lastActivityAt = try container.decodeIfPresent(Date.self, forKey: .lastActivityAt)
        isArchived = try container.decodeIfPresent(Bool.self, forKey: .isArchived)
        isPinned = try container.decodeIfPresent(Bool.self, forKey: .isPinned)
        displayOrder = try container.decodeIfPresent(Int.self, forKey: .displayOrder)
        isPrivate = try container.decodeIfPresent(Bool.self, forKey: .isPrivate)
        // Try the current key first, fall back to the legacy key.
        conversationId = try container.decodeIfPresent(String.self, forKey: .conversationId)
            ?? container.decodeIfPresent(String.self, forKey: .legacySessionId)
        scheduleJobId = try container.decodeIfPresent(String.self, forKey: .scheduleJobId)
        forkParent = try container.decodeIfPresent(ConversationForkParent.self, forKey: .forkParent)
        source = try container.decodeIfPresent(String.self, forKey: .source)
        conversationType = try container.decodeIfPresent(String.self, forKey: .conversationType)
        originChannel = try container.decodeIfPresent(String.self, forKey: .originChannel)
        hasUnseenLatestAssistantMessage = try container.decodeIfPresent(Bool.self, forKey: .hasUnseenLatestAssistantMessage)
        latestAssistantMessageAt = try container.decodeIfPresent(Date.self, forKey: .latestAssistantMessageAt)
        lastSeenAssistantMessageAt = try container.decodeIfPresent(Date.self, forKey: .lastSeenAssistantMessageAt)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(title, forKey: .title)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encodeIfPresent(lastActivityAt, forKey: .lastActivityAt)
        try container.encodeIfPresent(isArchived, forKey: .isArchived)
        try container.encodeIfPresent(isPinned, forKey: .isPinned)
        try container.encodeIfPresent(displayOrder, forKey: .displayOrder)
        try container.encodeIfPresent(isPrivate, forKey: .isPrivate)
        // Always encode under the current "conversationId" key.
        try container.encodeIfPresent(conversationId, forKey: .conversationId)
        try container.encodeIfPresent(scheduleJobId, forKey: .scheduleJobId)
        try container.encodeIfPresent(forkParent, forKey: .forkParent)
        try container.encodeIfPresent(source, forKey: .source)
        try container.encodeIfPresent(conversationType, forKey: .conversationType)
        try container.encodeIfPresent(originChannel, forKey: .originChannel)
        try container.encodeIfPresent(hasUnseenLatestAssistantMessage, forKey: .hasUnseenLatestAssistantMessage)
        try container.encodeIfPresent(latestAssistantMessageAt, forKey: .latestAssistantMessageAt)
        try container.encodeIfPresent(lastSeenAssistantMessageAt, forKey: .lastSeenAssistantMessageAt)
    }
}

struct ConversationSelectionRequest: Equatable {
    let id = UUID()
    let conversationLocalId: UUID
}

struct PendingConversationAnchorRequest: Equatable {
    let id = UUID()
    let conversationLocalId: UUID
    let daemonMessageId: String
}

// MARK: - IOSConversationStore

/// Manages a list of chat conversations for iOS.
///
/// In Standalone mode: conversations are persisted locally via UserDefaults.
/// In Connected mode: conversations are loaded from the daemon (shared with macOS).
/// Each conversation owns an independent ChatViewModel instance.
@MainActor
class IOSConversationStore: ObservableObject {
    @Published var conversations: [IOSConversation] = []
    @Published var isConnectedMode: Bool = false
    /// True while an additional page of conversations is being fetched from the daemon.
    @Published var isLoadingMoreConversations: Bool = false
    /// Whether the daemon indicated more conversations exist beyond what is currently loaded.
    @Published var hasMoreConversations: Bool = false
    /// True while the first page of conversations is being fetched from the daemon.
    /// Used by the UI to show a loading indicator instead of a placeholder conversation.
    @Published var isLoadingInitialConversations: Bool = false
    @Published var selectionRequest: ConversationSelectionRequest?
    @Published var pendingConversationAnchorRequest: PendingConversationAnchorRequest?

    /// Conversation ID the user tapped on a push notification but whose matching
    /// local `IOSConversation` wasn't loaded yet (cold start, reconnect, cache miss).
    /// Applied via `resolvePendingPushNavigationIfPossible()` whenever the conversation
    /// list changes so navigation still completes once the list catches up.
    private var pendingPushNavigationConversationId: String?

    /// Diagnostic detail from the most recent page-one conversation fetch failure.
    /// Set after both parallel foreground/background fetches resolve so race conditions
    /// cannot clobber the value. Observable by SwiftUI views when developer mode is enabled.
    @Published var lastFetchError: String?

    /// ViewModels keyed by conversation ID, created lazily on first access.
    private var viewModels: [UUID: ChatViewModel] = [:]
    private var connectionManager: GatewayConnectionManager
    private var eventStreamClient: EventStreamClient
    private let conversationHistoryClient: any ConversationHistoryClientProtocol
    private let conversationListClient: any ConversationListClientProtocol
    private let conversationDetailClient: any ConversationDetailClientProtocol
    private let conversationForkClient: any ConversationForkClientProtocol
    private let conversationUnreadClient: any ConversationUnreadClientProtocol
    private let userDefaults: UserDefaults
    private static let persistenceKey = "ios_conversations_v1"
    private static let connectedCacheKey = "ios_connected_conversations_cache_v1"
    private static let legacyPersistenceKey = "ios_threads_v1"
    private static let legacyConnectedCacheKey = "ios_connected_threads_cache_v1"
    /// Stores Combine subscriptions that must survive across observation loop restarts
    /// (e.g. the `NotificationCenter` reconnect publisher in `setupDaemonCallbacks`).
    private var cancellables: Set<AnyCancellable> = []
    /// Task running the SSE subscribe loop for daemon messages.
    private var subscribeTask: Task<Void, Never>?
    /// Debounce task for conversation_list_invalidated refetch.
    private var invalidationRefetchTask: Task<Void, Never>?
    /// Maps daemon conversation IDs to local conversation IDs for history loading.
    private var pendingHistoryByConversationId: [String: UUID] = [:]
    /// Per-domain generation counters for observation loops. Each observation type
    /// (fork, activity) has its own counter so that starting/restarting one
    /// loop does not invalidate the others. All are cleared when a conversation is deleted.
    private var forkGenerations: [UUID: Int] = [:]
    private var activityGenerations: [UUID: Int] = [:]
    /// Last observed fork-availability tip ID per conversation, for change detection.
    private var lastObservedForkTipIds: [UUID: String?] = [:]
    /// Last observed message count per conversation, for activity-tracking change detection.
    private var lastObservedMessageCounts: [UUID: Int] = [:]
    /// Number of conversations per page when listing conversations from the daemon.
    private static let conversationPageSize = 50
    private static let attentionSignalType = "ios_conversation_opened"
    /// Current offset used for the next page fetch; advances by `conversationPageSize` on each load.
    private var conversationListOffset: Int = 0
    /// Reconnect-generation counter. Incremented only when pagination is reset due to a
    /// reconnect (or a `rebindGatewayConnectionManager` call). Never incremented on ordinary
    /// `loadMoreConversations` calls.
    ///
    /// Because the daemon does not echo a request ID back in conversation-list responses, we
    /// cannot correlate individual responses to individual requests within the same
    /// connection.  What we *can* do is reject any response that arrived from the *old*
    /// connection after a reconnect has already started a fresh page-1 sequence.  This is
    /// exactly what the generation counter provides: every page-1 send captures the current
    /// generation in `expectedConversationListGeneration`; the response handler discards any
    /// response whose expected generation no longer matches the live counter.
    private var conversationListGeneration: UInt64 = 0
    /// Generation captured at the time the most-recent page-1 conversation-list request was sent.
    /// The response handler compares this against `conversationListGeneration` to detect and
    /// discard stale responses from the previous connection.
    private var expectedConversationListGeneration: UInt64 = 0
    /// ConversationIds that the user has locally edited (renamed/archived/unarchived)
    /// since the cache was loaded. Only these conversations preserve local overrides
    /// when the daemon response arrives; all others accept daemon data.
    private var locallyEditedConversationIds: Set<String> = []
    /// ConversationIds where the user explicitly pinned or unpinned. Used to preserve
    /// local pin/displayOrder when merging daemon data; title/archive-only edits
    /// must not overwrite daemon pin updates from other devices.
    private var locallyEditedPinConversationIds: Set<String> = []
    /// Local seen/unread mutations must survive a stale conversation-list replay until
    /// the daemon acknowledges them or returns a newer assistant reply.
    private var pendingAttentionOverrides: [String: PendingAttentionOverride] = [:]

    private enum PendingAttentionOverride {
        case seen(latestAssistantMessageAt: Date?)
        case unread(latestAssistantMessageAt: Date?)
    }

    private func assistantTimestamp(_ timestampMs: Int?) -> Date? {
        guard let timestampMs else { return nil }
        return Date(timeIntervalSince1970: TimeInterval(timestampMs) / 1000.0)
    }

    private func applyConversationMetadata(
        _ item: ConversationListResponseItem,
        to conversation: inout IOSConversation
    ) {
        conversation.isPinned = item.isPinned ?? false
        conversation.displayOrder = item.displayOrder.map { Int($0) }
        conversation.groupId = item.groupId
        conversation.source = item.source
        conversation.conversationType = item.conversationType
        conversation.originChannel = item.channelBinding?.sourceChannel ?? item.conversationOriginChannel
        let serverUnseen = item.assistantAttention?.hasUnseenLatestAssistantMessage ?? false
        conversation.hasUnseenLatestAssistantMessage =
            conversation.shouldSuppressUnreadIndicator ? false : serverUnseen
        conversation.latestAssistantMessageAt = assistantTimestamp(
            item.assistantAttention?.latestAssistantMessageAt
        )
        conversation.lastSeenAssistantMessageAt = assistantTimestamp(
            item.assistantAttention?.lastSeenAssistantMessageAt
        )
    }

    private func existingConversationIndex(forConversationId conversationId: String) -> Int? {
        if let conversationIndex = conversations.firstIndex(where: { $0.conversationId == conversationId }) {
            return conversationIndex
        }
        return conversations.firstIndex(where: { viewModels[$0.id]?.conversationId == conversationId })
    }

    /// Write the daemon-assigned conversation ID back onto the local IOSConversation
    /// so subsequent conversation-list refetches can match server rows against it
    /// directly instead of falling back to a viewModels lookup.
    ///
    /// Also persists the now-cacheable conversation — saveConnectedCache filters on
    /// conversationId != nil, so a newly promoted local conversation is only written
    /// to the connected cache once the daemon has acknowledged it.
    private func backfillConversationId(_ conversationId: String, for localId: UUID) {
        guard let index = conversations.firstIndex(where: { $0.id == localId }) else { return }

        // No-op if the local entry already holds the same ID, and refuse to
        // overwrite a different ID (which would indicate a bug elsewhere).
        guard conversations[index].conversationId == nil
            || conversations[index].conversationId == conversationId else { return }

        conversations[index].conversationId = conversationId
        saveConnectedCache()
    }

    private func mergeConversationMetadata(from restored: IOSConversation, into conversation: inout IOSConversation) {
        conversation.conversationId = restored.conversationId ?? conversation.conversationId
        conversation.scheduleJobId = restored.scheduleJobId ?? conversation.scheduleJobId
        conversation.source = restored.source ?? conversation.source
        conversation.conversationType = restored.conversationType ?? conversation.conversationType
        conversation.originChannel = restored.originChannel ?? conversation.originChannel
        conversation.forkParent = restored.forkParent
        let hasLocalPinEdit = conversation.conversationId.map { locallyEditedPinConversationIds.contains($0) } ?? false
        let pinDebugConvId = conversation.conversationId ?? "nil"
        let pinDebugCurrentIsPinned = conversation.isPinned
        pinDebugLog.info("[pin-debug] mergeConversationMetadata conv=\(pinDebugConvId, privacy: .public) hasLocalPinEdit=\(hasLocalPinEdit, privacy: .public) restored.isPinned=\(restored.isPinned, privacy: .public) conversation.isPinned=\(pinDebugCurrentIsPinned, privacy: .public)")
        if !hasLocalPinEdit {
            conversation.isPinned = restored.isPinned
            conversation.displayOrder = restored.displayOrder
        } else if restored.isPinned == conversation.isPinned {
            // Server has acknowledged our pin change — stop suppressing updates so
            // pin/order changes from other clients are reflected on the next refresh.
            if let sid = conversation.conversationId {
                locallyEditedPinConversationIds.remove(sid)
            }
            conversation.isPinned = restored.isPinned
            conversation.displayOrder = restored.displayOrder
        }
        conversation.hasUnseenLatestAssistantMessage =
            conversation.shouldSuppressUnreadIndicator ? false : restored.hasUnseenLatestAssistantMessage
        conversation.latestAssistantMessageAt = restored.latestAssistantMessageAt
        conversation.lastSeenAssistantMessageAt = restored.lastSeenAssistantMessageAt
        applyPendingAttentionOverride(to: &conversation)
    }

    private func applyPendingAttentionOverride(to conversation: inout IOSConversation) {
        guard let conversationId = conversation.conversationId,
              let override = pendingAttentionOverrides[conversationId] else { return }

        switch override {
        case .seen(let targetLatestAssistantMessageAt):
            if !conversation.hasUnseenLatestAssistantMessage {
                pendingAttentionOverrides.removeValue(forKey: conversationId)
                return
            }
            if let targetLatestAssistantMessageAt,
               let serverLatestAssistantMessageAt = conversation.latestAssistantMessageAt,
               serverLatestAssistantMessageAt > targetLatestAssistantMessageAt {
                pendingAttentionOverrides.removeValue(forKey: conversationId)
                return
            }

            if let targetLatestAssistantMessageAt,
               conversation.latestAssistantMessageAt == nil {
                conversation.latestAssistantMessageAt = targetLatestAssistantMessageAt
            }
            conversation.hasUnseenLatestAssistantMessage = false
            conversation.lastSeenAssistantMessageAt = conversation.latestAssistantMessageAt

        case .unread(let targetLatestAssistantMessageAt):
            if conversation.hasUnseenLatestAssistantMessage {
                pendingAttentionOverrides.removeValue(forKey: conversationId)
                return
            }
            if let targetLatestAssistantMessageAt,
               let serverLatestAssistantMessageAt = conversation.latestAssistantMessageAt,
               serverLatestAssistantMessageAt > targetLatestAssistantMessageAt {
                pendingAttentionOverrides.removeValue(forKey: conversationId)
                return
            }

            if let targetLatestAssistantMessageAt,
               conversation.latestAssistantMessageAt == nil {
                conversation.latestAssistantMessageAt = targetLatestAssistantMessageAt
            }
            conversation.hasUnseenLatestAssistantMessage = true
            conversation.lastSeenAssistantMessageAt = nil
        }
    }

    private func latestLoadedAssistantMessageTimestamp(for conversationLocalId: UUID) -> Date? {
        viewModels[conversationLocalId]?.messages.last(where: { $0.role == .assistant })?.timestamp
    }

    private func canMarkConversationUnread(at index: Int) -> Bool {
        guard !conversations[index].hasUnseenLatestAssistantMessage,
              !conversations[index].shouldSuppressUnreadIndicator else { return false }
        return conversations[index].latestAssistantMessageAt != nil
            || latestLoadedAssistantMessageTimestamp(for: conversations[index].id) != nil
    }

    func latestPersistedTipDaemonMessageId(for conversationLocalId: UUID) -> String? {
        viewModels[conversationLocalId]?.messages.last(where: {
            $0.daemonMessageId != nil && !$0.isStreaming && !$0.isHidden
        })?.daemonMessageId
    }

    private func conversationFromListItem(_ item: ConversationListResponseItem) -> IOSConversation {
        let effectiveCreatedAt = item.createdAt ?? item.updatedAt
        var conversation = IOSConversation(
            title: item.title,
            createdAt: Date(timeIntervalSince1970: TimeInterval(effectiveCreatedAt) / 1000.0),
            lastActivityAt: Date(timeIntervalSince1970: TimeInterval(item.lastMessageAt ?? item.updatedAt) / 1000.0),
            conversationId: item.id,
            isPrivate: item.conversationType == "private",
            scheduleJobId: item.scheduleJobId,
            forkParent: item.forkParent,
            source: item.source,
            conversationType: item.conversationType
        )
        applyConversationMetadata(item, to: &conversation)
        return conversation
    }

    private func publishSelectionRequest(
        for conversationLocalId: UUID,
        anchorDaemonMessageId: String? = nil
    ) {
        selectionRequest = ConversationSelectionRequest(conversationLocalId: conversationLocalId)
        if let anchorDaemonMessageId {
            pendingConversationAnchorRequest = PendingConversationAnchorRequest(
                conversationLocalId: conversationLocalId,
                daemonMessageId: anchorDaemonMessageId
            )
        } else {
            pendingConversationAnchorRequest = nil
        }
    }

    /// Request selection of the conversation identified by the given conversation ID
    /// (the `String` ID used by the assistant, as opposed to the local `UUID`).
    ///
    /// Used by the push-notification tap handler: if the matching local `IOSConversation`
    /// is already loaded, publishes a selection request immediately. Otherwise defers the
    /// navigation until the conversation list catches up (cold start, reconnect, or the
    /// notification conversation hasn't been surfaced via SSE yet).
    func requestSelectConversation(conversationId: String) {
        if let index = existingConversationIndex(forConversationId: conversationId) {
            pendingPushNavigationConversationId = nil
            publishSelectionRequest(for: conversations[index].id)
        } else {
            pendingPushNavigationConversationId = conversationId
        }
    }

    /// If a push-notification tap is waiting on a conversation that wasn't loaded yet,
    /// attempt to apply it. Called after any path that can change `conversations`
    /// (list response, `schedule_conversation_created`, etc.) so the deferred navigation
    /// completes as soon as the target appears.
    private func resolvePendingPushNavigationIfPossible() {
        guard let conversationId = pendingPushNavigationConversationId,
              let index = existingConversationIndex(forConversationId: conversationId) else { return }
        pendingPushNavigationConversationId = nil
        publishSelectionRequest(for: conversations[index].id)
    }

    /// One-time migration: move data from legacy "threads" keys to new "conversations" keys.
    private static func migrateKeysIfNeeded(userDefaults: UserDefaults) {
        let defaults = userDefaults
        if let data = defaults.data(forKey: legacyPersistenceKey), defaults.data(forKey: persistenceKey) == nil {
            defaults.set(data, forKey: persistenceKey)
            defaults.removeObject(forKey: legacyPersistenceKey)
        }
        if let data = defaults.data(forKey: legacyConnectedCacheKey), defaults.data(forKey: connectedCacheKey) == nil {
            defaults.set(data, forKey: connectedCacheKey)
            defaults.removeObject(forKey: legacyConnectedCacheKey)
        }
    }

    init(
        connectionManager: GatewayConnectionManager,
        eventStreamClient: EventStreamClient,
        connectedModeOverride: Bool? = nil,
        conversationDetailClient: any ConversationDetailClientProtocol = ConversationDetailClient(),
        conversationForkClient: any ConversationForkClientProtocol = ConversationForkClient(),
        conversationHistoryClient: any ConversationHistoryClientProtocol = ConversationHistoryClient(),
        conversationListClient: any ConversationListClientProtocol = ConversationListClient(),
        conversationUnreadClient: any ConversationUnreadClientProtocol = ConversationUnreadClient(),
        userDefaults: UserDefaults = .standard
    ) {
        self.connectionManager = connectionManager
        self.eventStreamClient = eventStreamClient
        self.conversationDetailClient = conversationDetailClient
        self.conversationForkClient = conversationForkClient
        self.conversationHistoryClient = conversationHistoryClient
        self.conversationListClient = conversationListClient
        self.conversationUnreadClient = conversationUnreadClient
        self.userDefaults = userDefaults
        Self.migrateKeysIfNeeded(userDefaults: userDefaults)

        if let daemon = connectionManager as? GatewayConnectionManager, connectedModeOverride != false {
            // Connected mode — show cached conversations instantly or spinner on first launch
            isConnectedMode = true
            let cached = Self.loadConnectedCache(from: userDefaults)
            if cached.isEmpty {
                isLoadingInitialConversations = true
                conversations = [IOSConversation()]
            } else {
                isLoadingInitialConversations = false
                conversations = cached
            }
            setupDaemonCallbacks(daemon)
        } else if connectedModeOverride == true {
            isConnectedMode = true
            let cached = Self.loadConnectedCache(from: userDefaults)
            if cached.isEmpty {
                isLoadingInitialConversations = true
                conversations = [IOSConversation()]
            } else {
                isLoadingInitialConversations = false
                conversations = cached
            }
        } else {
            // Standalone mode — load from local persistence
            let loaded = Self.load(from: userDefaults)
            if loaded.isEmpty {
                let conversation = IOSConversation()
                conversations = [conversation]
                save()
            } else {
                conversations = loaded
            }
        }
    }

    // MARK: - Daemon Conversation Sync

    private func setupDaemonCallbacks(_ daemon: GatewayConnectionManager) {
        subscribeTask?.cancel()
        subscribeTask = Task { @MainActor [weak self] in
            guard let self else { return }
            for await message in self.eventStreamClient.subscribe() {
                if Task.isCancelled { break }
                switch message {
                case .scheduleConversationCreated(let msg):
                    // Avoid duplicates
                    guard !self.conversations.contains(where: { $0.conversationId == msg.conversationId }) else { break }
                    let conversation = IOSConversation(
                        title: msg.title,
                        conversationId: msg.conversationId,
                        scheduleJobId: msg.scheduleJobId
                    )
                    // Remove the empty placeholder conversation if it's still present (race:
                    // schedule_conversation_created can arrive before the first conversation_list_response).
                    if self.conversations.count == 1,
                       self.conversations[0].conversationId == nil,
                       self.viewModels[self.conversations[0].id]?.messages.isEmpty ?? true,
                       self.viewModels[self.conversations[0].id]?.conversationId == nil {
                        self.viewModels.removeValue(forKey: self.conversations[0].id)
                        self.conversations = [conversation]
                    } else {
                        self.conversations.insert(conversation, at: 0)
                    }
                    self.isLoadingInitialConversations = false
                    self.saveConnectedCache()
                    self.resolvePendingPushNavigationIfPossible()
                case .conversationTitleUpdated(let msg):
                    if let idx = self.conversations.firstIndex(where: { $0.conversationId == msg.conversationId }) {
                        self.conversations[idx].title = msg.title
                        self.saveConnectedCache()
                    }
                case .conversationListInvalidated:
                    self.scheduleInvalidationRefetch(daemon: daemon)
                default:
                    break
                }
            }
        }

        // Fetch conversation list once connected. Try immediately if already connected,
        // otherwise wait for the daemonDidReconnect notification.
        if daemon.isConnected {
            conversationListOffset = 0
            conversationListGeneration += 1
            sendPageOneConversationList(daemon: daemon)
        }

        invalidationRefetchTask?.cancel()
        invalidationRefetchTask = nil

        NotificationCenter.default.publisher(for: .daemonDidReconnect)
            .sink { [weak self, weak daemon] _ in
                guard let self, let daemon else { return }
                // Reset pagination state so the list refreshes from page 1.
                self.conversationListOffset = 0
                self.hasMoreConversations = false
                // Bump the generation counter WITHOUT touching expectedConversationListGeneration.
                // There is now a gap where conversationListGeneration = N but
                // expectedConversationListGeneration = N-1.  Any in-flight response from the
                // old connection that arrives in this window fails the
                // expectedConversationListGeneration == conversationListGeneration guard in
                // handleConversationListResponse and is correctly discarded.
                //
                // expectedConversationListGeneration is updated to N only when the new page-1
                // request is actually sent (inside sendPageOneConversationList), so if the send
                // throws the guard stays closed.
                //
                // Limitation: responses that arrive after the new page-1 has been sent
                // cannot be distinguished from the new page-1 response because the daemon
                // does not echo a request ID. Only reconnect-era staleness is detectable.
                self.conversationListGeneration += 1
                self.sendPageOneConversationList(daemon: daemon)
            }
            .store(in: &cancellables)
    }

    /// Trailing-edge debounce for conversation_list_invalidated events.
    /// Cancels any pending refetch and schedules a new one after 250ms,
    /// reusing the existing page-1 merge path.
    private func scheduleInvalidationRefetch(daemon: GatewayConnectionManager) {
        invalidationRefetchTask?.cancel()
        invalidationRefetchTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard let self, !Task.isCancelled else { return }
            self.conversationListOffset = 0
            self.hasMoreConversations = false
            self.conversationListGeneration += 1
            self.sendPageOneConversationList(daemon: daemon)
        }
    }

    /// Capture the current generation as expected and send a page-1 conversation-list request.
    ///
    /// `expectedConversationListGeneration` is updated here — not in the reconnect handler — so
    /// the guard window (conversationListGeneration != expectedConversationListGeneration) remains open
    /// for any response that arrives between the generation bump and this send.  If the send
    /// throws, the expected generation is not advanced and the guard stays closed.
    private func sendPageOneConversationList(daemon: GatewayConnectionManager) {
        let currentGeneration = conversationListGeneration
        Task { [weak self] in
            await self?.performPageOneFetch(daemon: daemon, generation: currentGeneration)
        }
    }

    /// Awaitable public entry point for manual refresh (e.g. SwiftUI `.refreshable`).
    /// Resets pagination state, bumps the generation counter, and awaits the page-1
    /// fetch so the refresh indicator reflects network latency.
    func refreshConversationList(daemon: GatewayConnectionManager) async {
        conversationListOffset = 0
        hasMoreConversations = false
        conversationListGeneration += 1
        await performPageOneFetch(daemon: daemon, generation: conversationListGeneration)
    }

    /// Async body of the page-1 fetch. Shared by the fire-and-forget
    /// `sendPageOneConversationList` path and the awaitable `refreshConversationList`
    /// path so both routes use the same generation-guard and dedup logic.
    private func performPageOneFetch(daemon: GatewayConnectionManager, generation: UInt64) async {
        // Fetch foreground and background conversations in parallel so
        // background conversations don't consume pagination slots.
        async let foregroundResult = conversationListClient.fetchConversationList(offset: 0, limit: Self.conversationPageSize, conversationType: nil)
        async let backgroundResult = conversationListClient.fetchConversationList(offset: 0, limit: Self.conversationPageSize, conversationType: "background")
        let foreground = await foregroundResult
        let background = await backgroundResult

        if let foreground {
            guard generation == conversationListGeneration else { return }
            // Deduplicate by conversation ID so that daemons that don't
            // yet support the conversationType query param (which return
            // the same conversations for both requests) don't produce
            // duplicate sidebar entries.
            var seenIds = Set(foreground.conversations.map(\.id))
            let uniqueBackground = (background?.conversations ?? []).filter {
                seenIds.insert($0.id).inserted
            }
            let merged = ConversationListResponse(
                type: foreground.type,
                conversations: foreground.conversations + uniqueBackground,
                hasMore: foreground.hasMore
            )
            expectedConversationListGeneration = generation
            lastFetchError = nil
            handleConversationListResponse(merged)
        } else {
            guard generation == conversationListGeneration else { return }
            lastFetchError = "Foreground conversation fetch returned nil — check gateway connectivity"
            isLoadingInitialConversations = false
        }
    }

    /// Re-point the store at a freshly constructed GatewayConnectionManager after `rebuildClient()`.
    ///
    /// `@StateObject` is initialised once by SwiftUI and never replaced when `ContentView`
    /// re-initialises, so when the connection is rebuilt (QR pairing, settings change) the
    /// store would otherwise keep sending messages to the old, disconnected client.  This
    /// method swaps the client reference, cancels subscriptions that captured the old
    /// client, invalidates observation loops, drops stale ChatViewModels (they reference
    /// the old client via `ChatViewModel`'s own stored reference), resets pagination, and
    /// re-registers daemon callbacks on the new client so the conversation list is refreshed
    /// from the new connection.
    func rebindGatewayConnectionManager(_ newClient: GatewayConnectionManager, eventStreamClient newEventStreamClient: EventStreamClient) {
        // Drop Combine subscriptions tied to the old GatewayConnectionManager so the reconnect
        // publisher from setupDaemonCallbacks doesn't fire against the wrong daemon.
        cancellables.removeAll()

        // Cancel the old subscribe loop so SSE messages from the previous daemon
        // are no longer processed. setupDaemonCallbacks will start a new loop.
        subscribeTask?.cancel()
        subscribeTask = nil
        invalidationRefetchTask?.cancel()
        invalidationRefetchTask = nil

        connectionManager = newClient
        eventStreamClient = newEventStreamClient

        // Existing ViewModels hold a reference to the old, disconnected client inside
        // ChatViewModel.  Discard them so new ones are created with the new client.
        viewModels.removeAll()
        invalidateAllObservationGenerations()
        lastObservedForkTipIds.removeAll()
        lastObservedMessageCounts.removeAll()
        pendingHistoryByConversationId.removeAll()
        pendingAttentionOverrides.removeAll()
        selectionRequest = nil
        pendingConversationAnchorRequest = nil
        // Stale pending push navigations target conversation IDs that belong to the
        // previous connection. The user is re-pairing or switching assistants, so the
        // old tap intent no longer applies.
        pendingPushNavigationConversationId = nil

        if let daemon = newClient as? GatewayConnectionManager {
            // Connected mode — show cached conversations instantly or spinner on first launch.
            isConnectedMode = true
            locallyEditedConversationIds.removeAll()
            locallyEditedPinConversationIds.removeAll()
            let cached = Self.loadConnectedCache(from: userDefaults)
            if cached.isEmpty {
                isLoadingInitialConversations = true
                conversations = [IOSConversation()]
            } else {
                isLoadingInitialConversations = false
                conversations = cached
            }
            conversationListOffset = 0
            conversationListGeneration += 1
            hasMoreConversations = false
            isLoadingMoreConversations = false
            setupDaemonCallbacks(daemon)
        } else {
            // Switched back to standalone mode — reload persisted conversations.
            isConnectedMode = false
            isLoadingInitialConversations = false
            locallyEditedConversationIds.removeAll()
            locallyEditedPinConversationIds.removeAll()
            pendingAttentionOverrides.removeAll()
            clearConnectedCache()
            let loaded = Self.load(from: userDefaults)
            if loaded.isEmpty {
                let conversation = IOSConversation()
                conversations = [conversation]
                save()
            } else {
                conversations = loaded
            }
        }
    }

    func handleConversationListResponse(_ response: ConversationListResponseMessage) {
        // Discard responses from a previous connection.  The daemon does not echo a
        // request ID, so within a single connection all responses are accepted in order.
        // Reconnect-era staleness is detected via the generation counter: when the
        // connection is reset, conversationListGeneration is bumped and
        // expectedConversationListGeneration is updated to match only for the new page-1
        // send.  Any response still arriving from the old connection carries the stale
        // expected generation and is dropped here.
        guard expectedConversationListGeneration == conversationListGeneration else {
            return
        }

        let filteredConversations = response.conversations.filter { $0.conversationType != "private" }

        // Handle confirmed-empty first-page response: clear stale cached conversations.
        // Only clear when hasMore is explicitly false (authoritative empty result).
        // Transient failures (HTTP errors, decode errors) emit hasMore: nil and must
        // not wipe the cache — the user should keep seeing cached conversations.
        if filteredConversations.isEmpty && conversationListOffset == 0 && response.hasMore == false {
            let keepConversations = conversations.filter { $0.conversationId == nil || $0.isPrivate }
            for conversation in conversations where conversation.conversationId != nil && !conversation.isPrivate {
                viewModels.removeValue(forKey: conversation.id)
            }
            conversations = keepConversations.isEmpty ? [IOSConversation()] : keepConversations
            isLoadingInitialConversations = false
            isLoadingMoreConversations = false
            hasMoreConversations = response.hasMore ?? false
            clearConnectedCache()
            locallyEditedConversationIds.removeAll()
            locallyEditedPinConversationIds.removeAll()
            pendingAttentionOverrides.removeAll()
            return
        }

        guard !filteredConversations.isEmpty else {
            // Empty non-first page means nothing more to append.
            isLoadingMoreConversations = false
            isLoadingInitialConversations = false
            hasMoreConversations = response.hasMore ?? false
            return
        }

        hasMoreConversations = response.hasMore ?? false
        isLoadingMoreConversations = false
        isLoadingInitialConversations = false

        var restoredConversations: [IOSConversation] = []
        for item in filteredConversations {
            let conversation = conversationFromListItem(item)
            let vm = ChatViewModel(connectionManager: connectionManager, eventStreamClient: eventStreamClient)
            vm.conversationId = item.id
            viewModels[conversation.id] = vm
            restoredConversations.append(conversation)
        }

        // First page: three-case merge logic.
        if conversationListOffset == 0 {
            let isSinglePlaceholder = conversations.count == 1
                && conversations[0].conversationId == nil
                && viewModels[conversations[0].id]?.messages.isEmpty ?? true
                && viewModels[conversations[0].id]?.conversationId == nil

            // All non-private conversations are cached (have conversationId, no VM created yet).
            let allAreCached = !conversations.isEmpty
                && conversations.filter({ !$0.isPrivate }).allSatisfy {
                    $0.conversationId != nil && viewModels[$0.id] == nil
                }

            if isSinglePlaceholder, let defaultConversation = conversations.first {
                // Case 1: Single empty placeholder — replace entirely.
                viewModels.removeValue(forKey: defaultConversation.id)
                conversations = restoredConversations
            } else if allAreCached {
                // Case 2: All conversations are from cache (no VMs, no user interaction).
                // Replace with daemon data, preserving local overrides and private conversations.
                let privateConversations = conversations.filter { $0.isPrivate }

                var localOverrides: [String: IOSConversation] = [:]
                for conversation in conversations {
                    if let sid = conversation.conversationId, locallyEditedConversationIds.contains(sid) {
                        localOverrides[sid] = conversation
                    }
                }

                var merged: [IOSConversation] = []
                for var restored in restoredConversations {
                    if let local = localOverrides[restored.conversationId ?? ""] {
                        let sid = restored.conversationId ?? ""
                        let useLocalPin = locallyEditedPinConversationIds.contains(sid)
                        restored = IOSConversation(
                            id: restored.id,
                            title: local.title,
                            createdAt: restored.createdAt,
                            lastActivityAt: restored.lastActivityAt,
                            conversationId: restored.conversationId,
                            isArchived: local.isArchived,
                            isPinned: useLocalPin ? local.isPinned : restored.isPinned,
                            displayOrder: useLocalPin ? local.displayOrder : restored.displayOrder,
                            scheduleJobId: restored.scheduleJobId,
                            forkParent: restored.forkParent,
                            groupId: restored.groupId,
                            source: restored.source,
                            conversationType: restored.conversationType,
                            originChannel: restored.originChannel,
                            hasUnseenLatestAssistantMessage: restored.hasUnseenLatestAssistantMessage,
                            latestAssistantMessageAt: restored.latestAssistantMessageAt,
                            lastSeenAssistantMessageAt: restored.lastSeenAssistantMessageAt
                        )
                    }
                    applyPendingAttentionOverride(to: &restored)
                    merged.append(restored)
                }

                conversations = merged + privateConversations
                locallyEditedConversationIds.removeAll()
                locallyEditedPinConversationIds.removeAll()
            } else {
                // Case 3: User is active (VMs exist or local conversations present).
                // Do not clear locallyEditedConversationIds — title/archive edits persist until
                // rebind (which resets all local-edit tracking).
                // Deduplicate: only prepend restored conversations whose conversationId
                // doesn't already exist in the current conversation list.
                let existingConversationIds: Set<String> = Set(
                    conversations.compactMap { conversation -> String? in
                        if let sid = conversation.conversationId { return sid }
                        return viewModels[conversation.id]?.conversationId
                    }
                )
                var newConversations: [IOSConversation] = []
                for restored in restoredConversations {
                    if let sid = restored.conversationId, existingConversationIds.contains(sid) {
                        if let existingIndex = existingConversationIndex(forConversationId: sid) {
                            var mergedConversation = conversations[existingIndex]
                            mergeConversationMetadata(from: restored, into: &mergedConversation)
                            conversations[existingIndex] = mergedConversation
                        }
                        viewModels.removeValue(forKey: restored.id)
                    } else {
                        var mergedConversation = restored
                        applyPendingAttentionOverride(to: &mergedConversation)
                        newConversations.append(mergedConversation)
                    }
                }
                conversations = newConversations + conversations
            }
            saveConnectedCache()
        } else {
            // Subsequent pages: append only conversations not already in the list.
            let existingConversationIds: Set<String> = Set(conversations.compactMap { conversation -> String? in
                if let sid = conversation.conversationId { return sid }
                return viewModels[conversation.id]?.conversationId
            })
            for restored in restoredConversations {
                if let sid = restored.conversationId, existingConversationIds.contains(sid) {
                    if let existingIndex = existingConversationIndex(forConversationId: sid) {
                        var mergedConversation = conversations[existingIndex]
                        mergeConversationMetadata(from: restored, into: &mergedConversation)
                        conversations[existingIndex] = mergedConversation
                    }
                    viewModels.removeValue(forKey: restored.id)
                } else {
                    var mergedConversation = restored
                    applyPendingAttentionOverride(to: &mergedConversation)
                    conversations.append(mergedConversation)
                }
            }
            saveConnectedCache()
        }

        // A push-notification tap may have arrived before the target conversation
        // was loaded (cold start, reconnect, cache miss). Apply it now if possible.
        resolvePendingPushNavigationIfPossible()
    }

    /// Load the next page of conversations from the daemon (Connected mode only).
    func loadMoreConversations() {
        guard isConnectedMode,
              !isLoadingMoreConversations,
              hasMoreConversations else { return }
        isLoadingMoreConversations = true
        let nextOffset = conversationListOffset + Self.conversationPageSize
        conversationListOffset = nextOffset
        let capturedGeneration = conversationListGeneration
        let capturedOffset = conversationListOffset
        Task { [weak self] in
            guard let self else { return }
            if let response = await conversationListClient.fetchConversationList(offset: nextOffset, limit: Self.conversationPageSize, conversationType: nil) {
                guard capturedGeneration == self.conversationListGeneration else { return }
                self.handleConversationListResponse(response)
            } else {
                guard self.conversationListOffset == capturedOffset else { return }
                self.isLoadingMoreConversations = false
                self.conversationListOffset -= Self.conversationPageSize
            }
        }
    }

    private func handleHistoryResponse(_ response: HistoryResponse) {
        guard let conversationLocalId = pendingHistoryByConversationId.removeValue(forKey: response.conversationId) else { return }
        guard let vm = viewModels[conversationLocalId] else { return }

        let isPaginationLoad = vm.isHistoryLoaded && vm.isLoadingMoreMessages

        vm.populateFromHistory(
            response.messages,
            hasMore: response.hasMore,
            oldestTimestamp: response.oldestTimestamp,
            isPaginationLoad: isPaginationLoad
        )

        // Wire up the onLoadMoreHistory callback if not already set.
        if vm.onLoadMoreHistory == nil {
            vm.onLoadMoreHistory = { [weak self] conversationId, beforeTimestamp in
                self?.requestPaginatedHistory(conversationId: conversationId, beforeTimestamp: beforeTimestamp)
            }
        }
    }

    /// Load history for a daemon-backed conversation when first selected.
    func loadHistoryIfNeeded(for conversationLocalId: UUID) {
        guard let conversation = conversations.first(where: { $0.id == conversationLocalId }),
              let conversationId = conversation.conversationId,
              let vm = viewModels[conversationLocalId],
              !vm.isHistoryLoaded else { return }

        pendingHistoryByConversationId[conversationId] = conversationLocalId

        // Wire up the "load more" callback for pagination.
        vm.onLoadMoreHistory = { [weak self] conversationId, beforeTimestamp in
            self?.requestPaginatedHistory(conversationId: conversationId, beforeTimestamp: beforeTimestamp)
        }

        Task { [weak self] in
            guard let self else { return }
            let response = await self.conversationHistoryClient.fetchHistory(conversationId: conversationId, limit: 50, beforeTimestamp: nil, mode: "light", maxTextChars: nil, maxToolResultChars: 1000)
            if let response {
                self.handleHistoryResponse(response)
            } else {
                self.pendingHistoryByConversationId.removeValue(forKey: conversationId)
            }
        }
    }

    /// Mark a connected conversation as seen when the user explicitly opens it.
    /// If the conversation has a pending .unread override (user chose "Mark as unread"),
    /// only an explicit open (e.g. tapping/selecting the conversation) clears that
    /// override — passive onChange callbacks leave it intact so the user's
    /// "mark as unread" action isn't immediately undone.
    func markConversationSeenIfNeeded(conversationLocalId: UUID, isExplicitOpen: Bool = false) {
        guard isConnectedMode,
              let idx = conversations.firstIndex(where: { $0.id == conversationLocalId }),
              let conversationId = conversations[idx].conversationId,
              conversations[idx].hasUnseenLatestAssistantMessage else { return }
        if case .unread = pendingAttentionOverrides[conversationId] {
            if isExplicitOpen {
                pendingAttentionOverrides.removeValue(forKey: conversationId)
            } else {
                return
            }
        }

        pendingAttentionOverrides[conversationId] = .seen(
            latestAssistantMessageAt: conversations[idx].latestAssistantMessageAt
        )
        conversations[idx].hasUnseenLatestAssistantMessage = false
        conversations[idx].lastSeenAssistantMessageAt = conversations[idx].latestAssistantMessageAt
        saveConnectedCache()

        let signal = ConversationSeenSignal(
            conversationId: conversationId,
            sourceChannel: "vellum",
            signalType: Self.attentionSignalType,
            confidence: "explicit",
            source: "ui-navigation",
            evidenceText: "User opened conversation in app"
        )
        Task { await conversationListClient.sendConversationSeen(signal) }
    }

    /// Request an older page of history for pagination.
    private func requestPaginatedHistory(conversationId: String, beforeTimestamp: Double) {
        guard let conversation = conversations.first(where: { $0.conversationId == conversationId }) else {
            return
        }
        pendingHistoryByConversationId[conversationId] = conversation.id
        Task { [weak self] in
            guard let self else { return }
            let response = await self.conversationHistoryClient.fetchHistory(conversationId: conversationId, limit: 50, beforeTimestamp: beforeTimestamp, mode: "light", maxTextChars: nil, maxToolResultChars: 1000)
            if let response {
                self.handleHistoryResponse(response)
            } else {
                self.pendingHistoryByConversationId.removeValue(forKey: conversationId)
                if let vm = self.viewModels[conversation.id] {
                    vm.isLoadingMoreMessages = false
                }
            }
        }
    }

    /// Return the ChatViewModel for the given conversation, creating it if necessary.
    func viewModel(for conversationLocalId: UUID) -> ChatViewModel {
        if let existing = viewModels[conversationLocalId] {
            wireReconnectCallback(vm: existing, conversationLocalId: conversationLocalId)
            // Only start observation loops that aren't already running for this
            // conversation. viewModel(for:) is called on every SwiftUI body
            // evaluation; without these guards each call would increment the
            // generation counter and restart the loop unnecessarily.
            if activityGenerations[conversationLocalId] == nil {
                observeForActivityTracking(vm: existing, conversationLocalId: conversationLocalId)
            }
            if forkGenerations[conversationLocalId] == nil {
                observeForForkAvailability(vm: existing, conversationLocalId: conversationLocalId)
            }
            updateForkCommandHandler(vm: existing, conversationLocalId: conversationLocalId)
            // Ensure the SSE message loop is running so cross-device messages
            // (e.g. sent from macOS) appear in real-time. ensureMessageLoopStarted()
            // is a no-op when the loop is already active (guards on messageLoopTask).
            existing.ensureMessageLoopStarted()
            return existing
        }
        let vm = ChatViewModel(connectionManager: connectionManager, eventStreamClient: eventStreamClient)
        viewModels[conversationLocalId] = vm

        // Copy conversationId from the conversation so the VM joins the existing
        // daemon conversation instead of bootstrapping a new one.
        if let conversation = conversations.first(where: { $0.id == conversationLocalId }) {
            vm.conversationId = conversation.conversationId
        }

        // Backfill the local IOSConversation.conversationId when the daemon assigns
        // one, so the conversation-list dedup in handleConversationListResponse can
        // match server rows against local rows without relying on viewModels lookup.
        vm.onConversationCreated = { [weak self] conversationId in
            self?.backfillConversationId(conversationId, for: conversationLocalId)
        }

        wireReconnectCallback(vm: vm, conversationLocalId: conversationLocalId)
        observeForForkAvailability(vm: vm, conversationLocalId: conversationLocalId)
        updateForkCommandHandler(vm: vm, conversationLocalId: conversationLocalId)
        observeForActivityTracking(vm: vm, conversationLocalId: conversationLocalId)
        // Start the SSE message loop so messages from other devices (e.g. macOS)
        // appear in real-time. Without this, the loop only starts as a side-effect
        // of sending a message via MessageSendCoordinator. (LUM-1034)
        vm.ensureMessageLoopStarted()
        return vm
    }

    private func observeForForkAvailability(vm: ChatViewModel, conversationLocalId: UUID) {
        let generation = nextGeneration(in: &forkGenerations, for: conversationLocalId)
        let initialTipId = Self.latestTipDaemonMessageId(from: vm.messageManager.messages)
        lastObservedForkTipIds[conversationLocalId] = initialTipId
        updateForkCommandHandler(vm: vm, conversationLocalId: conversationLocalId, knownTipId: initialTipId)
        observeForkAvailabilityLoop(vm: vm, conversationLocalId: conversationLocalId, generation: generation)
    }

    private func observeForkAvailabilityLoop(vm: ChatViewModel, conversationLocalId: UUID, generation: Int) {
        guard forkGenerations[conversationLocalId] == generation else { return }
        let messageManager = vm.messageManager
        withObservationTracking {
            _ = messageManager.messages
        } onChange: { [weak self, weak vm] in
            Task { @MainActor [weak self, weak vm] in
                guard let self, let vm,
                      self.forkGenerations[conversationLocalId] == generation else { return }
                let tipId = Self.latestTipDaemonMessageId(from: vm.messageManager.messages)
                let previous = self.lastObservedForkTipIds[conversationLocalId] ?? nil
                if tipId != previous {
                    self.lastObservedForkTipIds[conversationLocalId] = tipId
                    self.updateForkCommandHandler(vm: vm, conversationLocalId: conversationLocalId, knownTipId: tipId)
                }
                self.observeForkAvailabilityLoop(vm: vm, conversationLocalId: conversationLocalId, generation: generation)
            }
        }
    }

    private static func latestTipDaemonMessageId(from messages: [ChatMessage]) -> String? {
        messages.last(where: { $0.daemonMessageId != nil && !$0.isStreaming && !$0.isHidden })?.daemonMessageId
    }

    private func updateForkCommandHandler(vm: ChatViewModel, conversationLocalId: UUID, knownTipId: String? = nil) {
        let hasTip = knownTipId != nil || latestPersistedTipDaemonMessageId(for: conversationLocalId) != nil
        guard isConnectedMode,
              let conversation = conversations.first(where: { $0.id == conversationLocalId }),
              !conversation.isPrivate,
              conversation.conversationId != nil,
              hasTip else {
            vm.onFork = nil
            return
        }

        vm.onFork = { [weak self] in
            Task { @MainActor [weak self] in
                _ = await self?.forkCurrentTip(conversationLocalId: conversationLocalId)
            }
        }
    }

    /// Wire the reconnect history callback so the store registers in
    /// pendingHistoryByConversationId and the response is properly routed back.
    private func wireReconnectCallback(vm: ChatViewModel, conversationLocalId: UUID) {
        guard vm.onReconnectHistoryNeeded == nil else { return }
        vm.onReconnectHistoryNeeded = { [weak self] conversationId in
            guard let self else { return }
            self.pendingHistoryByConversationId[conversationId] = conversationLocalId
            Task { [weak self] in
                guard let self else { return }
                let response = await self.conversationHistoryClient.fetchHistory(conversationId: conversationId, limit: 50, beforeTimestamp: nil, mode: "light", maxTextChars: nil, maxToolResultChars: 1000)
                if let response {
                    self.handleHistoryResponse(response)
                } else {
                    self.pendingHistoryByConversationId.removeValue(forKey: conversationId)
                }
            }
        }
    }

    /// Update lastActivityAt whenever the message count changes (not on every streaming delta).
    /// Skips updates while the VM is loading history so that hydrating old messages
    /// doesn't stamp the conversation as recently active.
    private func observeForActivityTracking(vm: ChatViewModel, conversationLocalId: UUID) {
        let generation = nextGeneration(in: &activityGenerations, for: conversationLocalId)
        lastObservedMessageCounts[conversationLocalId] = vm.messageManager.messages.count
        observeActivityTrackingLoop(vm: vm, conversationLocalId: conversationLocalId, generation: generation)
    }

    private func observeActivityTrackingLoop(vm: ChatViewModel, conversationLocalId: UUID, generation: Int) {
        guard activityGenerations[conversationLocalId] == generation else { return }
        let messageManager = vm.messageManager
        withObservationTracking {
            _ = messageManager.messages
        } onChange: { [weak self, weak vm] in
            Task { @MainActor [weak self, weak vm] in
                guard let self, let vm,
                      self.activityGenerations[conversationLocalId] == generation else { return }
                let newCount = vm.messageManager.messages.count
                let previousCount = self.lastObservedMessageCounts[conversationLocalId] ?? 0
                if newCount != previousCount {
                    self.lastObservedMessageCounts[conversationLocalId] = newCount
                    if !vm.isLoadingHistory {
                        self.touchLastActivity(for: conversationLocalId)
                    }
                }
                self.observeActivityTrackingLoop(vm: vm, conversationLocalId: conversationLocalId, generation: generation)
            }
        }
    }

    // MARK: - Observation Generation Helpers

    private func nextGeneration(in store: inout [UUID: Int], for conversationLocalId: UUID) -> Int {
        let next = (store[conversationLocalId] ?? 0) + 1
        store[conversationLocalId] = next
        return next
    }

    /// Remove all generation counters for a conversation, causing any in-flight
    /// observation loops to bail out on their next re-arm check. Also allows
    /// `viewModel(for:)` to restart loops on the next call since the nil-check
    /// guards will pass.
    private func invalidateObservationGenerations(for conversationLocalId: UUID) {
        forkGenerations.removeValue(forKey: conversationLocalId)
        activityGenerations.removeValue(forKey: conversationLocalId)
    }

    private func invalidateAllObservationGenerations() {
        forkGenerations.removeAll()
        activityGenerations.removeAll()
    }

    @discardableResult
    func newConversation() -> IOSConversation {
        let conversation = IOSConversation()
        conversations.append(conversation)
        save()
        return conversation
    }

    func deleteConversation(_ conversation: IOSConversation) {
        viewModels.removeValue(forKey: conversation.id)
        invalidateObservationGenerations(for: conversation.id)
        lastObservedForkTipIds.removeValue(forKey: conversation.id)
        lastObservedMessageCounts.removeValue(forKey: conversation.id)
        if let sid = conversation.conversationId {
            locallyEditedConversationIds.remove(sid)
            locallyEditedPinConversationIds.remove(sid)
            pendingAttentionOverrides.removeValue(forKey: sid)
        }
        conversations.removeAll { $0.id == conversation.id }
        // Always keep at least one active (non-archived) non-private conversation.
        // Private conversations are managed separately and should not prevent the
        // regular conversation list from being empty.
        if conversations.filter({ !$0.isArchived && !$0.isPrivate }).isEmpty {
            newConversation()
        } else {
            save()
        }
        saveConnectedCache()
    }

    func updateTitle(_ title: String, for conversationLocalId: UUID) {
        guard let idx = conversations.firstIndex(where: { $0.id == conversationLocalId }) else { return }
        conversations[idx].title = title
        if let sid = conversations[idx].conversationId { locallyEditedConversationIds.insert(sid) }
        save()
        saveConnectedCache()
    }

    func archiveConversation(_ conversation: IOSConversation) {
        guard let idx = conversations.firstIndex(where: { $0.id == conversation.id }) else { return }
        conversations[idx].isArchived = true
        if let sid = conversations[idx].conversationId { locallyEditedConversationIds.insert(sid) }
        save()
        saveConnectedCache()
    }

    /// Pin is only valid on non-archived conversations: `sendReorderConversations()`
    /// filters archived entries, so pinning an archived conversation would never reach
    /// the server and would create permanent local/remote divergence.
    func pinConversation(_ conversation: IOSConversation) {
        guard isConnectedMode,
              let idx = conversations.firstIndex(where: { $0.id == conversation.id }),
              conversations[idx].conversationId != nil,
              !conversations[idx].isArchived,
              !conversations[idx].isPinned else { return }

        conversations[idx].isPinned = true
        conversations[idx].displayOrder = Int.max
        if let sid = conversations[idx].conversationId {
            locallyEditedConversationIds.insert(sid)
            locallyEditedPinConversationIds.insert(sid)
        }
        recompactPinnedDisplayOrders()
        sendReorderConversations()
        saveConnectedCache()
    }

    /// Unpin is only valid on non-archived conversations (see `pinConversation` docstring).
    func unpinConversation(_ conversation: IOSConversation) {
        guard isConnectedMode,
              let idx = conversations.firstIndex(where: { $0.id == conversation.id }),
              conversations[idx].conversationId != nil,
              !conversations[idx].isArchived,
              conversations[idx].isPinned else { return }

        conversations[idx].isPinned = false
        conversations[idx].displayOrder = nil
        if let sid = conversations[idx].conversationId {
            locallyEditedConversationIds.insert(sid)
            locallyEditedPinConversationIds.insert(sid)
        }
        recompactPinnedDisplayOrders()
        sendReorderConversations()
        saveConnectedCache()
    }

    func markConversationUnread(_ conversation: IOSConversation) {
        guard isConnectedMode,
              let idx = conversations.firstIndex(where: { $0.id == conversation.id }),
              let conversationId = conversations[idx].conversationId,
              canMarkConversationUnread(at: idx) else { return }

        let latestAssistantMessageAt =
            conversations[idx].latestAssistantMessageAt
            ?? latestLoadedAssistantMessageTimestamp(for: conversations[idx].id)
        guard let latestAssistantMessageAt else { return }

        let previousLastSeenAssistantMessageAt = conversations[idx].lastSeenAssistantMessageAt
        let previousOverride = pendingAttentionOverrides[conversationId]

        pendingAttentionOverrides[conversationId] = .unread(
            latestAssistantMessageAt: latestAssistantMessageAt
        )
        conversations[idx].latestAssistantMessageAt = latestAssistantMessageAt
        conversations[idx].hasUnseenLatestAssistantMessage = true
        conversations[idx].lastSeenAssistantMessageAt = nil
        saveConnectedCache()

        let signal = ConversationUnreadSignal(
            conversationId: conversationId,
            sourceChannel: "vellum",
            signalType: Self.attentionSignalType,
            confidence: "explicit",
            source: "ui-navigation",
            evidenceText: "User selected Mark as unread"
        )
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await self.conversationUnreadClient.sendConversationUnread(signal)
            } catch {
                self.rollbackUnreadMutationIfNeeded(
                    conversationLocalId: conversation.id,
                    conversationId: conversationId,
                    latestAssistantMessageAt: latestAssistantMessageAt,
                    previousLastSeenAssistantMessageAt: previousLastSeenAssistantMessageAt,
                    previousOverride: previousOverride
                )
            }
        }
    }

    func unarchiveConversation(_ conversation: IOSConversation) {
        guard let idx = conversations.firstIndex(where: { $0.id == conversation.id }) else { return }
        conversations[idx].isArchived = false
        if let sid = conversations[idx].conversationId { locallyEditedConversationIds.insert(sid) }
        save()
        saveConnectedCache()
    }

    /// Update lastActivityAt to now for the given conversation.
    func touchLastActivity(for conversationLocalId: UUID) {
        guard let idx = conversations.firstIndex(where: { $0.id == conversationLocalId }) else { return }
        conversations[idx].lastActivityAt = Date()
        save()
    }

    func consumeSelectionRequest(id: UUID) {
        guard selectionRequest?.id == id else { return }
        selectionRequest = nil
    }

    func pendingAnchorRequest(for conversationLocalId: UUID) -> PendingConversationAnchorRequest? {
        guard pendingConversationAnchorRequest?.conversationLocalId == conversationLocalId else { return nil }
        return pendingConversationAnchorRequest
    }

    func consumePendingAnchorRequest(id: UUID) {
        guard pendingConversationAnchorRequest?.id == id else { return }
        pendingConversationAnchorRequest = nil
    }

    private func upsertConversationListItem(_ item: ConversationListResponseItem) -> UUID {
        if let existingIndex = existingConversationIndex(forConversationId: item.id) {
            var mergedConversation = conversations[existingIndex]
            mergedConversation.title = item.title
            mergedConversation.lastActivityAt = Date(
                timeIntervalSince1970: TimeInterval(item.lastMessageAt ?? item.updatedAt) / 1000.0
            )
            mergeConversationMetadata(from: conversationFromListItem(item), into: &mergedConversation)
            conversations[existingIndex] = mergedConversation
            return mergedConversation.id
        }

        let forkedConversation = conversationFromListItem(item)
        let isSinglePlaceholder = conversations.count == 1
            && conversations[0].conversationId == nil
            && viewModels[conversations[0].id]?.messages.isEmpty ?? true
            && viewModels[conversations[0].id]?.conversationId == nil

        if isSinglePlaceholder {
            viewModels.removeValue(forKey: conversations[0].id)
            conversations = [forkedConversation]
        } else {
            conversations.insert(forkedConversation, at: 0)
        }
        return forkedConversation.id
    }

    @discardableResult
    func openForkParent(of conversationLocalId: UUID) async -> UUID? {
        guard isConnectedMode,
              let conversation = conversations.first(where: { $0.id == conversationLocalId }),
              !conversation.isPrivate,
              let forkParent = conversation.forkParent else {
            return nil
        }

        let parentLocalId: UUID
        if let existingIndex = existingConversationIndex(forConversationId: forkParent.conversationId) {
            guard !conversations[existingIndex].isPrivate else { return nil }
            parentLocalId = conversations[existingIndex].id
        } else {
            guard let parentConversation = await conversationDetailClient.fetchConversation(
                conversationId: forkParent.conversationId
            ), parentConversation.conversationType != "private" else {
                return nil
            }
            parentLocalId = upsertConversationListItem(parentConversation)
            saveConnectedCache()
        }

        publishSelectionRequest(
            for: parentLocalId,
            anchorDaemonMessageId: forkParent.messageId
        )
        return parentLocalId
    }

    @discardableResult
    func forkConversation(conversationLocalId: UUID, throughDaemonMessageId: String?) async -> UUID? {
        guard isConnectedMode,
              let conversation = conversations.first(where: { $0.id == conversationLocalId }),
              let conversationId = conversation.conversationId,
              let forkedConversation = await conversationForkClient.forkConversation(
                  conversationId: conversationId,
                  throughMessageId: throughDaemonMessageId
              ) else {
            return nil
        }

        let forkedLocalId = upsertConversationListItem(forkedConversation)
        saveConnectedCache()
        publishSelectionRequest(for: forkedLocalId)
        return forkedLocalId
    }

    @discardableResult
    func forkCurrentTip(conversationLocalId: UUID) async -> UUID? {
        guard let conversation = conversations.first(where: { $0.id == conversationLocalId }),
              !conversation.isPrivate,
              let daemonMessageId = latestPersistedTipDaemonMessageId(for: conversationLocalId) else {
            return nil
        }
        return await forkConversation(
            conversationLocalId: conversationLocalId,
            throughDaemonMessageId: daemonMessageId
        )
    }

    private func rollbackUnreadMutationIfNeeded(
        conversationLocalId: UUID,
        conversationId: String,
        latestAssistantMessageAt: Date,
        previousLastSeenAssistantMessageAt: Date?,
        previousOverride: PendingAttentionOverride?
    ) {
        guard let idx = conversations.firstIndex(where: { $0.id == conversationLocalId }),
              conversations[idx].conversationId == conversationId,
              case .unread(let pendingLatestAssistantMessageAt) = pendingAttentionOverrides[conversationId],
              pendingLatestAssistantMessageAt == latestAssistantMessageAt else { return }

        if let previousOverride {
            pendingAttentionOverrides[conversationId] = previousOverride
        } else {
            pendingAttentionOverrides.removeValue(forKey: conversationId)
        }
        conversations[idx].hasUnseenLatestAssistantMessage = false
        conversations[idx].lastSeenAssistantMessageAt = previousLastSeenAssistantMessageAt
        saveConnectedCache()
    }

    /// Returns the last message text for a conversation, if available.
    func lastMessagePreview(for conversationLocalId: UUID) -> String? {
        guard let vm = viewModels[conversationLocalId],
              let last = vm.messages.last else { return nil }
        let text = last.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return String(text.prefix(80))
    }

    private func recompactPinnedDisplayOrders() {
        let pinned = conversations.enumerated()
            .filter { $0.element.isPinned }
            .sorted { ($0.element.displayOrder ?? Int.max) < ($1.element.displayOrder ?? Int.max) }

        for (order, item) in pinned.enumerated() {
            conversations[item.offset].displayOrder = order
        }
    }

    private func sendReorderConversations() {
        let updates = conversations.compactMap { conversation -> ReorderConversationsRequestUpdate? in
            guard let conversationId = conversation.conversationId, !conversation.isArchived, !conversation.isPrivate else {
                return nil
            }

            return ReorderConversationsRequestUpdate(
                conversationId: conversationId,
                displayOrder: conversation.displayOrder.map(Double.init),
                isPinned: conversation.isPinned
            )
        }
        guard !updates.isEmpty else { return }
        // Clear the pin-edit mask for these conversations once the POST
        // completes. `mergeConversationMetadata` only clears the mask when
        // server state exactly matches local state — which never holds if
        // another device toggles the same pin between our POST and our next
        // refetch, causing the mask to stick permanently and suppress all
        // future server pin updates for that conversation.
        let affectedIds = updates.map { $0.conversationId }
        Task { [weak self] in
            _ = await self?.conversationListClient.reorderConversations(updates: updates)
            guard let self else { return }
            for id in affectedIds {
                self.locallyEditedPinConversationIds.remove(id)
            }
        }
    }

    // MARK: - Persistence

    // MARK: Connected-mode cache

    private func saveConnectedCache() {
        guard isConnectedMode else { return }
        let cacheable = conversations.filter { $0.conversationId != nil && !$0.isPrivate }
        guard !cacheable.isEmpty else {
            userDefaults.removeObject(forKey: Self.connectedCacheKey)
            return
        }
        let persisted = cacheable.map {
            PersistedConversation(
                id: $0.id,
                title: $0.title,
                createdAt: $0.createdAt,
                lastActivityAt: $0.lastActivityAt,
                isArchived: $0.isArchived,
                isPinned: $0.isPinned,
                displayOrder: $0.displayOrder,
                isPrivate: false,
                conversationId: $0.conversationId,
                scheduleJobId: $0.scheduleJobId,
                forkParent: $0.forkParent,
                source: $0.source,
                conversationType: $0.conversationType,
                originChannel: $0.originChannel,
                hasUnseenLatestAssistantMessage: $0.hasUnseenLatestAssistantMessage,
                latestAssistantMessageAt: $0.latestAssistantMessageAt,
                lastSeenAssistantMessageAt: $0.lastSeenAssistantMessageAt
            )
        }
        if let data = try? JSONEncoder().encode(persisted) {
            userDefaults.set(data, forKey: Self.connectedCacheKey)
        }
    }

    private static func loadConnectedCache(from userDefaults: UserDefaults) -> [IOSConversation] {
        guard let data = userDefaults.data(forKey: connectedCacheKey),
              let persisted = try? JSONDecoder().decode([PersistedConversation].self, from: data) else {
            return []
        }
        return persisted.compactMap { p in
            guard p.conversationId != nil, !(p.isPrivate ?? false) else { return nil }
            return IOSConversation(
                id: p.id,
                title: p.title,
                createdAt: p.createdAt,
                lastActivityAt: p.lastActivityAt,
                conversationId: p.conversationId,
                isArchived: p.isArchived ?? false,
                isPinned: p.isPinned ?? false,
                displayOrder: p.displayOrder,
                isPrivate: false,
                scheduleJobId: p.scheduleJobId,
                forkParent: p.forkParent,
                source: p.source,
                conversationType: p.conversationType,
                originChannel: p.originChannel,
                hasUnseenLatestAssistantMessage: p.hasUnseenLatestAssistantMessage ?? false,
                latestAssistantMessageAt: p.latestAssistantMessageAt,
                lastSeenAssistantMessageAt: p.lastSeenAssistantMessageAt
            )
        }
    }

    private func clearConnectedCache() {
        userDefaults.removeObject(forKey: Self.connectedCacheKey)
    }

    private func save() {
        // Don't persist daemon-synced conversations — they're loaded on connect.
        guard !isConnectedMode else { return }
        let persisted = conversations.map {
            PersistedConversation(
                id: $0.id,
                title: $0.title,
                createdAt: $0.createdAt,
                lastActivityAt: $0.lastActivityAt,
                isArchived: $0.isArchived,
                isPrivate: $0.isPrivate,
                conversationId: $0.conversationId,
                scheduleJobId: $0.scheduleJobId,
                forkParent: $0.forkParent,
                source: $0.source,
                conversationType: $0.conversationType
            )
        }
        if let data = try? JSONEncoder().encode(persisted) {
            userDefaults.set(data, forKey: Self.persistenceKey)
        }
    }

    private static func load(from userDefaults: UserDefaults) -> [IOSConversation] {
        guard let data = userDefaults.data(forKey: persistenceKey),
              let persisted = try? JSONDecoder().decode([PersistedConversation].self, from: data) else {
            return []
        }
        return persisted.map {
            IOSConversation(
                id: $0.id,
                title: $0.title,
                createdAt: $0.createdAt,
                lastActivityAt: $0.lastActivityAt,
                conversationId: $0.conversationId,
                isArchived: $0.isArchived ?? false,
                isPrivate: $0.isPrivate ?? false,
                scheduleJobId: $0.scheduleJobId,
                forkParent: $0.forkParent,
                source: $0.source,
                conversationType: $0.conversationType
            )
        }
    }
}
#endif
