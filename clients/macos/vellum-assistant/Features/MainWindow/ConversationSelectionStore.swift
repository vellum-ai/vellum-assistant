import SwiftUI
import VellumAssistantShared
import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ConversationSelectionStore")
private let stallLog = OSLog(subsystem: Bundle.appBundleIdentifier, category: "LayoutStall")

/// Owns the active conversation selection, draft mode, ChatViewModel LRU
/// cache, and pop-out window pinning.
///
/// Separated from `ConversationManager` so that views reading only selection
/// state (chat area, toolbar) are isolated from list mutations (sidebar rows,
/// pagination), leveraging `@Observable` property-level tracking.
///
/// Reference: [Managing model data in your app](https://developer.apple.com/documentation/swiftui/managing-model-data-in-your-app)
@Observable
@MainActor
final class ConversationSelectionStore {

    // MARK: - Dependencies

    /// Reference to the list store for reading conversation data.
    let listStore: ConversationListStore

    // MARK: - Selection State

    /// The currently active conversation's local ID.
    ///
    /// The `didSet` performs only lightweight bookkeeping (UserDefaults persistence,
    /// stale anchor clearing). Heavy side effects live in ``performActivation(for:)``
    /// and ``performDeactivation()`` — callers must invoke those explicitly.
    private(set) var activeConversationId: UUID? {
        didSet {
            // Persist selection (skip during restoration to avoid overwriting the
            // saved value before restoreLastActiveConversation reads it).
            if !isRestoringConversations {
                lastActiveConversationIdString = activeConversationId?.uuidString
            }
            // Clear stale anchor when switching away from the conversation that
            // owns it — prevents the anchor from suppressing scroll-to-bottom
            // on unrelated conversation switches.
            if let anchorConversation = pendingAnchorConversationId, anchorConversation != activeConversationId {
                pendingAnchorMessageId = nil
                pendingAnchorConversationId = nil
            }
        }
    }

    /// Activate a conversation: set ``activeConversationId``, create/retrieve the VM,
    /// start the message loop, notify the daemon, and set up observation.
    ///
    /// Canonical entry point for switching to a conversation. Use
    /// ``performDeactivation()`` to clear the selection instead.
    func performActivation(for conversationId: UUID) {
        guard conversationId != activeConversationId else { return }
        // Switching to a real conversation discards any draft.
        draftViewModel = nil
        activeConversationId = conversationId

        let vm = getOrCreateViewModel(for: conversationId)
        vm?.ensureMessageLoopStarted()
        onActiveConversationChanged?(conversationId)

        // Notify the daemon so it rebinds the socket to this conversation.
        if let serverConversationId = vm?.conversationId {
            Task {
                let success = await listStore.conversationListClient.switchConversation(conversationId: serverConversationId)
                if !success {
                    log.error("Failed to send conversation switch request")
                }
            }
        }

        // Observe the new active view model's message count via the @Observable store.
        onActiveViewModelChanged?(activeViewModel?.messageManager)

        // Manage periodic refresh polling for channel conversations.
        startChannelRefreshIfNeeded(conversationId: conversationId)
    }

    /// Deactivate selection (e.g. entering draft mode): clear `activeConversationId`,
    /// stop channel refresh, and notify observation.
    func performDeactivation() {
        activeConversationId = nil
        onActiveViewModelChanged?(nil)
        stopChannelRefresh()
    }

    // MARK: - Draft Mode

    var draftViewModel: ChatViewModel?

    // MARK: - Anchor / Highlight

    /// Pending anchor message ID for scroll-to behavior on notification deep links.
    var pendingAnchorMessageId: UUID?

    /// Message ID to visually highlight after an anchor scroll completes.
    var highlightedMessageId: UUID?

    /// Tracks which conversation the pending anchor belongs to so stale anchors are
    /// cleared automatically when the user switches to a different conversation.
    @ObservationIgnored var pendingAnchorConversationId: UUID?

    // MARK: - VM Cache

    @ObservationIgnored var chatViewModels: [UUID: ChatViewModel] = [:]

    /// Maximum number of ChatViewModels to keep in memory. When this limit is
    /// exceeded, the least-recently-accessed VM (that isn't the active conversation) is
    /// evicted. This prevents unbounded memory growth from accumulated conversations.
    private let maxCachedViewModels = 10

    /// Tracks access order for LRU eviction. Most-recently-accessed ID is at the end.
    @ObservationIgnored var vmAccessOrder: [UUID] = []

    deinit {
        pendingEvictionTask?.cancel()
        channelRefreshTask?.cancel()
    }

    @ObservationIgnored private var pendingEvictionTask: Task<Void, Never>?

    /// Conversation local IDs whose ViewModels are pinned by open pop-out windows.
    /// Pinned VMs are exempt from LRU eviction.
    @ObservationIgnored var pinnedViewModelIds: Set<UUID> = []

    // MARK: - Restoration State

    /// Flag to suppress lastActiveConversationIdString writes during initialization and conversation restoration.
    @ObservationIgnored var isRestoringConversations = false

    private(set) var restoreRecentConversations: Bool {
        get { UserDefaults.standard.object(forKey: "restoreRecentConversations") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "restoreRecentConversations") }
    }

    @ObservationIgnored var lastActiveConversationIdString: String? {
        get { UserDefaults.standard.string(forKey: "lastActiveConversationId") }
        set { UserDefaults.standard.set(newValue, forKey: "lastActiveConversationId") }
    }

    @ObservationIgnored var completedConversationCount: Int {
        get { UserDefaults.standard.integer(forKey: "completedConversationCount") }
        set { UserDefaults.standard.set(newValue, forKey: "completedConversationCount") }
    }

    // MARK: - Channel Refresh

    /// Periodic task that refreshes the active channel conversation's history.
    @ObservationIgnored private var channelRefreshTask: Task<Void, Never>?

    // MARK: - Callbacks

    /// Called when activeConversationId changes to a non-nil value.
    /// Wired by ConversationManager to trigger history loading via ConversationRestorer.
    @ObservationIgnored var onActiveConversationChanged: ((UUID) -> Void)?

    /// Called when the active view model changes (including to nil for draft mode).
    /// Wired by ConversationManager to update activityStore observation.
    @ObservationIgnored var onActiveViewModelChanged: ((ChatMessageManager?) -> Void)?

    /// Factory closure for creating new ChatViewModels.
    /// Wired by ConversationManager since VM creation requires app-layer callbacks.
    @ObservationIgnored var viewModelFactory: (() -> ChatViewModel?)?

    /// Called after a new VM is registered in the cache (created or set externally).
    /// Wired by ConversationManager to set up activity and assistant-activity subscriptions.
    @ObservationIgnored var onViewModelRegistered: ((UUID, ChatViewModel) -> Void)?

    /// Called when a VM is removed from the cache.
    /// Wired by ConversationManager to clean up subscriptions.
    @ObservationIgnored var onViewModelRemoved: ((UUID) -> Void)?

    /// Called when a VM is evicted via LRU (lighter cleanup than full removal).
    /// Wired by ConversationManager to unsubscribe busy state without clearing interaction states.
    @ObservationIgnored var onViewModelEvicted: ((UUID) -> Void)?

    /// Called when channel refresh needs to request reconnect history.
    @ObservationIgnored var onChannelRefreshNeeded: ((UUID, String) -> Void)?


    // MARK: - Init

    init(listStore: ConversationListStore) {
        self.listStore = listStore
        migrateStorageKeysIfNeeded()
    }

    // MARK: - Computed Properties

    /// The active conversation model, if one is selected and exists in the list.
    var activeConversation: ConversationModel? {
        guard let activeConversationId else { return nil }
        return listStore.conversations.first { $0.id == activeConversationId }
    }

    /// The ChatViewModel for the active conversation, or the draft ViewModel
    /// when no conversation is selected.
    var activeViewModel: ChatViewModel? {
        if activeConversationId == nil, let draftViewModel { return draftViewModel }
        guard let activeConversationId else { return nil }
        return chatViewModels[activeConversationId]
    }

    // MARK: - Storage Migration

    private func migrateStorageKeysIfNeeded() {
        // Rename old "session"-based keys to "conversation"-based keys.
        let ud = UserDefaults.standard
        if ud.string(forKey: "lastActiveConversationId") == nil,
           let old = ud.string(forKey: "lastActiveSessionId") {
            ud.set(old, forKey: "lastActiveConversationId")
            ud.removeObject(forKey: "lastActiveSessionId")
        }
        if ud.object(forKey: "restoreRecentConversations") == nil,
           ud.object(forKey: "restoreRecentSessions") != nil {
            ud.set(ud.bool(forKey: "restoreRecentSessions"), forKey: "restoreRecentConversations")
            ud.removeObject(forKey: "restoreRecentSessions")
        }
    }

    // MARK: - Lazy VM Creation

    /// Returns an existing ChatViewModel or lazily creates one for the given conversation.
    /// This is the single entry point for VM access — `appendConversations` and conversation
    /// restoration no longer eagerly create VMs for every loaded conversation.
    @discardableResult
    func getOrCreateViewModel(for conversationId: UUID) -> ChatViewModel? {
        if let vm = chatViewModels[conversationId] {
            touchVMAccessOrder(conversationId)
            return vm
        }
        // Only create if the conversation exists
        guard let conversation = listStore.conversations.first(where: { $0.id == conversationId }) else { return nil }
        guard let viewModel = viewModelFactory?() else { return nil }
        viewModel.conversationId = conversation.conversationId
        if conversation.conversationId == nil {
            viewModel.isHistoryLoaded = true
        }
        chatViewModels[conversationId] = viewModel
        onViewModelRegistered?(conversationId, viewModel)
        touchVMAccessOrder(conversationId)
        scheduleEvictionIfNeeded()
        return viewModel
    }

    // MARK: - VM LRU Cache Management

    /// Move `conversationId` to the end of `vmAccessOrder` (most-recently-used position).
    func touchVMAccessOrder(_ conversationId: UUID) {
        if let idx = vmAccessOrder.firstIndex(of: conversationId) {
            vmAccessOrder.remove(at: idx)
        }
        vmAccessOrder.append(conversationId)
    }

    /// Schedule a debounced eviction pass. Coalesces multiple eviction triggers
    /// into a single deferred call.
    func scheduleEvictionIfNeeded() {
        guard chatViewModels.count > maxCachedViewModels else { return }
        guard pendingEvictionTask == nil else { return }
        pendingEvictionTask = Task { @MainActor [weak self] in
            defer { self?.pendingEvictionTask = nil }
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled else { return }
            self?.evictStaleCachedViewModels()
        }
    }

    /// Evict the oldest cached ChatViewModel that is not the active conversation,
    /// keeping at most `maxCachedViewModels` entries in the dictionary.
    private func evictStaleCachedViewModels() {
        var evictedCount = 0
        while chatViewModels.count > maxCachedViewModels {
            // Find the oldest non-active, non-busy VM so we never cancel an in-flight response.
            guard let victim = vmAccessOrder.first(where: {
                guard $0 != activeConversationId,
                      !pinnedViewModelIds.contains($0),
                      let vm = chatViewModels[$0] else { return false }
                return !vm.isSending && !vm.isThinking && vm.pendingQueuedCount == 0
            }) else {
                break
            }
            chatViewModels.removeValue(forKey: victim)
            onViewModelEvicted?(victim)
            if let idx = vmAccessOrder.firstIndex(of: victim) {
                vmAccessOrder.remove(at: idx)
            }
            evictedCount += 1
            log.info("LRU evicted VM for conversation \(victim)")
        }
        if evictedCount > 0 {
            os_signpost(.event, log: stallLog, name: "LRU.evict", "%{public}d VMs", evictedCount)
        }
    }

    // MARK: - Pop-Out Window Pinning

    /// Pin a ViewModel so it is exempt from LRU eviction.
    func pinViewModel(_ conversationLocalId: UUID) {
        pinnedViewModelIds.insert(conversationLocalId)
        log.info("Pinned VM \(conversationLocalId), \(self.pinnedViewModelIds.count) pinned")
    }

    /// Unpin a ViewModel, allowing LRU eviction again.
    func unpinViewModel(_ conversationLocalId: UUID) {
        pinnedViewModelIds.remove(conversationLocalId)
        log.info("Unpinned VM \(conversationLocalId), \(self.pinnedViewModelIds.count) pinned")
        scheduleEvictionIfNeeded()
    }

    /// Returns an existing or newly-created ViewModel for a detached pop-out window.
    func viewModelForDetachedWindow(conversationLocalId: UUID) -> ChatViewModel? {
        let vm = getOrCreateViewModel(for: conversationLocalId)
        vm?.ensureMessageLoopStarted()
        return vm
    }

    // MARK: - ConversationRestorerDelegate VM Methods

    func chatViewModel(for conversationId: UUID) -> ChatViewModel? {
        getOrCreateViewModel(for: conversationId)
    }

    func existingChatViewModel(for conversationId: UUID) -> ChatViewModel? {
        guard let vm = chatViewModels[conversationId] else { return nil }
        touchVMAccessOrder(conversationId)
        return vm
    }

    func existingChatViewModel(forConversationId conversationId: String) -> ChatViewModel? {
        for (localId, vm) in chatViewModels where vm.conversationId == conversationId {
            touchVMAccessOrder(localId)
            return vm
        }
        return nil
    }

    func setChatViewModel(_ vm: ChatViewModel, for conversationId: UUID) {
        chatViewModels[conversationId] = vm
        onViewModelRegistered?(conversationId, vm)
        touchVMAccessOrder(conversationId)
        scheduleEvictionIfNeeded()
        if conversationId == activeConversationId {
            onActiveViewModelChanged?(vm.messageManager)
        }
    }

    func removeChatViewModel(for conversationId: UUID) {
        chatViewModels.removeValue(forKey: conversationId)
        onViewModelRemoved?(conversationId)
        if let idx = vmAccessOrder.firstIndex(of: conversationId) {
            vmAccessOrder.remove(at: idx)
        }
    }

    // MARK: - Restoration

    /// Restore the last active conversation from UserDefaults after conversation restoration completes.
    ///
    /// If `handleConversationListResponse` already activated the correct conversation,
    /// this is a no-op — `activeConversationId` already matches the saved UUID.
    func restoreLastActiveConversation() {
        defer { onRestorationComplete?() }

        guard restoreRecentConversations else {
            isRestoringConversations = false
            return
        }
        guard let savedUUIDString = lastActiveConversationIdString,
              let savedUUID = UUID(uuidString: savedUUIDString) else {
            isRestoringConversations = false
            return
        }

        // Only restore if conversation exists and is visible (not archived).
        // Skip when already active to avoid redundant activation side effects.
        if listStore.conversations.contains(where: { $0.id == savedUUID && !$0.isArchived }) {
            if activeConversationId != savedUUID {
                performActivation(for: savedUUID)
                log.info("Restored last active conversation: \(savedUUID)")
            } else {
                log.info("Last active conversation \(savedUUID) already active, skipping")
            }
        } else {
            lastActiveConversationIdString = nil
            log.info("Saved conversation not found, falling back to default")
        }

        isRestoringConversations = false
    }

    /// Called after restoration completes.
    /// Wired by ConversationManager to run markActiveConversationSeenIfNeeded.
    @ObservationIgnored var onRestorationComplete: (() -> Void)?

    // MARK: - Trim & Cleanup

    /// Remove the currently active conversation if it was never used (no messages,
    /// no persisted conversation, not private). Prevents abandoned empty conversations
    /// from accumulating in the sidebar.
    func removeAbandonedEmptyConversation(switching nextId: UUID? = nil) {
        guard let previousId = activeConversationId,
              previousId != nextId,
              let vm = chatViewModels[previousId],
              vm.messages.isEmpty else { return }
        let conversation = listStore.conversations.first(where: { $0.id == previousId })
        guard conversation?.kind != .private, conversation?.conversationId == nil else { return }
        listStore.conversations.removeAll { $0.id == previousId }
        chatViewModels.removeValue(forKey: previousId)
        onViewModelRemoved?(previousId)
        if let idx = vmAccessOrder.firstIndex(of: previousId) {
            vmAccessOrder.remove(at: idx)
        }
        log.info("Removed abandoned empty conversation \(previousId)")
    }

    /// Trim the previously active conversation's view model to shed memory before
    /// switching to a different conversation.
    func trimPreviousConversationIfNeeded(nextConversationId: UUID) {
        guard let previousId = activeConversationId, previousId != nextConversationId,
              let vm = chatViewModels[previousId],
              vm.isHistoryLoaded,
              !vm.isSending, !vm.isThinking, !vm.isLoadingMoreMessages else { return }
        vm.trimForBackground()
    }

    // MARK: - Channel Refresh

    /// Start a periodic refresh loop for the active conversation if it is a
    /// channel conversation (Slack, etc.). Cancels any existing refresh task first.
    func startChannelRefreshIfNeeded(conversationId localId: UUID) {
        stopChannelRefresh()
        guard let conversation = listStore.conversations.first(where: { $0.id == localId }),
              conversation.isChannelConversation,
              let daemonConversationId = conversation.conversationId else { return }

        channelRefreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000) // 30s
                guard !Task.isCancelled, let self else { return }
                guard let vm = self.chatViewModels[localId],
                      !vm.isAssistantBusy,
                      !vm.isLoadingMoreMessages,
                      !vm.isLoadingHistory else { continue }
                vm.prepareForNotificationCatchUp()
                self.onChannelRefreshNeeded?(localId, daemonConversationId)
            }
        }
    }

    func stopChannelRefresh() {
        channelRefreshTask?.cancel()
        channelRefreshTask = nil
    }

    // MARK: - Render Cache

    /// Clears static render caches used by chat bubble and markdown views.
    /// Called on conversation close, archive, and delete to prevent unbounded
    /// growth of cached `AttributedString` / segment data across conversations.
    static func clearRenderCaches() {
        ChatBubble.segmentCache.removeAllObjects()
        ChatBubble.lastStreamingSegments = nil
        MarkdownSegmentView.clearAttributedStringCache()
        MarkdownRenderer.clearCaches()
    }
}
