import AppKit
import Foundation
import Observation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "HomeStore")

/// Observable store that owns the Home page's cached `RelationshipState`.
///
/// Responsibilities:
/// - Fetches the current state from the daemon via ``HomeStateClient``.
/// - Subscribes to the shared `ServerMessage` stream and re-fetches when the
///   daemon broadcasts `relationshipStateUpdated`.
/// - Re-fetches when the app returns to the foreground so the UI stays fresh
///   if the user switched away while capabilities were being unlocked.
///
/// The store deliberately leaves `state` untouched on failure — a transient
/// network blip should not blank the Home page. `isLoading` reflects the
/// in-flight state of `load()` so views can show a spinner on first fetch.
///
/// `hasUnseenChanges` is raised by either ``HomeStore+SSE`` (on
/// `relationshipStateUpdated`) or ``HomeFeedStore+SSE`` (on
/// `homeFeedUpdated`) when the user is not currently looking at the Home
/// tab. ``setHomeTabVisible(_:)`` is the single funnel that flips
/// visibility from the panel host and clears the badge on focus.
@MainActor
@Observable
public final class HomeStore {

    // MARK: - Reactive State

    public private(set) var state: RelationshipState?
    public private(set) var isLoading: Bool = false

    /// Set when the daemon emits an SSE event that affects something
    /// rendered on the Home tab while the user is currently elsewhere.
    /// Drives the unread dot on the Home toolbar button. Producers go
    /// through ``flagUnseenChanges()`` (same-module-only) so the field
    /// stays read-only at the public API boundary.
    public private(set) var hasUnseenChanges: Bool = false

    /// Tracks whether the Home tab is currently the active panel. Mutated
    /// only via ``setHomeTabVisible(_:)`` so the visibility flip and the
    /// badge clear stay in lockstep.
    public private(set) var isHomeTabVisible: Bool = false

    // MARK: - Non-reactive Bookkeeping

    @ObservationIgnored private let client: HomeStateClient
    @ObservationIgnored let messageStream: AsyncStream<ServerMessage>
    @ObservationIgnored var sseTask: Task<Void, Never>?
    @ObservationIgnored private var foregroundObserver: NSObjectProtocol?

    /// Monotonically-increasing generation token bumped on every `load()`
    /// entry. Used to discard out-of-order responses when concurrent
    /// `load()` calls overlap (SSE handler + foreground observer +
    /// HomePageView.task can all fire in the same tick).
    @ObservationIgnored private var loadGeneration: UInt64 = 0

    // MARK: - Lifecycle

    public init(client: HomeStateClient, messageStream: AsyncStream<ServerMessage>) {
        self.client = client
        self.messageStream = messageStream
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

    /// Fetches the latest `RelationshipState` from the daemon.
    ///
    /// Leaves `state` unchanged on failure so the UI keeps showing whatever
    /// we last successfully fetched. Errors are logged, never thrown out.
    ///
    /// Concurrent calls are guarded by `loadGeneration`: each call captures
    /// its own generation token at entry, and only applies its result if it
    /// is still the latest call when the network response lands. This makes
    /// the SSE handler / foreground observer / HomePageView.task triple-fire
    /// race safe — older responses are silently discarded instead of
    /// overwriting newer state.
    public func load() async {
        loadGeneration &+= 1
        let myGeneration = loadGeneration
        isLoading = true
        defer {
            // Only the latest in-flight call should clear `isLoading`.
            if loadGeneration == myGeneration {
                isLoading = false
            }
        }
        do {
            let next = try await client.fetchRelationshipState()
            // Drop the result if a newer `load()` started while we awaited.
            guard loadGeneration == myGeneration else { return }
            self.state = next
        } catch {
            log.error("HomeStore.load failed: \(error.localizedDescription)")
        }
    }

    /// Producer-side flip for the unseen-changes badge. Invoked by the SSE
    /// handlers (``HomeStore+SSE`` and the cross-store callback wired into
    /// ``HomeFeedStore``) when an update arrives while the Home tab is not
    /// visible. Kept at `internal` so producers in the same module can drive
    /// it without exposing the setter to the rest of the app.
    func flagUnseenChanges() {
        hasUnseenChanges = true
    }

    /// Clears the unseen-changes badge. Called by ``setHomeTabVisible(_:)``
    /// when the user navigates to the Home tab and exposed publicly so
    /// fixtures and edge-case callers can reset the flag explicitly.
    public func markSeen() {
        hasUnseenChanges = false
    }

    /// Single funnel for visibility changes. The Home tab host calls this
    /// from `.onAppear` / `.onDisappear` so the visibility flip and the
    /// badge clear stay coupled — clearing the badge on focus is the
    /// behaviour we want every time the tab becomes visible, so encoding
    /// it here keeps callers from forgetting one of the two steps.
    public func setHomeTabVisible(_ visible: Bool) {
        isHomeTabVisible = visible
        if visible {
            markSeen()
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
                await self?.load()
            }
        }
    }
}

// MARK: - Mock Client

/// In-memory mock used by unit tests and, in the future, gallery fixtures.
///
/// Lives alongside `HomeStore` rather than in a test-only file so it can be
/// shared between `vellum-assistantTests` and any future preview surfaces
/// without changing its import path.
public final class MockHomeStateClient: HomeStateClient, @unchecked Sendable {
    private let lock = NSLock()
    private var _state: RelationshipState?
    private var _error: Error?
    private var _callCount: Int = 0

    public init(state: RelationshipState? = nil, error: Error? = nil) {
        self._state = state
        self._error = error
    }

    public var callCount: Int {
        lock.withLock { _callCount }
    }

    public func setState(_ state: RelationshipState?) {
        lock.withLock { _state = state }
    }

    public func setError(_ error: Error?) {
        lock.withLock { _error = error }
    }

    public func fetchRelationshipState() async throws -> RelationshipState {
        let (error, state) = lock.withLock { () -> (Error?, RelationshipState?) in
            _callCount += 1
            return (_error, _state)
        }

        if let error { throw error }
        guard let state else {
            throw HomeStateClientError.httpError(statusCode: 404)
        }
        return state
    }
}
