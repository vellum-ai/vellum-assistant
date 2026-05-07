import SwiftUI
import VellumAssistantShared
import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ConversationListStore")

/// Lightweight identifiable wrapper for `ForEach` over grouped conversations.
///
/// `Equatable` conformance is load-bearing: it lets callers gate `@Observable`
/// stored-property writes with `!=` so assignments that would produce an
/// identical array do not fan out as observation notifications. Reference:
/// [Observation framework](https://developer.apple.com/documentation/observation).
struct SidebarGroupEntry: Identifiable, Equatable {
    let id: String
    let group: ConversationGroup
    let conversations: [ConversationModel]
}

/// Visible conversations grouped under a single sidebar group. `Equatable` for
/// the same reason as `SidebarGroupEntry` — `groupedConversations` writes are
/// gated on `!=`. The `group` is optional because the upstream pipeline can,
/// in principle, produce a synthesized bucket for ungrouped/orphaned items.
struct GroupedConversations: Equatable {
    let group: ConversationGroup?
    let conversations: [ConversationModel]
}

/// Owns the conversation and group arrays plus all sidebar-derived computed
/// properties, pagination, grouping, pinning, ordering, and seen/unseen state.
///
/// Separated from `ConversationManager` so that views reading only list data
/// (sidebar rows, dock badge) are isolated from selection and ViewModel
/// mutations, leveraging `@Observable` property-level tracking.
///
/// Reference: [Managing model data in your app](https://developer.apple.com/documentation/swiftui/managing-model-data-in-your-app)
@Observable
@MainActor
final class ConversationListStore {

    // MARK: - Stored Properties

    /// The full conversation list. `@ObservationIgnored` so view bodies cannot
    /// subscribe to the entire array — every mutation (pagination, heartbeat
    /// re-fetch, per-message seen flip, in-place model edit) would otherwise
    /// notify every observer and force a synchronous SwiftUI graph update
    /// inside the `willSet` hook.
    ///
    /// Views must read one of the cached scalars (`hasAnyConversations`,
    /// `unseenScheduledCount`, …), the cached lookup (`conversationsByLocalId`),
    /// or one of the cached arrays (`visibleConversations`,
    /// `archivedConversations`, `sidebarGroupEntries`, …) — all recomputed once
    /// per mutation in `recomputeDerivedProperties()` behind equality guards.
    /// Mutations continue to write through this property; the `didSet` keeps
    /// the cached views in sync.
    ///
    /// Reference: [`@ObservationIgnored`](https://developer.apple.com/documentation/observation/observationignored()).
    @ObservationIgnored var conversations: [ConversationModel] = [] {
        didSet { recomputeDerivedProperties() }
    }
    var groups: [ConversationGroup] = [] {
        didSet { recomputeDerivedProperties() }
    }

    /// Whether custom conversation groups UI is enabled. Updated by the view
    /// layer when the feature flag changes; triggers sidebar entry recomputation.
    var customGroupsEnabled: Bool = false {
        didSet {
            guard oldValue != customGroupsEnabled else { return }
            recomputeSidebarGroupEntries()
        }
    }

    /// Whether the daemon returned a non-empty groups array, indicating it supports
    /// the group system. When true, `groupId: null` from the server means "explicitly
    /// ungrouped" and the client should NOT override it with source-based heuristics.
    /// When false (old daemon), the heuristic fallback in `deriveGroupId` is needed.
    @ObservationIgnored var daemonSupportsGroups: Bool = false

    var hasMoreConversations: Bool = false
    var isLoadingMoreConversations: Bool = false

    /// Tracks the number of rows already fetched from the daemon so pagination
    /// offsets stay correct even when the client filters out some conversations.
    @ObservationIgnored var serverOffset: Int = 0

    // MARK: - Clients

    let conversationListClient: any ConversationListClientProtocol = ConversationListClient()
    /// Concrete client for group CRUD operations (not on the protocol).
    private let groupClient = ConversationListClient()
    private let conversationUnreadClient: any ConversationUnreadClientProtocol = ConversationUnreadClient()

    // MARK: - Private State

    deinit {
        reorderDebounceTask?.cancel()
        pendingSeenSignalTask?.cancel()
    }

    /// Debounce task for coalescing rapid reorder persistence calls (e.g. during drag).
    @ObservationIgnored private var reorderDebounceTask: Task<Void, Never>?

    /// Stores the groupId a conversation had before being pinned, so it can be
    /// restored on unpin instead of falling back to heuristic-based routing.
    @ObservationIgnored var prePinGroupIds: [UUID: String?] = [:]

    /// Queued renames for conversations that don't yet have a conversationId.
    /// Flushed in backfillConversationId when the daemon assigns a conversation ID.
    @ObservationIgnored var pendingRenames: [UUID: String] = [:]

    /// Local seen/unread toggles should survive a stale daemon conversation-list
    /// replay until the daemon either acknowledges them or reports a newer reply.
    @ObservationIgnored var pendingAttentionOverrides: [String: PendingAttentionOverride] = [:]

    /// Conversation IDs whose seen signals are deferred pending undo expiration.
    @ObservationIgnored var pendingSeenConversationIds: [String] = []

    /// Task that auto-commits deferred seen signals after the undo window.
    @ObservationIgnored private var pendingSeenSignalTask: Task<Void, Never>?

    /// Snapshots captured by the most recent `markAllConversationsSeen()` call,
    /// keyed by conversation ID. Consumed by `restoreUnseen(conversationIds:)`.
    @ObservationIgnored var markAllSeenPriorStates: [UUID: MarkAllSeenPriorState] = [:]

    // MARK: - Nested Types

    enum PendingAttentionOverride {
        case seen(latestAssistantMessageAt: Date?)
        case unread(latestAssistantMessageAt: Date?)
    }

    /// Per-conversation attention state captured before mark-all-seen,
    /// so the undo path can restore exact prior values.
    struct MarkAllSeenPriorState {
        let lastSeenAssistantMessageAt: Date?
        let conversationId: String?
        let override: PendingAttentionOverride?
    }

    // MARK: - Archived State (UserDefaults)

    // [String: TimeInterval] mapping conversationId -> archive time (seconds since 1970).
    // Used to sort the Settings → Archived Conversations tab by most-recently-archived.
    private static let archivedConversationsSortKey = "archivedConversationTimestamps"

    /// Timestamped archive state: conversationId -> archivedAt. Source of truth for both
    /// "is this conversation archived?" and the sort order in the Settings tab. Persisted
    /// to UserDefaults via `didSet` as `[String: TimeInterval]`.
    var archivedConversationTimestamps: [String: Date] = [:] {
        didSet {
            let encoded = archivedConversationTimestamps.mapValues { $0.timeIntervalSince1970 }
            UserDefaults.standard.set(encoded, forKey: Self.archivedConversationsSortKey)
            recomputeArchivedConversations()
        }
    }

    /// Backwards-compatible view of archived ids as a `Set<String>`. Reads return the
    /// current keyset; writes preserve existing timestamps for ids that stay archived
    /// and assign `Date.distantPast` for newly-added ids (since the caller doesn't know
    /// the archive time). Production code should prefer `markArchived`/`unmarkArchived`.
    var archivedConversationIds: Set<String> {
        get { Set(archivedConversationTimestamps.keys) }
        set {
            var updated = archivedConversationTimestamps
            for id in newValue where updated[id] == nil {
                updated[id] = .distantPast
            }
            for id in Set(updated.keys).subtracting(newValue) {
                updated.removeValue(forKey: id)
            }
            archivedConversationTimestamps = updated
        }
    }

    /// Mark a conversation as archived, recording the archive time.
    func markArchived(_ conversationId: String, at date: Date = Date()) {
        var updated = archivedConversationTimestamps
        updated[conversationId] = date
        archivedConversationTimestamps = updated
    }

    /// Mark multiple conversations as archived in one write, all at the same timestamp.
    func markArchived(_ conversationIds: some Sequence<String>, at date: Date = Date()) {
        var updated = archivedConversationTimestamps
        for id in conversationIds {
            updated[id] = date
        }
        archivedConversationTimestamps = updated
    }

    /// Remove a conversation's archive entry.
    func unmarkArchived(_ conversationId: String) {
        guard archivedConversationTimestamps[conversationId] != nil else { return }
        var updated = archivedConversationTimestamps
        updated.removeValue(forKey: conversationId)
        archivedConversationTimestamps = updated
    }

    /// Re-key an archive entry when a synthetic conversation id is resolved to a real one.
    /// Preserves the original archive timestamp so the item keeps its sort position.
    func replaceArchivedKey(from oldId: String, to newId: String) {
        guard let date = archivedConversationTimestamps[oldId] else { return }
        var updated = archivedConversationTimestamps
        updated.removeValue(forKey: oldId)
        updated[newId] = date
        archivedConversationTimestamps = updated
    }

    init() {
        self.archivedConversationTimestamps = Self.loadArchivedTimestamps()
    }

    /// Load persisted archive timestamps from UserDefaults.
    private static func loadArchivedTimestamps() -> [String: Date] {
        let defaults = UserDefaults.standard
        guard let raw = defaults.dictionary(forKey: archivedConversationsSortKey) as? [String: TimeInterval] else {
            return [:]
        }
        return raw.mapValues { Date(timeIntervalSince1970: $0) }
    }

    // MARK: - Cached Derived Properties
    //
    // Recomputed once per `conversations` / `groups` mutation in
    // `recomputeDerivedProperties`. Each write is routed through `setIfChanged`
    // so identical assignments do not fan out as `@Observable` notifications.

    private(set) var sortedGroups: [ConversationGroup] = []

    /// Visible conversations grouped by sort position. Ungrouped and orphaned
    /// items fold into the system:all bucket so they are never silently dropped.
    private(set) var groupedConversations: [GroupedConversations] = []

    /// Non-archived conversations sorted for the sidebar.
    private(set) var visibleConversations: [ConversationModel] = []

    /// Count of visible conversations with unseen assistant messages (dock badge source).
    private(set) var unseenVisibleConversationCount: Int = 0

    /// True when at least one conversation exists.
    private(set) var hasAnyConversations: Bool = false

    /// True when at least one non-archived conversation exists (sidebar loading gate).
    private(set) var hasAnyVisibleConversations: Bool = false

    /// Count of unseen visible conversations in the Scheduled section.
    private(set) var unseenScheduledCount: Int = 0

    /// O(1) lookup of conversations by local UUID for per-conversation view bodies.
    private(set) var conversationsByLocalId: [UUID: ConversationModel] = [:]

    /// Archived conversations ordered most-recently-archived first; entries
    /// without a timestamp sort to the bottom with `createdAt` as the
    /// tiebreaker. Recomputed on both `conversations` and
    /// `archivedConversationTimestamps` changes.
    private(set) var archivedConversations: [ConversationModel] = []

    /// Sidebar group entries with feature-flag-aware folding (non-system groups
    /// merge into system:all when `customGroupsEnabled` is false).
    private(set) var sidebarGroupEntries: [SidebarGroupEntry] = []

    /// Partitions of `sidebarGroupEntries` for the two sidebar sections
    /// (system groups above the `YOUR GROUPS` divider, custom groups below).
    private(set) var systemSidebarGroupEntries: [SidebarGroupEntry] = []
    private(set) var customSidebarGroupEntries: [SidebarGroupEntry] = []

    /// Assign through a key path only when the new value differs from the
    /// current one. Used by every cached-property recompute so that no-op
    /// writes do not fire `@Observable` change notifications. Reference:
    /// [`withObservationTracking(_:onChange:)`](https://developer.apple.com/documentation/observation/withobservationtracking(_:onchange:)).
    private func setIfChanged<T: Equatable>(
        _ keyPath: ReferenceWritableKeyPath<ConversationListStore, T>,
        to newValue: T
    ) {
        if self[keyPath: keyPath] != newValue {
            self[keyPath: keyPath] = newValue
        }
    }

    /// Recompute all derived sidebar properties from `conversations` and
    /// `groups`. Called from `conversations.didSet` and `groups.didSet`. Skips
    /// the bucketing pipeline when `conversations` is empty (e.g. when
    /// `groups` is assigned before `conversations` during restoration).
    private func recomputeDerivedProperties() {
        let nextSortedGroups = groups.sorted { $0.sortPosition < $1.sortPosition }
        setIfChanged(\.sortedGroups, to: nextSortedGroups)

        guard !conversations.isEmpty else {
            setIfChanged(\.groupedConversations, to: [])
            setIfChanged(\.visibleConversations, to: [])
            setIfChanged(\.unseenVisibleConversationCount, to: 0)
            setIfChanged(\.hasAnyConversations, to: false)
            setIfChanged(\.hasAnyVisibleConversations, to: false)
            setIfChanged(\.unseenScheduledCount, to: 0)
            setIfChanged(\.conversationsByLocalId, to: [:])
            setIfChanged(\.sidebarGroupEntries, to: [])
            setIfChanged(\.systemSidebarGroupEntries, to: [])
            setIfChanged(\.customSidebarGroupEntries, to: [])
            recomputeArchivedConversations()
            onDerivedPropertiesRecomputed?()
            return
        }

        let positionMap = Dictionary(uniqueKeysWithValues: groups.map { ($0.id, $0.sortPosition) })
        let nextVisible = conversations
            .filter { !$0.isArchived }
            .sorted { visibleConversationSortOrder($0, $1, positionMap: positionMap) }
        setIfChanged(\.visibleConversations, to: nextVisible)

        let nextUnseenCount = conversations.count {
            !$0.isArchived && $0.hasUnseenLatestAssistantMessage
                && !$0.shouldSuppressGlobalUnreadAggregations
        }
        setIfChanged(\.unseenVisibleConversationCount, to: nextUnseenCount)

        setIfChanged(\.hasAnyConversations, to: true)
        setIfChanged(\.hasAnyVisibleConversations, to: !nextVisible.isEmpty)

        let nextScheduledUnseen = nextVisible.count {
            $0.groupId == ConversationGroup.scheduled.id && $0.hasUnseenLatestAssistantMessage
        }
        setIfChanged(\.unseenScheduledCount, to: nextScheduledUnseen)

        let nextLookup = Dictionary(
            conversations.map { ($0.id, $0) },
            uniquingKeysWith: { _, new in new }
        )
        setIfChanged(\.conversationsByLocalId, to: nextLookup)

        setIfChanged(\.groupedConversations, to: bucketByGroup(nextVisible, sortedGroups: nextSortedGroups))

        recomputeSidebarGroupEntries()
        recomputeArchivedConversations()
        onDerivedPropertiesRecomputed?()
    }

    /// Bucket `visible` into one `GroupedConversations` per known group, in
    /// the order of `sortedGroups`. Conversations whose `groupId` is nil or
    /// references an unknown group fold into the system:all bucket so they
    /// are never silently dropped from sidebar rendering.
    private func bucketByGroup(
        _ visible: [ConversationModel],
        sortedGroups: [ConversationGroup]
    ) -> [GroupedConversations] {
        let knownGroupIds = Set(groups.map(\.id))
        var buckets: [String: [ConversationModel]] = [:]
        var ungrouped: [ConversationModel] = []
        var orphaned: [ConversationModel] = []
        for conversation in visible {
            if let gid = conversation.groupId {
                if knownGroupIds.contains(gid) {
                    buckets[gid, default: []].append(conversation)
                } else {
                    orphaned.append(conversation)
                }
            } else {
                ungrouped.append(conversation)
            }
        }

        var grouped: [GroupedConversations] = []
        var didFoldIntoAll = false
        for group in sortedGroups {
            if group.id == ConversationGroup.all.id {
                grouped.append(GroupedConversations(
                    group: group,
                    conversations: (buckets[group.id] ?? []) + ungrouped + orphaned
                ))
                didFoldIntoAll = true
            } else {
                grouped.append(GroupedConversations(group: group, conversations: buckets[group.id] ?? []))
            }
        }
        // Synthesize a system:all bucket for old daemons that don't enumerate it.
        if !didFoldIntoAll && (!ungrouped.isEmpty || !orphaned.isEmpty) {
            grouped.append(GroupedConversations(group: ConversationGroup.all, conversations: ungrouped + orphaned))
        }
        return grouped
    }

    /// Recompute the cached `archivedConversations` array. Invoked from
    /// `recomputeDerivedProperties()` and from `archivedConversationTimestamps.didSet`
    /// because the sort order depends on both inputs.
    private func recomputeArchivedConversations() {
        let timestamps = archivedConversationTimestamps
        let updated = conversations
            .filter { $0.isArchived }
            .sorted { lhs, rhs in
                let lhsDate = lhs.conversationId.flatMap { timestamps[$0] } ?? .distantPast
                let rhsDate = rhs.conversationId.flatMap { timestamps[$0] } ?? .distantPast
                if lhsDate == rhsDate {
                    return lhs.createdAt > rhs.createdAt
                }
                return lhsDate > rhsDate
            }
        setIfChanged(\.archivedConversations, to: updated)
    }

    /// Derive sidebar group entries from `groupedConversations` and the current
    /// `customGroupsEnabled` flag. Called from `recomputeDerivedProperties()`
    /// and when `customGroupsEnabled` changes.
    private func recomputeSidebarGroupEntries() {
        var entries: [SidebarGroupEntry] = []
        var extraForAll: [ConversationModel] = []
        for entry in groupedConversations {
            guard let group = entry.group else { continue }
            if !group.isSystemGroup && !customGroupsEnabled {
                extraForAll.append(contentsOf: entry.conversations)
            } else {
                entries.append(SidebarGroupEntry(id: group.id, group: group, conversations: entry.conversations))
            }
        }
        if !extraForAll.isEmpty {
            if let allIndex = entries.firstIndex(where: { $0.group.id == ConversationGroup.all.id }) {
                let existing = entries[allIndex]
                entries[allIndex] = SidebarGroupEntry(
                    id: existing.id, group: existing.group,
                    conversations: existing.conversations + extraForAll
                )
            } else {
                entries.append(SidebarGroupEntry(
                    id: ConversationGroup.all.id, group: ConversationGroup.all,
                    conversations: extraForAll
                ))
            }
        }
        setIfChanged(\.sidebarGroupEntries, to: entries)

        var systemEntries: [SidebarGroupEntry] = []
        var customEntries: [SidebarGroupEntry] = []
        for entry in entries {
            if entry.group.isSystemGroup {
                systemEntries.append(entry)
            } else {
                customEntries.append(entry)
            }
        }
        setIfChanged(\.systemSidebarGroupEntries, to: systemEntries)
        setIfChanged(\.customSidebarGroupEntries, to: customEntries)
    }

    // MARK: - Sort Helpers

    /// Shared sort predicate for visible conversations: groups first (by sortPosition),
    /// then within each group by displayOrder/recency. Ungrouped last.
    func visibleConversationSortOrder(_ a: ConversationModel, _ b: ConversationModel, positionMap: [String: Double]) -> Bool {
        let aGroupPos = groupSortPosition(for: a.groupId, positionMap: positionMap)
        let bGroupPos = groupSortPosition(for: b.groupId, positionMap: positionMap)
        if aGroupPos != bGroupPos { return aGroupPos < bGroupPos }

        if a.displayOrder == nil && b.displayOrder == nil {
            return a.lastInteractedAt > b.lastInteractedAt
        }
        if a.displayOrder == nil { return true }
        if b.displayOrder == nil { return false }
        return a.displayOrder! < b.displayOrder!
    }

    private func groupSortPosition(for groupId: String?, positionMap: [String: Double]) -> Double {
        guard let groupId else { return Double.infinity }  // ungrouped sorts last (intentional)
        return positionMap[groupId] ?? Double.infinity  // orphaned -> treat as ungrouped
    }

    // MARK: - Archive Queries

    func isConversationArchived(_ conversationId: String) -> Bool {
        archivedConversationIds.contains(conversationId)
    }

    // MARK: - Conversation Model Conversion

    func conversationModel(
        from item: ConversationListResponseItem,
        localId: UUID = UUID(),
        createdAt: Date? = nil,
        isArchived: Bool? = nil
    ) -> ConversationModel {
        let isArchived = isArchived ?? (item.archivedAt != nil ? true : isConversationArchived(item.id))
        let effectiveCreatedAtMillis = item.createdAt ?? item.updatedAt
        let isPinned = item.isPinned ?? false
        // When the daemon supports groups, groupId: null means "Recents" (system:all).
        // Only fall back to source-based heuristics for old daemons that don't return
        // groupId at all.
        let groupId: String? = daemonSupportsGroups
            ? (item.groupId ?? (isPinned ? ConversationGroup.pinned.id : ConversationGroup.all.id))
            : ConversationModel.deriveGroupId(
                serverGroupId: item.groupId,
                isPinned: isPinned,
                source: item.source,
                title: item.title
            )
        let model = ConversationModel(
            id: localId,
            title: item.title,
            createdAt: createdAt ?? Date(timeIntervalSince1970: TimeInterval(effectiveCreatedAtMillis) / 1000.0),
            conversationId: item.id,
            isArchived: isArchived,
            groupId: groupId,
            displayOrder: item.displayOrder.map { Int($0) },
            lastInteractedAt: Date(timeIntervalSince1970: TimeInterval(item.lastMessageAt ?? item.updatedAt) / 1000.0),
            source: item.source,
            conversationType: item.conversationType,
            inferenceProfile: item.inferenceProfile,
            scheduleJobId: item.scheduleJobId,
            hasUnseenLatestAssistantMessage: (item.assistantAttention?.hasUnseenLatestAssistantMessage ?? false),
            latestAssistantMessageAt: item.assistantAttention?.latestAssistantMessageAt.map {
                Date(timeIntervalSince1970: TimeInterval($0) / 1000.0)
            },
            lastSeenAssistantMessageAt: item.assistantAttention?.lastSeenAssistantMessageAt.map {
                Date(timeIntervalSince1970: TimeInterval($0) / 1000.0)
            },
            forkParent: item.forkParent,
            originChannel: item.channelBinding?.sourceChannel ?? item.conversationOriginChannel
        )
        // Automated conversations (heartbeat, schedule, background/task) should never
        // show unread indicators, regardless of what the server reports.
        if model.shouldSuppressUnreadIndicator {
            var suppressed = model
            suppressed.hasUnseenLatestAssistantMessage = false
            return suppressed
        }
        return model
    }

    // MARK: - Title / Rename

    func updateConversationTitle(id: UUID, title: String) {
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        conversations[index].title = title
    }

    func updateConversationInferenceProfile(id: UUID, profile: String?) {
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        conversations[index].inferenceProfile = profile
    }

    /// Rename a conversation and send the rename to the daemon.
    /// If the conversation doesn't have a conversationId yet, the rename is queued
    /// and flushed when backfillConversationId is called.
    func renameConversation(id: UUID, title: String) {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        conversations[index].title = trimmed
        if let conversationId = conversations[index].conversationId {
            Task { await conversationListClient.renameConversation(conversationId: conversationId, name: trimmed) }
        } else {
            pendingRenames[id] = trimmed
        }
    }

    // MARK: - Recency

    func updateLastInteracted(conversationId: UUID) {
        guard let index = conversations.firstIndex(where: { $0.id == conversationId }) else { return }
        var conversation = conversations[index]
        conversation.lastInteractedAt = Date()
        if conversation.groupId == ConversationGroup.all.id {
            // Clear explicit displayOrder so Recents conversations revert to recency-based sorting.
            // Grouped conversations keep their manual ordering.
            let hadOrder = conversation.displayOrder != nil
            if hadOrder { conversation.displayOrder = nil }
            conversations[index] = conversation
            if hadOrder { sendPinChange(for: conversation) }
        } else {
            conversations[index] = conversation
        }
    }

    // MARK: - Pinning & Ordering

    func pinConversation(id: UUID) {
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        // Remember the pre-pin groupId so unpin can restore the original group.
        prePinGroupIds[id] = conversations[index].groupId
        var conversation = conversations[index]
        conversation.groupId = ConversationGroup.pinned.id
        let maxOrder = conversations
            .filter { $0.groupId == ConversationGroup.pinned.id && $0.id != id }
            .compactMap(\.displayOrder).max() ?? -1
        conversation.displayOrder = maxOrder + 1
        conversations[index] = conversation
        sendPinChange(for: conversation)
    }

    func unpinConversation(id: UUID) {
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        var conversation = conversations[index]
        // Restore the group the conversation belonged to before pinning.
        // Falls back to heuristic routing when no pre-pin groupId was recorded
        // (e.g. conversations pinned before this feature was added).
        if let stored = prePinGroupIds.removeValue(forKey: id),
           stored == nil || groups.contains(where: { $0.id == stored }) {
            // Restore the saved group only if it still exists (or was nil/ungrouped).
            // If the group was deleted while pinned, fall through to heuristics.
            conversation.groupId = stored ?? ConversationGroup.all.id
        } else if conversation.isScheduleConversation {
            conversation.groupId = ConversationGroup.scheduled.id
        } else if conversation.shouldReturnToBackgroundOnUnpin {
            conversation.groupId = ConversationGroup.background.id
        } else {
            conversation.groupId = ConversationGroup.all.id
        }
        conversation.displayOrder = nil
        conversations[index] = conversation
        sendPinChange(for: conversation)
    }

    /// Move a conversation to a specific group. When moving to a group, assigns
    /// displayOrder to place the conversation at the end of the target group.
    /// When ungrouping, clears displayOrder and bumps recency.
    func moveConversationToGroup(_ conversationId: UUID, groupId: String?) {
        guard let index = conversations.firstIndex(where: { $0.id == conversationId }) else { return }
        // Save pre-pin provenance so unpinConversation can restore the original group.
        if groupId == ConversationGroup.pinned.id {
            prePinGroupIds[conversationId] = conversations[index].groupId
        }
        var conversation = conversations[index]
        let effectiveGroupId = groupId ?? ConversationGroup.all.id
        conversation.groupId = effectiveGroupId
        if effectiveGroupId == ConversationGroup.all.id {
            // When moving to Recents (system:all), clear displayOrder and bump
            // lastInteractedAt so the conversation sorts by recency.
            conversation.displayOrder = nil
            conversation.lastInteractedAt = Date()
        } else {
            // Place at the end of the target group by assigning max + 1.
            let maxOrder = conversations
                .filter { $0.groupId == effectiveGroupId && $0.id != conversationId }
                .compactMap(\.displayOrder).max() ?? -1
            conversation.displayOrder = maxOrder + 1
        }
        conversations[index] = conversation
        sendPinChange(for: conversation)
    }

    /// Move a conversation to a new position in the visible list (for drag-and-drop reorder).
    /// Group-aware: if source and target are in different groups, the source is reassigned
    /// to the target's group. displayOrder is scoped to the TARGET GROUP only — conversations
    /// in other groups are untouched.
    @discardableResult
    func moveConversation(sourceId: UUID, targetId: UUID, insertAfterTarget: Bool? = nil) -> Bool {
        guard let sourceIdx = conversations.firstIndex(where: { $0.id == sourceId }),
              let targetIdx = conversations.firstIndex(where: { $0.id == targetId }) else { return false }
        let targetConversation = conversations[targetIdx]

        // Work on a local copy to batch all mutations into a single
        // array write, preventing SwiftUI ForEach re-entrancy crashes.
        var draft = conversations

        let sourceGroupId = draft[sourceIdx].groupId
        let targetGroupId = targetConversation.groupId

        // Cross-group drag: assign source to target's group.
        // Save pre-pin provenance so unpinConversation can restore the original group.
        if sourceGroupId != targetGroupId {
            if targetGroupId == ConversationGroup.pinned.id {
                prePinGroupIds[sourceId] = sourceGroupId
            }
            draft[sourceIdx].groupId = targetGroupId
        }

        // Reorder within TARGET GROUP only (not global — prevents corrupting other groups).
        let positionMap = Dictionary(uniqueKeysWithValues: groups.map { ($0.id, $0.sortPosition) })
        let groupMembers = draft
            .filter { $0.groupId == targetGroupId && !$0.isArchived }
            .sorted { visibleConversationSortOrder($0, $1, positionMap: positionMap) }

        // Remove source from the group member list
        var reordered = groupMembers.filter { $0.id != sourceId }

        // Find target's index in the filtered list
        let targetInReordered = reordered.firstIndex(where: { $0.id == targetId })

        // Direction-aware insertion:
        // Determine if source was visually above target (dragging down) using
        // section-local indices, not global visibleConversations indices.
        // For cross-group drags, use the caller-provided insertAfterTarget
        // (derived from the drop indicator) so the insertion position matches
        // the visual indicator the user saw.
        let draggingDown: Bool
        if let insertAfterTarget {
            draggingDown = insertAfterTarget
        } else if sourceGroupId != targetGroupId {
            // Cross-group without explicit direction: default to insert after target
            draggingDown = true
        } else {
            let sourceLocalIdx = groupMembers.firstIndex(where: { $0.id == sourceId })
            let targetLocalIdx = groupMembers.firstIndex(where: { $0.id == targetId })
            draggingDown = (sourceLocalIdx ?? 0) < (targetLocalIdx ?? 0)
        }

        let insertPos: Int
        if draggingDown {
            let targetIdx = targetInReordered ?? reordered.endIndex
            insertPos = min(targetIdx + 1, reordered.endIndex)
        } else {
            insertPos = targetInReordered ?? reordered.endIndex
        }

        if let movedConversation = groupMembers.first(where: { $0.id == sourceId }) ?? [draft[sourceIdx]].first {
            reordered.insert(movedConversation, at: insertPos)
        }

        // Assign displayOrder to ALL conversations in the target group. When a
        // user drags a conversation they are explicitly defining an ordering, so every
        // conversation in the affected group needs a concrete displayOrder. Without
        // this, dragging between recency-sorted conversations (nil displayOrder) would
        // only assign an order to the source, causing it to jump to the top of
        // the list since visibleConversations sorts non-nil displayOrder above nil.
        for (order, item) in reordered.enumerated() {
            if let idx = draft.firstIndex(where: { $0.id == item.id }) {
                draft[idx].displayOrder = order
            }
        }

        // Single write — triggers one observation notification.
        conversations = draft
        sendReorderConversations()
        return true
    }

    /// Send a single-conversation pin/group/order change delta. Used by
    /// `pinConversation`, `unpinConversation`, `moveConversationToGroup`, and
    /// the recency-clear path instead of the full-list `sendReorderConversations()`.
    ///
    /// The full-list endpoint submits every visible conversation's state from
    /// this client's local cache, so if our view is stale (e.g. another device
    /// changed pin state and we haven't synced yet), the POST clobbers the
    /// other device's changes. Sending only the single conversation whose
    /// state actually changed makes concurrent edits on different devices
    /// naturally safe — each client's POST touches only what it toggled.
    func sendPinChange(for conversation: ConversationModel) {
        guard let conversationId = conversation.conversationId else { return }
        let update = ReorderConversationsRequestUpdate(
            conversationId: conversationId,
            displayOrder: conversation.displayOrder.map { Double($0) },
            isPinned: conversation.isPinned,
            groupId: conversation.groupId
        )
        Task { @MainActor [weak self] in
            guard let self else { return }
            let success = await self.conversationListClient.reorderConversations(updates: [update])
            if !success {
                log.error("Failed to send pin change for conversation \(conversationId)")
            }
        }
    }

    /// Send the current conversation ordering to the daemon so it persists across restarts.
    /// Includes groupId in the payload so the server can track group membership.
    /// Debounced: rapid successive calls (e.g. during drag) are coalesced into a single
    /// API call after 300ms of inactivity.
    func sendReorderConversations() {
        reorderDebounceTask?.cancel()
        reorderDebounceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled, let self else { return }

            let visible = self.visibleConversations.filter { !$0.isChannelConversation }
            var updates: [ReorderConversationsRequestUpdate] = []
            for conversation in visible {
                guard let conversationId = conversation.conversationId else { continue }
                let order: Double?
                order = conversation.displayOrder.map { Double($0) }
                updates.append(ReorderConversationsRequestUpdate(
                    conversationId: conversationId,
                    displayOrder: order,
                    isPinned: conversation.isPinned,
                    groupId: conversation.groupId
                ))
            }
            guard !updates.isEmpty else { return }
            let success = await self.conversationListClient.reorderConversations(updates: updates)
            if !success {
                log.error("Failed to send reorder_conversations")
            }
        }
    }

    // MARK: - Group CRUD

    func createGroup(name: String) async -> ConversationGroup? {
        // sort_position is server-authoritative: server assigns max(custom sort_position) + 1.
        // Client just sends name; server returns the group with its assigned sort_position.
        guard let response = await groupClient.createGroup(name: name) else { return nil }
        let group = ConversationGroup(from: response)
        groups.append(group)
        return group
    }

    func renameGroup(_ groupId: String, name: String) async {
        guard let idx = groups.firstIndex(where: { $0.id == groupId }) else { return }
        groups[idx].name = name
        _ = await groupClient.updateGroup(groupId: groupId, name: name, sortPosition: nil)
    }

    func deleteGroup(_ groupId: String) async {
        guard let idx = groups.firstIndex(where: { $0.id == groupId }),
              !groups[idx].isSystemGroup else { return }
        // Batch-mutate a copy to avoid per-element SwiftUI re-renders
        var updated = conversations
        for i in updated.indices where updated[i].groupId == groupId {
            updated[i].groupId = ConversationGroup.all.id
            updated[i].displayOrder = nil
        }
        conversations = updated
        groups.remove(at: idx)
        _ = await groupClient.deleteGroup(groupId: groupId)
        sendReorderConversations()
    }

    /// Delete a group on the server without modifying local state.
    /// Used by cross-cutting orchestration that handles local mutations separately.
    func deleteGroupOnServer(_ groupId: String) async {
        _ = await groupClient.deleteGroup(groupId: groupId)
    }

    func reorderGroups(_ updates: [(groupId: String, sortPosition: Double)]) async {
        for update in updates {
            if let idx = groups.firstIndex(where: { $0.id == update.groupId }) {
                groups[idx].sortPosition = update.sortPosition
            }
        }
        _ = await groupClient.reorderGroups(updates: updates)
    }

    /// Replace local groups with the server response (authoritative).
    /// Groups deleted on another client are pruned; new groups are added.
    /// Only falls back to system defaults when server returns no groups at all.
    func mergeGroups(from responseGroups: [ConversationGroupResponse]) {
        if responseGroups.isEmpty {
            // Old daemon or empty response — keep existing groups (or system defaults)
            return
        }
        daemonSupportsGroups = true
        groups = responseGroups.map { ConversationGroup(from: $0) }
    }

    // MARK: - Pagination

    /// Load more conversations from the daemon (pagination).
    func loadMoreConversations() {
        guard !isLoadingMoreConversations else { return }
        isLoadingMoreConversations = true
        Task { [weak self] in
            guard let self else { return }
            if let response = await conversationListClient.fetchConversationList(offset: serverOffset, limit: 50, conversationType: nil) {
                self.appendConversations(from: response)
            } else {
                self.isLoadingMoreConversations = false
            }
        }
    }

    /// Load all remaining conversations from the daemon in a loop until none remain.
    func loadAllRemainingConversations() {
        guard !isLoadingMoreConversations, hasMoreConversations else { return }
        isLoadingMoreConversations = true
        Task { [weak self] in
            guard let self else { return }
            while self.hasMoreConversations {
                let response = await self.conversationListClient.fetchConversationList(
                    offset: self.serverOffset, limit: 200, conversationType: nil
                )
                guard let response else { break }
                self.appendConversations(from: response)
                self.isLoadingMoreConversations = true
            }
            self.isLoadingMoreConversations = false
        }
    }

    /// Callback invoked after derived properties are recomputed (i.e. on every
    /// `conversations` or `groups` mutation) so the selection store can refresh
    /// its cached active conversation. Wired by ConversationManager during init.
    @ObservationIgnored var onDerivedPropertiesRecomputed: (() -> Void)?

    /// Callback invoked after conversations are appended, so the manager
    /// can schedule VM eviction. Wired by ConversationManager during init.
    @ObservationIgnored var onConversationsAppended: (() -> Void)?

    /// Returns whether a given conversation has a live assistant activity snapshot.
    /// Wired by ConversationManager so the list store can check activity state
    /// without owning the Combine subscriptions directly.
    @ObservationIgnored var hasAssistantActivitySnapshot: ((UUID) -> Bool)?

    /// Handle appended conversations from a "load more" response.
    func appendConversations(from response: ConversationListResponseMessage) {
        // Use the server-provided nextOffset (DB-level pagination) so injected
        // pinned conversations don't inflate the offset and skip rows.
        if let nextOffset = response.nextOffset {
            serverOffset = nextOffset
        } else {
            serverOffset += response.conversations.count
        }

        // Merge groups if provided (first page only from server).
        if let responseGroups = response.groups, !responseGroups.isEmpty {
            mergeGroups(from: responseGroups)
        }

        for conversation in response.conversations {
            // If a local conversation already exists, merge server pin/order metadata.
            if let existingIdx = conversations.firstIndex(where: { $0.conversationId == conversation.id }) {
                conversations[existingIdx] = conversationModel(
                    from: conversation,
                    localId: conversations[existingIdx].id,
                    createdAt: conversations[existingIdx].createdAt,
                    isArchived: conversations[existingIdx].isArchived
                )
                mergeAssistantAttention(from: conversation, intoConversationAt: existingIdx)
                continue
            }

            let conversationModel = conversationModel(
                from: conversation
            )
            // VM creation is lazy — getOrCreateViewModel() will instantiate
            // when the conversation is first accessed (e.g. selected by the user).
            conversations.append(conversationModel)
        }

        if let hasMore = response.hasMore {
            hasMoreConversations = hasMore
        }
        onConversationsAppended?()
        isLoadingMoreConversations = false
    }

    // MARK: - Seen / Unseen State

    /// Clear the local unseen flag and notify the daemon that the conversation
    /// has been seen.
    func markConversationSeen(conversationId localId: UUID) {
        guard let idx = conversations.firstIndex(where: { $0.id == localId }) else { return }
        // If the conversation has a pending .unread override, opening it clears it
        // so the normal seen flow proceeds rather than leaving it stuck as unread.
        if let daemonId = conversations[idx].conversationId,
           case .unread = pendingAttentionOverrides[daemonId] {
            pendingAttentionOverrides.removeValue(forKey: daemonId)
        }
        var conversation = conversations[idx]
        conversation.hasUnseenLatestAssistantMessage = false
        if let daemonId = conversation.conversationId {
            pendingAttentionOverrides[daemonId] = .seen(
                latestAssistantMessageAt: conversation.latestAssistantMessageAt
            )
            conversation.lastSeenAssistantMessageAt = conversation.latestAssistantMessageAt
            conversations[idx] = conversation
            emitConversationSeenSignal(conversationId: daemonId)
        } else {
            conversations[idx] = conversation
        }
    }

    func markConversationUnread(conversationId localId: UUID) {
        guard let idx = conversations.firstIndex(where: { $0.id == localId }),
              let daemonConversationId = conversations[idx].conversationId,
              canMarkConversationUnread(conversationId: localId, at: idx) else { return }

        let latestAssistantMessageAt = conversations[idx].latestAssistantMessageAt

        let previousLastSeenAssistantMessageAt = conversations[idx].lastSeenAssistantMessageAt
        let previousOverride = pendingAttentionOverrides[daemonConversationId]
        let wasPendingSeen = pendingSeenConversationIds.contains(daemonConversationId)

        pendingSeenConversationIds.removeAll { $0 == daemonConversationId }
        pendingAttentionOverrides[daemonConversationId] = .unread(
            latestAssistantMessageAt: latestAssistantMessageAt
        )
        var conversation = conversations[idx]
        conversation.hasUnseenLatestAssistantMessage = true
        conversation.lastSeenAssistantMessageAt = nil
        conversations[idx] = conversation
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await self.emitConversationUnreadSignal(conversationId: daemonConversationId)
            } catch {
                self.rollbackUnreadMutationIfNeeded(
                    localId: localId,
                    daemonConversationId: daemonConversationId,
                    latestAssistantMessageAt: latestAssistantMessageAt,
                    previousLastSeenAssistantMessageAt: previousLastSeenAssistantMessageAt,
                    previousOverride: previousOverride,
                    wasPendingSeen: wasPendingSeen
                )
                log.warning("Failed to send conversation_unread_signal for \(daemonConversationId): \(error.localizedDescription)")
            }
        }
    }

    /// Mark all visible, non-archived conversations as seen locally.
    /// Seen signals are NOT sent immediately — call `commitPendingSeenSignals()`
    /// after the undo window expires, or `cancelPendingSeenSignals()` if the
    /// user clicks Undo. Returns the IDs of conversations that were actually marked.
    @discardableResult
    func markAllConversationsSeen() -> [UUID] {
        markConversationsSeenImpl { _ in true }
    }

    /// Mark the specified conversations as seen locally.
    /// Same deferred-signal + undo semantics as `markAllConversationsSeen()`.
    @discardableResult
    func markConversationsSeen(in localIds: Set<UUID>) -> [UUID] {
        markConversationsSeenImpl { localIds.contains($0.id) }
    }

    /// Shared implementation for bulk mark-as-seen operations.
    /// `additionalFilter` narrows which conversations are marked beyond the
    /// standard non-archived, has-unseen guards.
    private func markConversationsSeenImpl(
        where additionalFilter: (ConversationModel) -> Bool
    ) -> [UUID] {
        // Commit (not cancel) any already-pending signals so a second
        // mark-all invocation doesn't silently drop the first batch.
        commitPendingSeenSignals()
        var markedIds: [UUID] = []
        var conversationIds: [String] = []
        var priorStates: [UUID: MarkAllSeenPriorState] = [:]
        // Mutate a local copy to avoid N × didSet → recomputeDerivedProperties
        // calls when marking many conversations at once.
        var snapshot = conversations
        for idx in snapshot.indices {
            guard !snapshot[idx].isArchived,
                  snapshot[idx].hasUnseenLatestAssistantMessage,
                  additionalFilter(snapshot[idx]) else { continue }
            let localId = snapshot[idx].id
            let conversationId = snapshot[idx].conversationId
            priorStates[localId] = MarkAllSeenPriorState(
                lastSeenAssistantMessageAt: snapshot[idx].lastSeenAssistantMessageAt,
                conversationId: conversationId,
                override: conversationId.flatMap { pendingAttentionOverrides[$0] }
            )
            snapshot[idx].hasUnseenLatestAssistantMessage = false
            markedIds.append(localId)
            if let conversationId {
                conversationIds.append(conversationId)
                pendingAttentionOverrides[conversationId] = .seen(
                    latestAssistantMessageAt: snapshot[idx].latestAssistantMessageAt
                )
                snapshot[idx].lastSeenAssistantMessageAt = snapshot[idx].latestAssistantMessageAt
            }
        }
        conversations = snapshot
        markAllSeenPriorStates = priorStates
        if !conversationIds.isEmpty {
            pendingSeenConversationIds = conversationIds
        }
        return markedIds
    }

    /// Send the deferred seen signals that were collected by
    /// `markAllConversationsSeen()`. Called when the undo window expires
    /// (toast dismissed or auto-dismiss timer fires).
    func commitPendingSeenSignals() {
        let conversationIds = pendingSeenConversationIds
        pendingSeenConversationIds = []
        markAllSeenPriorStates = [:]
        pendingSeenSignalTask?.cancel()
        pendingSeenSignalTask = nil
        for conversationId in conversationIds {
            emitConversationSeenSignal(conversationId: conversationId)
        }
    }

    /// Cancel any pending seen signals (user clicked Undo).
    func cancelPendingSeenSignals() {
        pendingSeenConversationIds = []
        pendingSeenSignalTask?.cancel()
        pendingSeenSignalTask = nil
    }

    /// Schedule deferred seen signals to fire after a delay.
    /// If the user clicks Undo before the delay, call
    /// `cancelPendingSeenSignals()` to prevent them from sending.
    /// The optional `onCommit` closure is called after the signals are sent,
    /// allowing callers to dismiss the undo toast when the window expires.
    func schedulePendingSeenSignals(delay: TimeInterval = 5.0, onCommit: (() -> Void)? = nil) {
        pendingSeenSignalTask?.cancel()
        pendingSeenSignalTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.commitPendingSeenSignals()
            onCommit?()
        }
    }

    /// Restore the unseen flag for the given conversation IDs and cancel any
    /// pending seen signals (used by undo). Restores prior
    /// `lastSeenAssistantMessageAt` and `pendingAttentionOverrides`
    /// values captured by `markAllConversationsSeen()` instead of blindly
    /// clearing them.
    func restoreUnseen(conversationIds: [UUID]) {
        cancelPendingSeenSignals()
        let priorStates = markAllSeenPriorStates
        markAllSeenPriorStates = [:]
        // Mutate a local copy to avoid N × didSet → recomputeDerivedProperties.
        var snapshot = conversations
        for id in conversationIds {
            if let idx = snapshot.firstIndex(where: { $0.id == id }) {
                guard !snapshot[idx].shouldSuppressUnreadIndicator else { continue }
                snapshot[idx].hasUnseenLatestAssistantMessage = true
                if let prior = priorStates[id] {
                    snapshot[idx].lastSeenAssistantMessageAt = prior.lastSeenAssistantMessageAt
                    if let conversationId = prior.conversationId {
                        // Only restore the override if the current override is
                        // still the .seen that markAllConversationsSeen() installed.
                        // If the user changed it (e.g. marked unread during
                        // the undo window), keep the newer override.
                        if let currentOverride = pendingAttentionOverrides[conversationId],
                           case .seen = currentOverride {
                            if let previousOverride = prior.override {
                                pendingAttentionOverrides[conversationId] = previousOverride
                            } else {
                                pendingAttentionOverrides.removeValue(forKey: conversationId)
                            }
                        }
                    }
                } else {
                    // Fallback: no prior state captured (shouldn't happen in
                    // normal flow), clear conservatively.
                    snapshot[idx].lastSeenAssistantMessageAt = nil
                    if let conversationId = snapshot[idx].conversationId {
                        pendingAttentionOverrides.removeValue(forKey: conversationId)
                    }
                }
            }
        }
        conversations = snapshot
    }

    // MARK: - Attention Merge

    func mergeAssistantAttention(
        from item: ConversationListResponseItem,
        intoConversationAt index: Int
    ) {
        // Copy-modify-writeback: mutate a local copy and write back once to
        // trigger a single conversations.didSet (and one recomputeDerivedProperties)
        // instead of one per field assignment.
        var conversation = conversations[index]
        let serverUnseen = item.assistantAttention?.hasUnseenLatestAssistantMessage ?? false
        conversation.hasUnseenLatestAssistantMessage =
            conversation.shouldSuppressUnreadIndicator ? false : serverUnseen
        conversation.latestAssistantMessageAt =
            item.assistantAttention?.latestAssistantMessageAt.map {
                Date(timeIntervalSince1970: TimeInterval($0) / 1000.0)
            }
        conversation.lastSeenAssistantMessageAt =
            item.assistantAttention?.lastSeenAssistantMessageAt.map {
                Date(timeIntervalSince1970: TimeInterval($0) / 1000.0)
            }

        if let conversationId = conversation.conversationId,
           let override = pendingAttentionOverrides[conversationId] {

            switch override {
            case .seen(let targetLatestAssistantMessageAt):
                if !conversation.hasUnseenLatestAssistantMessage {
                    pendingAttentionOverrides.removeValue(forKey: conversationId)
                } else if targetLatestAssistantMessageAt == nil {
                    // When target is nil (e.g. notification-created conversation before history loads),
                    // drop the override if the server reports unseen — the server has newer info.
                    pendingAttentionOverrides.removeValue(forKey: conversationId)
                } else if let targetLatestAssistantMessageAt,
                          let serverLatestAssistantMessageAt = conversation.latestAssistantMessageAt,
                          serverLatestAssistantMessageAt > targetLatestAssistantMessageAt {
                    pendingAttentionOverrides.removeValue(forKey: conversationId)
                } else {
                    if let targetLatestAssistantMessageAt,
                       conversation.latestAssistantMessageAt == nil {
                        conversation.latestAssistantMessageAt = targetLatestAssistantMessageAt
                    }
                    conversation.hasUnseenLatestAssistantMessage = false
                    conversation.lastSeenAssistantMessageAt =
                        conversation.latestAssistantMessageAt
                }

            case .unread(let targetLatestAssistantMessageAt):
                if conversation.hasUnseenLatestAssistantMessage {
                    pendingAttentionOverrides.removeValue(forKey: conversationId)
                } else if let targetLatestAssistantMessageAt,
                          let serverLatestAssistantMessageAt = conversation.latestAssistantMessageAt,
                          serverLatestAssistantMessageAt > targetLatestAssistantMessageAt {
                    pendingAttentionOverrides.removeValue(forKey: conversationId)
                } else {
                    if let targetLatestAssistantMessageAt,
                       conversation.latestAssistantMessageAt == nil {
                        conversation.latestAssistantMessageAt = targetLatestAssistantMessageAt
                    }
                    conversation.hasUnseenLatestAssistantMessage = true
                    conversation.lastSeenAssistantMessageAt = nil
                }
            }
        }

        conversations[index] = conversation
    }

    // MARK: - Signal Emission

    /// Send a `conversation_seen_signal` message to the daemon.
    func emitConversationSeenSignal(conversationId: String) {
        let signal = ConversationSeenSignal(
            conversationId: conversationId,
            sourceChannel: "vellum",
            signalType: "macos_conversation_opened",
            confidence: "explicit",
            source: "ui-navigation",
            evidenceText: "User opened conversation in app"
        )
        Task {
            let success = await conversationListClient.sendConversationSeen(signal)
            if !success {
                log.warning("Failed to send conversation_seen_signal for \(conversationId)")
            }
        }
    }

    private func emitConversationUnreadSignal(conversationId: String) async throws {
        let signal = ConversationUnreadSignal(
            conversationId: conversationId,
            sourceChannel: "vellum",
            signalType: "macos_conversation_opened",
            confidence: "explicit",
            source: "ui-navigation",
            evidenceText: "User selected Mark as unread"
        )
        try await conversationUnreadClient.sendConversationUnread(signal)
    }

    func rollbackUnreadMutationIfNeeded(
        localId: UUID,
        daemonConversationId: String,
        latestAssistantMessageAt: Date?,
        previousLastSeenAssistantMessageAt: Date?,
        previousOverride: PendingAttentionOverride?,
        wasPendingSeen: Bool = false
    ) {
        guard let idx = conversations.firstIndex(where: { $0.id == localId }),
              conversations[idx].conversationId == daemonConversationId,
              case .unread(let pendingLatestAssistantMessageAt) = pendingAttentionOverrides[daemonConversationId],
              pendingLatestAssistantMessageAt == latestAssistantMessageAt else { return }

        if let previousOverride {
            pendingAttentionOverrides[daemonConversationId] = previousOverride
        } else {
            pendingAttentionOverrides.removeValue(forKey: daemonConversationId)
        }
        // Copy-modify-writeback to trigger a single didSet.
        var conversation = conversations[idx]
        conversation.hasUnseenLatestAssistantMessage = false
        conversation.lastSeenAssistantMessageAt = previousLastSeenAssistantMessageAt
        conversations[idx] = conversation

        if wasPendingSeen && !pendingSeenConversationIds.contains(daemonConversationId) {
            pendingSeenConversationIds.append(daemonConversationId)
            if pendingSeenSignalTask == nil {
                schedulePendingSeenSignals()
            }
        }
    }

    func canMarkConversationUnread(conversationId: UUID, at conversationIndex: Int) -> Bool {
        guard conversations[conversationIndex].conversationId != nil,
              !conversations[conversationIndex].hasUnseenLatestAssistantMessage,
              !conversations[conversationIndex].shouldSuppressUnreadIndicator else { return false }
        // Live assistant replies update the in-memory activity snapshot before
        // conversation-list hydration backfills latestAssistantMessageAt.
        return conversations[conversationIndex].latestAssistantMessageAt != nil
            || (hasAssistantActivitySnapshot?(conversationId) ?? false)
    }
}
