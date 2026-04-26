import Foundation
import Observation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ACPSessionStore")

// MARK: - ACPSessionViewModel

/// Per-session observable state for ACP (Agent Client Protocol) sessions.
///
/// Stored in `ACPSessionStore.sessions` keyed by `acpSessionId`. Each session
/// gets its own instance so SwiftUI tracks observation per session: streaming
/// updates to one session's `events` only invalidate views that read that
/// specific view model.
@MainActor @Observable
public final class ACPSessionViewModel: Identifiable {
    /// Snapshot of the session as last reported by the daemon.
    public var state: ACPSessionState
    /// Stream of update messages received for this session, capped at
    /// ``ACPSessionStore/eventsCapPerSession`` entries — older events are
    /// dropped first to bound memory.
    public var events: [ACPSessionUpdateMessage] = []

    public var id: String { state.acpSessionId }

    public init(state: ACPSessionState) {
        self.state = state
    }

    /// Append a new update event, dropping the oldest entries to stay within
    /// the per-session retention cap.
    func appendEvent(_ event: ACPSessionUpdateMessage) {
        events.append(event)
        if events.count > ACPSessionStore.eventsCapPerSession {
            events.removeFirst(events.count - ACPSessionStore.eventsCapPerSession)
        }
    }
}

// MARK: - ACPSessionStore

/// Observable store for ACP sessions.
///
/// Holds a per-session ``ACPSessionViewModel`` keyed by `acpSessionId` plus
/// an `[acpSessionId]` order array sorted by `startedAt` descending so list
/// views render newest-first without re-sorting on every change.
///
/// SSE events from the gateway flow through ``handle(_:)``: a `spawned`
/// event creates a view model, `update` events append to its `events`,
/// `completed`/`error` events update its `state.status` and timestamps.
/// Updates that arrive before their parent `spawned` are buffered in
/// ``orphanedUpdates`` and stitched in on the next ``seed()`` call.
///
/// Initial population happens via ``seed()``, which calls
/// ``ACPClient/listSessions(limit:conversationId:)`` and merges the polled
/// snapshot with whatever has already been observed via SSE — in-memory
/// entries win on id collisions so we never overwrite live state with a
/// stale snapshot.
@MainActor @Observable
public final class ACPSessionStore {

    /// Maximum number of events retained per session before older events
    /// are dropped. Prevents unbounded memory growth on long-running
    /// sessions that produce a high volume of token / tool-call updates.
    public static let eventsCapPerSession = 500
    /// Maximum number of orphan updates buffered per session id before the
    /// parent `spawned` event arrives. Past this cap, oldest orphans are
    /// dropped — preserves recent context if the buffer ever fills up.
    public static let orphanCapPerSession = 100

    public enum SeedState: Equatable {
        case idle
        case loading
        case loaded
        case error(String)
    }

    /// Per-session observable state. Mutating an entry's properties only
    /// invalidates views that read that specific view model; mutating the
    /// dictionary itself (insert/remove) invalidates list-level readers.
    public var sessions: [String: ACPSessionViewModel] = [:]
    /// `acpSessionId` order sorted by `startedAt` descending — list views
    /// iterate this to render rows in newest-first order.
    public var sessionOrder: [String] = []
    /// State of the most recent ``seed()`` call. Views show a loading
    /// placeholder while `.loading`, an error banner on `.error`, etc.
    public var seedState: SeedState = .idle

    /// Update messages received before their parent `spawned` event,
    /// keyed by `acpSessionId`. Reapplied during ``seed()`` once the
    /// parent appears in the polled snapshot.
    @ObservationIgnored
    private var orphanedUpdates: [String: [ACPSessionUpdateMessage]] = [:]

    /// Creates an empty store. ``seed()`` should be called once to populate
    /// from the daemon; SSE events received in the meantime are buffered
    /// or applied immediately as appropriate.
    public nonisolated init() {}

    // MARK: - Seeding

    /// Populate the store from the daemon's `/v1/acp/sessions` endpoint.
    ///
    /// Merges the polled snapshot with whatever is already in memory (from
    /// SSE). On id collisions the in-memory entry wins — the snapshot is
    /// strictly older than any SSE event we have already applied. Any
    /// orphan updates whose parent session now exists are flushed onto the
    /// matching view model in arrival order.
    public func seed() async {
        seedState = .loading
        let result = await ACPClient.listSessions()
        switch result {
        case .success(let snapshot):
            mergeSnapshot(snapshot)
            flushOrphans()
            seedState = .loaded
        case .failure(let error):
            log.error("seed failed: \(error.localizedDescription)")
            seedState = .error(error.localizedDescription)
        }
    }

    private func mergeSnapshot(_ snapshot: [ACPSessionState]) {
        // In-memory entries already populated via SSE win on collision —
        // SSE is strictly newer than the polled snapshot.
        for state in snapshot where sessions[state.acpSessionId] == nil {
            sessions[state.acpSessionId] = ACPSessionViewModel(state: state)
        }
        rebuildSessionOrder()
    }

    /// Drain any orphan updates whose parent session now exists. Called from
    /// both ``seed()`` (after merging the snapshot) and ``handleSpawned`` (so
    /// updates that lost the race with their parent are stitched in).
    private func flushOrphans() {
        for (sessionId, updates) in orphanedUpdates {
            guard let viewModel = sessions[sessionId] else { continue }
            for update in updates {
                viewModel.appendEvent(update)
            }
            orphanedUpdates.removeValue(forKey: sessionId)
        }
    }

    private func rebuildSessionOrder() {
        sessionOrder = sessions.values
            .sorted { $0.state.startedAt > $1.state.startedAt }
            .map(\.state.acpSessionId)
    }

    // MARK: - SSE Event Handling

    /// Apply an SSE `ServerMessage` to the store. Non-ACP cases are ignored
    /// so callers can forward every SSE event without filtering.
    public func handle(_ message: ServerMessage) {
        switch message {
        case .acpSessionSpawned(let spawned):
            handleSpawned(spawned)
        case .acpSessionUpdate(let update):
            handleUpdate(update)
        case .acpSessionCompleted(let completed):
            handleCompleted(completed)
        case .acpSessionError(let error):
            handleError(error)
        default:
            break
        }
    }

    private func handleSpawned(_ message: ACPSessionSpawnedMessage) {
        if sessions[message.acpSessionId] == nil {
            // Spawned events carry fewer fields than `ACPSessionState`. Fill
            // in placeholder timestamps; the daemon will overwrite via the
            // next status-changing event or a subsequent seed snapshot.
            let state = ACPSessionState(
                id: message.acpSessionId,
                agentId: message.agent,
                acpSessionId: message.acpSessionId,
                parentConversationId: message.parentConversationId,
                status: .running,
                startedAt: nowMillis()
            )
            sessions[message.acpSessionId] = ACPSessionViewModel(state: state)
            rebuildSessionOrder()
        }
        flushOrphans()
    }

    private func handleUpdate(_ message: ACPSessionUpdateMessage) {
        if let viewModel = sessions[message.acpSessionId] {
            viewModel.appendEvent(message)
            return
        }
        // Buffer until the parent spawn arrives or the next seed stitches
        // it in. Past the per-session cap drop the oldest entries.
        var pending = orphanedUpdates[message.acpSessionId] ?? []
        pending.append(message)
        if pending.count > Self.orphanCapPerSession {
            pending.removeFirst(pending.count - Self.orphanCapPerSession)
        }
        orphanedUpdates[message.acpSessionId] = pending
    }

    private func handleCompleted(_ message: ACPSessionCompletedMessage) {
        guard let viewModel = sessions[message.acpSessionId] else { return }
        viewModel.state = makeTerminalState(
            from: viewModel.state,
            status: message.stopReason == .cancelled ? .cancelled : .completed,
            stopReason: message.stopReason,
            error: viewModel.state.error
        )
    }

    private func handleError(_ message: ACPSessionErrorMessage) {
        guard let viewModel = sessions[message.acpSessionId] else { return }
        viewModel.state = makeTerminalState(
            from: viewModel.state,
            status: .failed,
            stopReason: viewModel.state.stopReason,
            error: message.error
        )
    }

    // MARK: - Optimistic mutations

    /// Cancel an active session. Optimistically marks the session as
    /// cancelled on success so the UI updates without waiting for the
    /// daemon's `acp_session_completed` SSE round-trip.
    @discardableResult
    public func cancel(id: String) async -> Result<Bool, ACPClientError> {
        let result = await ACPClient.cancelSession(id: id)
        if case .success(true) = result, let viewModel = sessions[id] {
            // Reuse existing `completedAt` if the daemon already reported it;
            // otherwise leave it nil and let the SSE event fill it in.
            viewModel.state = ACPSessionState(
                id: viewModel.state.id,
                agentId: viewModel.state.agentId,
                acpSessionId: viewModel.state.acpSessionId,
                parentConversationId: viewModel.state.parentConversationId,
                status: .cancelled,
                startedAt: viewModel.state.startedAt,
                completedAt: viewModel.state.completedAt,
                error: viewModel.state.error,
                stopReason: .cancelled
            )
        }
        return result
    }

    /// Send a steering instruction to an active session. Does not mutate
    /// state directly — the daemon emits a regular update event the store
    /// then reflects via ``handle(_:)``.
    @discardableResult
    public func steer(id: String, instruction: String) async -> Result<Bool, ACPClientError> {
        return await ACPClient.steerSession(id: id, instruction: instruction)
    }

    // MARK: - Helpers

    /// Build an `ACPSessionState` for a terminal transition (completed,
    /// cancelled, failed). Stamps `completedAt` with the current wall clock
    /// since the daemon's terminal SSE events do not carry it.
    private func makeTerminalState(
        from current: ACPSessionState,
        status: ACPSessionState.Status,
        stopReason: ACPSessionState.StopReason?,
        error: String?
    ) -> ACPSessionState {
        ACPSessionState(
            id: current.id,
            agentId: current.agentId,
            acpSessionId: current.acpSessionId,
            parentConversationId: current.parentConversationId,
            status: status,
            startedAt: current.startedAt,
            completedAt: nowMillis(),
            error: error,
            stopReason: stopReason
        )
    }

    private func nowMillis() -> Int {
        Int(Date().timeIntervalSince1970 * 1000)
    }
}
