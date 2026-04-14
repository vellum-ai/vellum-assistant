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
    public private(set) var isLoading: Bool = false
    public private(set) var lastLoadedAt: Date?

    /// Derived from `contextBanner.newCount`. `nil` when the banner has
    /// never been loaded.
    public var newItemCount: Int { contextBanner?.newCount ?? 0 }

    // MARK: - Non-reactive Bookkeeping

    @ObservationIgnored private let client: HomeFeedClient
    @ObservationIgnored let messageStream: AsyncStream<ServerMessage>
    @ObservationIgnored var sseTask: Task<Void, Never>?
    @ObservationIgnored private var foregroundObserver: NSObjectProtocol?

    /// Timestamp of the most recent moment the client was in the
    /// foreground. Used to compute `timeAwaySeconds` on the next `load()`.
    /// Initialized to `now` at construction so a cold-start load sees a
    /// zero-delta instead of a nonsensical negative or epoch value.
    @ObservationIgnored private var lastForegroundAt: Date

    /// Monotonically-increasing generation token bumped on every `load()`
    /// entry. Used to discard out-of-order responses when concurrent
    /// `load()` calls overlap (SSE handler + foreground observer +
    /// HomePageView.task can all fire in the same tick).
    @ObservationIgnored private var loadGeneration: UInt64 = 0

    // MARK: - Lifecycle

    public init(client: HomeFeedClient, messageStream: AsyncStream<ServerMessage>) {
        self.client = client
        self.messageStream = messageStream
        self.lastForegroundAt = Date()
        startListening()
        observeForeground()
    }

    deinit {
        sseTask?.cancel()
        if let observer = foregroundObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    // MARK: - Public API

    /// Fetches the latest feed + context banner from the daemon.
    ///
    /// `timeAwaySeconds` is computed from `lastForegroundAt`; callers do
    /// not supply it. Leaves `items` / `contextBanner` unchanged on
    /// failure so the UI keeps showing whatever we last successfully
    /// fetched. Errors are logged, never thrown out.
    public func load() async {
        loadGeneration &+= 1
        let myGeneration = loadGeneration
        isLoading = true
        defer {
            if loadGeneration == myGeneration {
                isLoading = false
            }
        }

        let timeAwaySeconds = max(0, Date().timeIntervalSince(lastForegroundAt))

        do {
            let response = try await client.fetchFeed(timeAwaySeconds: timeAwaySeconds)
            guard loadGeneration == myGeneration else { return }
            self.items = response.items
            self.contextBanner = response.contextBanner
            self.lastLoadedAt = Date()
        } catch {
            log.error("HomeFeedStore.load failed: \(error.localizedDescription)")
        }
    }

    /// Optimistically updates the item's status in memory, then confirms
    /// with the server. On failure the local change is rolled back to the
    /// prior status so the UI and server stay consistent.
    public func updateStatus(itemId: String, status: FeedItemStatus) async {
        guard let index = items.firstIndex(where: { $0.id == itemId }) else { return }

        let previous = items[index]
        if previous.status == status { return }

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
            if let freshIndex = items.firstIndex(where: { $0.id == itemId }) {
                items[freshIndex] = previous
            }
        }
    }

    /// Wrapper around `updateStatus(..., .actedOn)`. Used by the feed
    /// card's explicit dismiss affordance.
    public func dismiss(itemId: String) async {
        await updateStatus(itemId: itemId, status: .actedOn)
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

    private func observeForeground() {
        foregroundObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                // Load first against the existing `lastForegroundAt` so the
                // daemon sees the real time-away gap, then reset the stamp
                // to the current moment for the next cycle.
                await self.load()
                self.lastForegroundAt = Date()
            }
        }
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
        let (error, replacement) = lock.withLock { () -> (Error?, FeedItem?) in
            _patchCallCount += 1
            return (_patchError, _patchedItems[itemId])
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
