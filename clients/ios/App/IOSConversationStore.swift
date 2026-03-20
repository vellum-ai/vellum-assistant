#if canImport(UIKit)
import Combine
import SwiftUI
import VellumAssistantShared

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
    var hasUnseenLatestAssistantMessage: Bool
    var latestAssistantMessageAt: Date?
    var lastSeenAssistantMessageAt: Date?

    /// Whether this conversation was created by a schedule trigger (including one-shot/reminders).
    /// Keeps legacy "Reminder: " prefix check for conversations created before unification.
    var isScheduleConversation: Bool {
        if scheduleJobId != nil { return true }
        return title.hasPrefix("Schedule: ") || title.hasPrefix("Schedule (manual): ") || title.hasPrefix("Reminder: ")
    }

    init(id: UUID = UUID(), title: String = "New Chat", createdAt: Date = Date(), lastActivityAt: Date? = nil, conversationId: String? = nil, isArchived: Bool = false, isPinned: Bool = false, displayOrder: Int? = nil, isPrivate: Bool = false, scheduleJobId: String? = nil, forkParent: ConversationForkParent? = nil, hasUnseenLatestAssistantMessage: Bool = false, latestAssistantMessageAt: Date? = nil, lastSeenAssistantMessageAt: Date? = nil) {
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
    var hasUnseenLatestAssistantMessage: Bool?
    var latestAssistantMessageAt: Date?
    var lastSeenAssistantMessageAt: Date?

    // Decode both the legacy "sessionId" key and the current "conversationId"
    // key so UserDefaults data written by any version (pre-rename, intermediate,
    // or current) is read correctly.  Encoding always uses "conversationId".
    enum CodingKeys: String, CodingKey {
        case id, title, createdAt, lastActivityAt, isArchived, isPinned, displayOrder, isPrivate
        case conversationId
        case scheduleJobId, forkParent, hasUnseenLatestAssistantMessage, latestAssistantMessageAt, lastSeenAssistantMessageAt
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

    /// ViewModels keyed by conversation ID, created lazily on first access.
    private var viewModels: [UUID: ChatViewModel] = [:]
    private var daemonClient: any DaemonClientProtocol
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
    private var cancellables: Set<AnyCancellable> = []
    /// Task running the SSE subscribe loop for daemon messages.
    private var subscribeTask: Task<Void, Never>?
    /// Maps daemon conversation IDs to local conversation IDs for history loading.
    private var pendingHistoryByConversationId: [String: UUID] = [:]
    /// Tracks conversation IDs that already have an activity-tracking observer to avoid duplicates.
    private var observedActivityConversationIds: Set<UUID> = []
    /// Tracks conversation IDs that already have an exact `/fork` availability observer.
    private var observedForkAvailabilityConversationIds: Set<UUID> = []
    /// Number of conversations per page when listing conversations from the daemon.
    private static let conversationPageSize = 50
    private static let attentionSignalType = "ios_conversation_opened"
    /// Current offset used for the next page fetch; advances by `conversationPageSize` on each load.
    private var conversationListOffset: Int = 0
    /// Reconnect-generation counter. Incremented only when pagination is reset due to a
    /// reconnect (or a `rebindDaemonClient` call). Never incremented on ordinary
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
        conversation.hasUnseenLatestAssistantMessage =
            item.assistantAttention?.hasUnseenLatestAssistantMessage ?? false
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

    private func mergeConversationMetadata(from restored: IOSConversation, into conversation: inout IOSConversation) {
        conversation.conversationId = restored.conversationId ?? conversation.conversationId
        conversation.scheduleJobId = restored.scheduleJobId ?? conversation.scheduleJobId
        conversation.forkParent = restored.forkParent
        let hasLocalPinEdit = conversation.conversationId.map { locallyEditedPinConversationIds.contains($0) } ?? false
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
        conversation.hasUnseenLatestAssistantMessage = restored.hasUnseenLatestAssistantMessage
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
        guard !conversations[index].hasUnseenLatestAssistantMessage else { return false }
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
            lastActivityAt: Date(timeIntervalSince1970: TimeInterval(item.updatedAt) / 1000.0),
            conversationId: item.id,
            isPrivate: item.conversationType == "private",
            scheduleJobId: item.scheduleJobId,
            forkParent: item.forkParent
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
        daemonClient: any DaemonClientProtocol,
        connectedModeOverride: Bool? = nil,
        conversationDetailClient: any ConversationDetailClientProtocol = ConversationDetailClient(),
        conversationForkClient: any ConversationForkClientProtocol = ConversationForkClient(),
        conversationHistoryClient: any ConversationHistoryClientProtocol = ConversationHistoryClient(),
        conversationListClient: any ConversationListClientProtocol = ConversationListClient(),
        conversationUnreadClient: any ConversationUnreadClientProtocol = ConversationUnreadClient(),
        userDefaults: UserDefaults = .standard
    ) {
        self.daemonClient = daemonClient
        self.conversationDetailClient = conversationDetailClient
        self.conversationForkClient = conversationForkClient
        self.conversationHistoryClient = conversationHistoryClient
        self.conversationListClient = conversationListClient
        self.conversationUnreadClient = conversationUnreadClient
        self.userDefaults = userDefaults
        Self.migrateKeysIfNeeded(userDefaults: userDefaults)

        if let daemon = daemonClient as? DaemonClient, connectedModeOverride != false {
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

    private func setupDaemonCallbacks(_ daemon: DaemonClient) {
        subscribeTask?.cancel()
        subscribeTask = Task { @MainActor [weak self] in
            guard let self else { return }
            for await message in daemon.subscribe() {
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

    /// Capture the current generation as expected and send a page-1 conversation-list request.
    ///
    /// `expectedConversationListGeneration` is updated here — not in the reconnect handler — so
    /// the guard window (conversationListGeneration != expectedConversationListGeneration) remains open
    /// for any response that arrives between the generation bump and this send.  If the send
    /// throws, the expected generation is not advanced and the guard stays closed.
    private func sendPageOneConversationList(daemon: DaemonClient) {
        let currentGeneration = conversationListGeneration
        Task { [weak self] in
            guard let self else { return }
            if let response = await conversationListClient.fetchConversationList(offset: 0, limit: Self.conversationPageSize) {
                guard currentGeneration == self.conversationListGeneration else { return }
                self.expectedConversationListGeneration = currentGeneration
                self.handleConversationListResponse(response)
            } else {
                guard currentGeneration == self.conversationListGeneration else { return }
                self.isLoadingInitialConversations = false
            }
        }
    }

    /// Re-point the store at a freshly constructed DaemonClient after `rebuildClient()`.
    ///
    /// `@StateObject` is initialised once by SwiftUI and never replaced when `ContentView`
    /// re-initialises, so when the connection is rebuilt (QR pairing, settings change) the
    /// store would otherwise keep sending messages to the old, disconnected client.  This
    /// method swaps the client reference, cancels Combine subscriptions that captured the old
    /// client, drops stale ChatViewModels (they reference the old client via `ChatViewModel`'s
    /// own stored reference), resets pagination, and re-registers daemon callbacks on the new
    /// client so the conversation list is refreshed from the new connection.
    func rebindDaemonClient(_ newClient: any DaemonClientProtocol) {
        // Drop Combine subscriptions tied to the old DaemonClient so the reconnect
        // publisher from setupDaemonCallbacks doesn't fire against the wrong daemon.
        cancellables.removeAll()

        // Cancel the old subscribe loop so SSE messages from the previous daemon
        // are no longer processed. setupDaemonCallbacks will start a new loop.
        subscribeTask?.cancel()
        subscribeTask = nil

        daemonClient = newClient

        // Existing ViewModels hold a reference to the old, disconnected client inside
        // ChatViewModel.  Discard them so new ones are created with the new client.
        viewModels.removeAll()
        observedActivityConversationIds.removeAll()
        observedForkAvailabilityConversationIds.removeAll()
        pendingHistoryByConversationId.removeAll()
        pendingAttentionOverrides.removeAll()
        selectionRequest = nil
        pendingConversationAnchorRequest = nil

        if let daemon = newClient as? DaemonClient {
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

    private func handleConversationListResponse(_ response: ConversationListResponseMessage) {
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
            let vm = ChatViewModel(daemonClient: daemonClient)
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
            if let response = await conversationListClient.fetchConversationList(offset: nextOffset, limit: Self.conversationPageSize) {
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
            observeForActivityTracking(vm: existing, conversationLocalId: conversationLocalId)
            observeForForkAvailability(vm: existing, conversationLocalId: conversationLocalId)
            updateForkCommandHandler(vm: existing, conversationLocalId: conversationLocalId)
            return existing
        }
        let vm = ChatViewModel(daemonClient: daemonClient)
        viewModels[conversationLocalId] = vm

        // Copy conversationId from the conversation so the VM joins the existing
        // daemon conversation instead of bootstrapping a new one.
        if let conversation = conversations.first(where: { $0.id == conversationLocalId }) {
            vm.conversationId = conversation.conversationId
        }

        wireReconnectCallback(vm: vm, conversationLocalId: conversationLocalId)
        observeForForkAvailability(vm: vm, conversationLocalId: conversationLocalId)
        updateForkCommandHandler(vm: vm, conversationLocalId: conversationLocalId)

        // Only auto-title conversations without a daemon conversation (new local conversations).
        // Daemon conversations already have titles from the conversation list.
        if conversations.first(where: { $0.id == conversationLocalId })?.conversationId == nil {
            observeForTitleGeneration(vm: vm, conversationLocalId: conversationLocalId)
        }
        observeForActivityTracking(vm: vm, conversationLocalId: conversationLocalId)
        return vm
    }

    private func observeForForkAvailability(vm: ChatViewModel, conversationLocalId: UUID) {
        guard !observedForkAvailabilityConversationIds.contains(conversationLocalId) else { return }
        observedForkAvailabilityConversationIds.insert(conversationLocalId)

        vm.messageManager.$messages
            .map { messages in
                messages.last(where: { $0.daemonMessageId != nil && !$0.isStreaming && !$0.isHidden })?.daemonMessageId
            }
            .removeDuplicates()
            .sink { [weak self, weak vm] latestTipId in
                guard let self, let vm else { return }
                self.updateForkCommandHandler(vm: vm, conversationLocalId: conversationLocalId, knownTipId: latestTipId)
            }
            .store(in: &cancellables)
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

    /// Watch for the first completed assistant reply to auto-title the conversation.
    private func observeForTitleGeneration(vm: ChatViewModel, conversationLocalId: UUID) {
        // Find the conversation's default title; skip if already customized.
        guard conversations.first(where: { $0.id == conversationLocalId })?.title == "New Chat" else { return }

        vm.messageManager.$messages
            .dropFirst()
            .compactMap { messages -> String? in
                // Trigger once we have at least one user message and the first assistant
                // reply has finished streaming (isStreaming == false).
                guard let firstUser = messages.first(where: { $0.role == .user }),
                      !firstUser.text.isEmpty,
                      messages.contains(where: { $0.role == .assistant && !$0.isStreaming }) else {
                    return nil
                }
                return firstUser.text
            }
            .first()
            .sink { [weak self] firstUserMessage in
                guard let self else { return }
                Task {
                    if let title = await TitleGenerator.shared.generateTitle(
                        for: conversationLocalId,
                        firstUserMessage: firstUserMessage
                    ) {
                        await MainActor.run {
                            self.updateTitle(title, for: conversationLocalId)
                        }
                    }
                }
            }
            .store(in: &cancellables)
    }

    /// Update lastActivityAt whenever the message count changes (not on every streaming delta).
    /// Skips updates while the VM is loading history so that hydrating old messages
    /// doesn't stamp the conversation as recently active.
    private func observeForActivityTracking(vm: ChatViewModel, conversationLocalId: UUID) {
        guard !observedActivityConversationIds.contains(conversationLocalId) else { return }
        observedActivityConversationIds.insert(conversationLocalId)

        vm.messageManager.$messages
            .dropFirst()
            .map(\.count)
            .removeDuplicates()
            .sink { [weak self, weak vm] _ in
                guard let vm, !vm.isLoadingHistory else { return }
                self?.touchLastActivity(for: conversationLocalId)
            }
            .store(in: &cancellables)
    }

    /// Private conversations are excluded from the conversation list response filter, so they
    /// won't appear in the normal active conversation list.
    var privateConversations: [IOSConversation] {
        conversations.filter { $0.isPrivate }
    }

    @discardableResult
    func newConversation() -> IOSConversation {
        let conversation = IOSConversation()
        conversations.append(conversation)
        save()
        return conversation
    }

    /// Create a new private conversation with the given name. The conversation is immediately
    /// backed by a daemon conversation with conversationType "private" so it is persisted on
    /// the daemon side and excluded from normal conversation restoration.
    @discardableResult
    func newPrivateConversation(name: String = "Private Conversation") -> IOSConversation {
        let conversation = IOSConversation(title: name, isPrivate: true)
        conversations.append(conversation)
        // Get or create the view model after appending so activity tracking
        // can find the conversation in self.conversations.
        let vm = viewModel(for: conversation.id)
        vm.createConversationIfNeeded(conversationType: "private")
        save()
        return conversation
    }

    func deleteConversation(_ conversation: IOSConversation) {
        viewModels.removeValue(forKey: conversation.id)
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

    func pinConversation(_ conversation: IOSConversation) {
        guard isConnectedMode,
              let idx = conversations.firstIndex(where: { $0.id == conversation.id }),
              conversations[idx].conversationId != nil,
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

    func unpinConversation(_ conversation: IOSConversation) {
        guard isConnectedMode,
              let idx = conversations.firstIndex(where: { $0.id == conversation.id }),
              conversations[idx].conversationId != nil,
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
                timeIntervalSince1970: TimeInterval(item.updatedAt) / 1000.0
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
        Task { await conversationListClient.reorderConversations(updates: updates) }
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
                forkParent: $0.forkParent
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
                forkParent: $0.forkParent
            )
        }
    }
}
#endif
