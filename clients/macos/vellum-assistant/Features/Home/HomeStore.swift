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
/// `hasUnseenChanges` and `isHomeTabVisible` are stubs declared here so the
/// public surface is in place; PR 16 drives the unseen-changes logic.
@MainActor
@Observable
public final class HomeStore {

    // MARK: - Reactive State

    public private(set) var state: RelationshipState?
    public private(set) var isLoading: Bool = false

    /// Set when the daemon emits a `relationshipStateUpdated` SSE event while
    /// the Home tab is not currently visible. Drives a badge on the tab.
    /// PR 16 wires the producer side; this PR only declares the property.
    public private(set) var hasUnseenChanges: Bool = false

    /// Toggled by the Home tab host to track visibility for the unseen-changes
    /// badge logic in PR 16. This PR only declares the property.
    public var isHomeTabVisible: Bool = false

    // MARK: - Non-reactive Bookkeeping

    @ObservationIgnored private let client: HomeStateClient
    @ObservationIgnored let messageStream: AsyncStream<ServerMessage>
    @ObservationIgnored var sseTask: Task<Void, Never>?
    @ObservationIgnored private var foregroundObserver: NSObjectProtocol?

    /// Tracks whether `load()` has completed at least once. Used by the SSE
    /// handler to suppress the unseen-changes dot on the very first cold-load
    /// (otherwise the initial `relationshipStateUpdated` replay would light up
    /// the badge the moment the app boots).
    @ObservationIgnored var hasLoadedOnce: Bool = false

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
    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let next = try await client.fetchRelationshipState()
            self.state = next
            self.hasLoadedOnce = true
        } catch {
            log.error("HomeStore.load failed: \(error.localizedDescription)")
        }
    }

    /// Producer-side flip for the unseen-changes badge. Invoked by the SSE
    /// handler when an update arrives while the Home tab is not visible.
    /// Kept at `internal` so the `HomeStore+SSE` extension can drive it
    /// without exposing it to the rest of the app.
    func flagUnseenChanges() {
        hasUnseenChanges = true
    }

    /// Clears the unseen-changes badge. Called by the Home tab host when the
    /// user navigates to the Home tab. PR 16 will drive the producer side;
    /// the clearer is exposed here so the acceptance-criteria surface is
    /// complete.
    public func markSeen() {
        hasUnseenChanges = false
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
        lock.lock()
        defer { lock.unlock() }
        return _callCount
    }

    public func setState(_ state: RelationshipState?) {
        lock.lock()
        defer { lock.unlock() }
        _state = state
    }

    public func setError(_ error: Error?) {
        lock.lock()
        defer { lock.unlock() }
        _error = error
    }

    public func fetchRelationshipState() async throws -> RelationshipState {
        lock.lock()
        _callCount += 1
        let error = _error
        let state = _state
        lock.unlock()

        if let error { throw error }
        guard let state else {
            throw HomeStateClientError.httpError(statusCode: 404)
        }
        return state
    }
}
