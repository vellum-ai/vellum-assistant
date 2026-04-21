import AppKit
import Foundation
import Observation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "HomeFeedStore")

/// Observable store that owns the Home page's activity feed state.
///
/// Responsibilities:
/// - Fetches the current feed (items + context banner) from the daemon via
///   ``HomeFeedClient``.
/// - Subscribes to the shared `ServerMessage` stream and re-fetches when the
///   daemon broadcasts `homeFeedUpdated`.
/// - Re-fetches when the app returns to the foreground, passing the measured
///   time-away so the daemon can apply `minTimeAway` gates and compose the
///   context banner.
/// - Applies optimistic status updates locally, rolling back on server error.
///
/// The store deliberately leaves `items` / `contextBanner` untouched on
/// failure — a transient network blip should not blank the feed. `isLoading`
/// reflects only the latest in-flight `load()`; concurrent overlapping calls
/// are disambiguated by a generation token so an older response never
/// overwrites a newer one.
@MainActor
@Observable
public final class HomeFeedStore {

    // MARK: - Reactive State

    public private(set) var items: [FeedItem] = []
    public private(set) var contextBanner: ContextBanner?
    /// Prompt-pill suggestions from the daemon. Same failure-mode
    /// semantics as `items` — preserved on fetch error so a transient
    /// network blip doesn't blank the pill bar.
    public private(set) var suggestedPrompts: [SuggestedPrompt] = []
    public private(set) var isLoading: Bool = false
    public private(set) var lastLoadedAt: Date?

    /// Derived from `contextBanner.newCount`. `nil` when the banner has
    /// never been loaded.
    public var newItemCount: Int { contextBanner?.newCount ?? 0 }

    // MARK: - Non-reactive Bookkeeping

    @ObservationIgnored private let client: HomeFeedClient
    @ObservationIgnored let messageStream: AsyncStream<ServerMessage>
    @ObservationIgnored var sseTask: Task<Void, Never>?
    @ObservationIgnored private var lifecycleObservers: [NSObjectProtocol] = []

    /// Moment the user last stepped away from the app (from
    /// `willResignActive`). Consumed by the next `load()` as
    /// `timeAwaySeconds = now - lastAwayAt` and then cleared — the
    /// away→back transition is one-shot and each load reports exactly
    /// one measurement. `nil` while the app is still active or before
    /// the user has ever stepped away.
    @ObservationIgnored private var lastAwayAt: Date?

    /// Monotonically-increasing generation token bumped on every `load()`
    /// entry. Used to discard out-of-order responses when concurrent
    /// `load()` calls overlap (SSE handler + foreground observer +
    /// HomePageView.task can all fire in the same tick).
    @ObservationIgnored private var loadGeneration: UInt64 = 0

    // MARK: - Lifecycle

    public init(client: HomeFeedClient, messageStream: AsyncStream<ServerMessage>) {
        self.client = client
        self.messageStream = messageStream
        startListening()
        observeLifecycle()
    }

    deinit {
        sseTask?.cancel()
        for observer in lifecycleObservers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    // MARK: - Public API

    /// Fetches the latest feed + context banner from the daemon.
    ///
    /// `timeAwaySeconds` is consumed from `lastAwayAt` (set on
    /// `willResignActive`) and cleared — the away→back transition is
    /// one-shot, and a reload that fires for any other reason (SSE,
    /// view appear) reports zero time-away instead of re-billing a
    /// stale gap. Leaves `items` / `contextBanner` unchanged on failure
    /// so the UI keeps showing whatever we last successfully fetched.
    /// Errors are logged, never thrown out.
    public func load() async {
        loadGeneration &+= 1
        let myGeneration = loadGeneration
        isLoading = true
        defer {
            if loadGeneration == myGeneration {
                isLoading = false
            }
        }

        let timeAwaySeconds: TimeInterval
        if let awayAt = lastAwayAt {
            timeAwaySeconds = max(0, Date().timeIntervalSince(awayAt))
            lastAwayAt = nil
        } else {
            timeAwaySeconds = 0
        }

        do {
            let response = try await client.fetchFeed(timeAwaySeconds: timeAwaySeconds)
            guard loadGeneration == myGeneration else { return }
            self.items = response.items
            self.contextBanner = response.contextBanner
            self.suggestedPrompts = response.suggestedPrompts
            self.lastLoadedAt = Date()
        } catch {
            log.error("HomeFeedStore.load failed: \(error.localizedDescription)")
        }
    }

    /// Optimistically updates the item's status in memory, then confirms
    /// with the server. On failure the local change is rolled back to
    /// the prior status — *unless* a `load()` landed a fresh server
    /// snapshot while the PATCH was in flight, in which case the
    /// server's canonical state is already authoritative and a
    /// rollback would clobber it with stale pre-patch data.
    public func updateStatus(itemId: String, status: FeedItemStatus) async {
        guard let index = items.firstIndex(where: { $0.id == itemId }) else { return }

        let previous = items[index]
        if previous.status == status { return }

        let entryGeneration = loadGeneration
        items[index] = replacingStatus(previous, with: status)

        do {
            let confirmed = try await client.patchStatus(itemId: itemId, status: status)
            // Re-find the index — the item may have moved or dropped off
            // while we awaited the network call. If it's still present,
            // reconcile to the server's canonical copy.
            if let freshIndex = items.firstIndex(where: { $0.id == itemId }) {
                items[freshIndex] = confirmed
            }
        } catch {
            log.error("HomeFeedStore.updateStatus(\(itemId)) failed: \(error.localizedDescription)")
            // Only roll back if nothing else has rewritten `items` in
            // the meantime — a concurrent `load()` completing makes its
            // fresh snapshot the new source of truth, and stomping it
            // with our stale pre-patch copy would be a regression.
            guard loadGeneration == entryGeneration else { return }
            if let freshIndex = items.firstIndex(where: { $0.id == itemId }) {
                items[freshIndex] = previous
            }
        }
    }

    /// Wrapper around `updateStatus(..., .dismissed)`. Used by the feed
    /// card's explicit dismiss affordance.
    public func dismiss(itemId: String) async {
        await updateStatus(itemId: itemId, status: .dismissed)
    }

    /// Batches status updates to `.seen` for every item still in the
    /// `.new` state. Marks them locally first, then fires server calls
    /// in parallel. Individual failures are logged but do not roll back
    /// — the local state is still the best approximation of "user has
    /// looked at the feed at least once," which is what `.seen` means.
    public func markAllSeen() async {
        let newIds = items.compactMap { $0.status == .new ? $0.id : nil }
        guard !newIds.isEmpty else { return }

        for id in newIds {
            if let index = items.firstIndex(where: { $0.id == id }) {
                items[index] = replacingStatus(items[index], with: .seen)
            }
        }

        await withTaskGroup(of: Void.self) { group in
            for id in newIds {
                group.addTask { [client] in
                    do {
                        _ = try await client.patchStatus(itemId: id, status: .seen)
                    } catch {
                        log.error("HomeFeedStore.markAllSeen(\(id)) failed: \(error.localizedDescription)")
                    }
                }
            }
        }
    }

    /// Triggers the named action on the feed item. On success the daemon
    /// creates a conversation pre-seeded with the action's prompt and
    /// returns its id; on failure `nil` is returned and the caller can
    /// surface an error toast.
    public func triggerAction(itemId: String, actionId: String) async -> String? {
        do {
            return try await client.triggerAction(itemId: itemId, actionId: actionId)
        } catch {
            log.error("HomeFeedStore.triggerAction(\(itemId),\(actionId)) failed: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Foreground Refresh

    /// Observe both sides of the foreground transition so the next
    /// `load()` can report an accurate `timeAwaySeconds`. Stamp
    /// `lastAwayAt` on `willResignActive`, reload on
    /// `didBecomeActive`; the load consumes and clears the stamp.
    /// Time the user spends with the app merely unfocused (another
    /// app on top) counts as "away"; active-but-idle does not.
    private func observeLifecycle() {
        let resignObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.willResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.lastAwayAt = Date()
            }
        }
        let becomeActiveObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.load()
            }
        }
        lifecycleObservers = [resignObserver, becomeActiveObserver]
    }

    // MARK: - Helpers

    /// `FeedItem` fields are `let` — mutate status by rebuilding the value.
    private func replacingStatus(
        _ item: FeedItem,
        with status: FeedItemStatus
    ) -> FeedItem {
        FeedItem(
            id: item.id,
            type: item.type,
            priority: item.priority,
            title: item.title,
            summary: item.summary,
            source: item.source,
            timestamp: item.timestamp,
            status: status,
            expiresAt: item.expiresAt,
            minTimeAway: item.minTimeAway,
            actions: item.actions,
            urgency: item.urgency,
            author: item.author,
            createdAt: item.createdAt
        )
    }
}

// MARK: - Mock Client

/// In-memory mock used by unit tests. Thread-safe via `NSLock` so tests can
/// flip responses between concurrent `load()` calls without data races.
public final class MockHomeFeedClient: HomeFeedClient, @unchecked Sendable {
    private let lock = NSLock()
    private var _response: HomeFeedResponse?
    private var _fetchError: Error?
    private var _patchError: Error?
    private var _triggerError: Error?
    private var _patchedItems: [String: FeedItem] = [:]
    private var _triggeredConversationId: String = "mock-conversation"
    private var _fetchCallCount: Int = 0
    private var _patchCallCount: Int = 0
    private var _triggerCallCount: Int = 0
    private var _pendingFetchDelay: UInt64 = 0
    private var _pendingPatchDelay: UInt64 = 0

    public init(response: HomeFeedResponse? = nil) {
        self._response = response
    }

    public var fetchCallCount: Int { lock.withLock { _fetchCallCount } }
    public var patchCallCount: Int { lock.withLock { _patchCallCount } }
    public var triggerCallCount: Int { lock.withLock { _triggerCallCount } }

    public func setResponse(_ response: HomeFeedResponse?) {
        lock.withLock { _response = response }
    }

    public func setFetchError(_ error: Error?) {
        lock.withLock { _fetchError = error }
    }

    public func setPatchError(_ error: Error?) {
        lock.withLock { _patchError = error }
    }

    public func setTriggerError(_ error: Error?) {
        lock.withLock { _triggerError = error }
    }

    public func setPatchedItem(id: String, item: FeedItem) {
        lock.withLock { _patchedItems[id] = item }
    }

    public func setTriggeredConversationId(_ id: String) {
        lock.withLock { _triggeredConversationId = id }
    }

    /// Inserts a one-shot sleep inside `fetchFeed` so tests can force
    /// out-of-order response handling.
    public func setNextFetchDelay(nanoseconds: UInt64) {
        lock.withLock { _pendingFetchDelay = nanoseconds }
    }

    /// Inserts a one-shot sleep inside `patchStatus` so tests can race
    /// a concurrent `load()` against an in-flight patch.
    public func setNextPatchDelay(nanoseconds: UInt64) {
        lock.withLock { _pendingPatchDelay = nanoseconds }
    }

    public func fetchFeed(timeAwaySeconds: TimeInterval) async throws -> HomeFeedResponse {
        let (error, response, delay) = lock.withLock {
            () -> (Error?, HomeFeedResponse?, UInt64) in
            _fetchCallCount += 1
            let d = _pendingFetchDelay
            _pendingFetchDelay = 0
            return (_fetchError, _response, d)
        }
        if delay > 0 {
            try? await Task.sleep(nanoseconds: delay)
        }
        if let error { throw error }
        guard let response else {
            throw HomeFeedClientError.httpError(statusCode: 404)
        }
        return response
    }

    public func patchStatus(itemId: String, status: FeedItemStatus) async throws -> FeedItem {
        let (error, replacement, delay) = lock.withLock {
            () -> (Error?, FeedItem?, UInt64) in
            _patchCallCount += 1
            let d = _pendingPatchDelay
            _pendingPatchDelay = 0
            return (_patchError, _patchedItems[itemId], d)
        }
        if delay > 0 {
            try? await Task.sleep(nanoseconds: delay)
        }
        if let error { throw error }
        if let replacement { return replacement }
        throw HomeFeedClientError.httpError(statusCode: 404)
    }

    public func triggerAction(itemId: String, actionId: String) async throws -> String {
        let (error, conversationId) = lock.withLock { () -> (Error?, String) in
            _triggerCallCount += 1
            return (_triggerError, _triggeredConversationId)
        }
        if let error { throw error }
        return conversationId
    }
}
