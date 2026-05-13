import Foundation
import Observation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ACPSessionStore")

// MARK: - ACPSessionViewModel

/// Per-session observable state for ACP (Agent Client Protocol) sessions.
///
/// Stored in `ACPSessionStore.sessions` keyed by `state.id` — the daemon's
/// canonical UUID, which is also the value the daemon's `cancel`/`steer`/
/// `delete` routes accept and the value the wire's `acp_session_*` events
/// carry as `acpSessionId`. We deliberately do **not** key by
/// `state.acpSessionId`, because that field gets overwritten with the
/// protocol-level handle once `createSession` resolves — using it would
/// break mutation routes for any session loaded via `seed()`.
///
/// Each session gets its own instance so SwiftUI tracks observation per
/// session: streaming updates to one session's `events` only invalidate
/// views that read that specific view model.
@MainActor @Observable
public final class ACPSessionViewModel: @MainActor Identifiable, Hashable {
    /// Snapshot of the session as last reported by the daemon.
    public var state: ACPSessionState
    /// Stream of update messages received for this session, capped at
    /// ``ACPSessionStore/eventsCapPerSession`` entries — older events are
    /// dropped first to bound memory.
    public var events: [ACPSessionUpdateMessage] = []

    public var id: String { state.id }

    public init(state: ACPSessionState) {
        self.state = state
    }

    /// Append a new update event, dropping the oldest entries to stay within
    /// the per-session retention cap.
    ///
    /// Public so feature-layer code (e.g. ``ACPSessionDetailView``'s steer
    /// footer) can inject synthetic local-only events for immediate user
    /// feedback before the daemon round-trips a confirming SSE update.
    public func appendEvent(_ event: ACPSessionUpdateMessage) {
        events.append(event)
        if events.count > ACPSessionStore.eventsCapPerSession {
            events.removeFirst(events.count - ACPSessionStore.eventsCapPerSession)
        }
    }

    // MARK: - Hashable

    /// Identity-based equality and hashing. The store keeps exactly one
    /// view-model instance per `acpSessionId` for its lifetime, so the
    /// instance pointer is the right notion of "same session" for routing
    /// (`NavigationStack` value-typed paths). Equating by `state` would
    /// break the navigation path the moment the session's status changes.
    public nonisolated static func == (lhs: ACPSessionViewModel, rhs: ACPSessionViewModel) -> Bool {
        lhs === rhs
    }

    public nonisolated func hash(into hasher: inout Hasher) {
        hasher.combine(ObjectIdentifier(self))
    }
}

// MARK: - ACPSessionStore

/// Observable store for ACP sessions.
///
/// Holds a per-session ``ACPSessionViewModel`` keyed by `state.id` — the
/// daemon UUID — plus an order array sorted by `startedAt` descending so
/// list views render newest-first without re-sorting on every change.
/// `state.id` is the canonical identifier the daemon's mutation routes
/// (`cancel`/`steer`/`delete`) and persisted history primary key all use,
/// and is also what the wire's `acp_session_*` events carry as their
/// `acpSessionId` field. Keying by `state.acpSessionId` instead would
/// break for sessions whose protocol-level handle has been filled in
/// (i.e. anything past initialization), since `state.id !=
/// state.acpSessionId` once `createSession` resolves.
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
///
/// Not `final` so detail/list view tests can subclass and spy on
/// ``cancel(id:)`` / ``steer(id:instruction:)`` without spinning up a full
/// `URLProtocol` mock — the only public mutating entry points are explicitly
/// `open` for that reason. Production callers should never subclass.
@MainActor @Observable
open class ACPSessionStore {

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

    /// Per-session observable state, keyed by the daemon UUID
    /// (``ACPSessionState/id``). Mutating an entry's properties only
    /// invalidates views that read that specific view model; mutating the
    /// dictionary itself (insert/remove) invalidates list-level readers.
    public var sessions: [String: ACPSessionViewModel] = [:]
    /// Daemon-UUID order sorted by `startedAt` descending — list views
    /// iterate this to render rows in newest-first order.
    public var sessionOrder: [String] = []
    /// State of the most recent ``seed()`` call. Views show a loading
    /// placeholder while `.loading`, an error banner on `.error`, etc.
    public var seedState: SeedState = .idle

    /// Programmatic deep-link target. When set to a non-nil daemon UUID
    /// (``ACPSessionState/id``), ``ACPSessionsPanel`` reacts by pushing
    /// the matching ``ACPSessionViewModel`` onto its `NavigationStack`.
    /// The panel clears this back to `nil` after consuming the value so a
    /// later set with the same id still triggers a fresh push. Used by
    /// the inline `acp_spawn` tool block to jump straight from a chat
    /// bubble into the corresponding session detail view.
    public var selectedSessionId: String?

    /// Update messages received before their parent `spawned` event,
    /// keyed by the wire `acpSessionId` field — which the daemon
    /// populates with the daemon UUID on every ACP event. Reapplied
    /// during ``seed()`` once the parent appears in the polled snapshot.
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
        // SSE is strictly newer than the polled snapshot. Both branches
        // dedupe by `state.id` (the daemon UUID) so an SSE-spawned entry
        // and the same session arriving via the seed snapshot collapse
        // onto a single store entry — the SSE-spawn path also writes
        // `state.id` as the daemon UUID, so the keys line up.
        for state in snapshot where sessions[state.id] == nil {
            sessions[state.id] = ACPSessionViewModel(state: state)
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
            .map(\.state.id)
    }

    // MARK: - Filtering

    /// View models for sessions whose `parentConversationId` matches the
    /// supplied conversation id, in the same newest-first order as
    /// ``sessionOrder``. Used by the panel's per-conversation filter so the
    /// list can scope to "this conversation" without rebuilding the order
    /// array on every render.
    public func sessions(forConversation id: String) -> [ACPSessionViewModel] {
        sessionOrder.compactMap { sessionId in
            guard let viewModel = sessions[sessionId],
                  viewModel.state.parentConversationId == id else { return nil }
            return viewModel
        }
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
        // The wire's `acpSessionId` IS the daemon UUID — the daemon
        // populates it from the same `state.id` that the cancel/steer/
        // delete routes accept. Use it as both the dictionary key and the
        // synthetic `state.id` so a later `seed()` snapshot for the same
        // session collapses onto this entry instead of duplicating it.
        // `state.acpSessionId` is set to the wire value as a placeholder;
        // a subsequent seed will overwrite it with the protocol-level
        // session id once the agent's `createSession` has resolved.
        if sessions[message.acpSessionId] == nil {
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
    ///
    /// `open` so detail-view tests can subclass and observe invocation
    /// without an HTTP round-trip — see ``ACPSessionStore`` doc.
    @discardableResult
    open func cancel(id: String) async -> Result<Bool, ACPClientError> {
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
    ///
    /// `open` so detail-view tests can subclass and observe invocation
    /// without an HTTP round-trip — see ``ACPSessionStore`` doc.
    @discardableResult
    open func steer(id: String, instruction: String) async -> Result<Bool, ACPClientError> {
        return await ACPClient.steerSession(id: id, instruction: instruction)
    }

    /// Delete a terminal session row from history. On a successful HTTP
    /// 2xx response, removes the matching ``ACPSessionViewModel`` from
    /// ``sessions`` and ``sessionOrder`` so list views update immediately.
    /// `.success(false)` (the daemon reported no row matched) is also
    /// treated as "gone now" — we still drop the in-memory entry so the
    /// UI converges on the daemon's view of the world. Failures (including
    /// the 409 the daemon returns when a session is still active) leave
    /// the store untouched; callers can surface the error to the user.
    ///
    /// `open` so detail-view tests can spy on invocations without standing
    /// up the full `URLProtocol` mock; production callers should never
    /// subclass.
    @discardableResult
    open func delete(id: String) async -> Result<Bool, ACPClientError> {
        let result = await ACPClient.deleteSession(id: id)
        if case .success = result {
            sessions.removeValue(forKey: id)
            sessionOrder.removeAll { $0 == id }
        }
        return result
    }

    /// Bulk-clear every terminal session (`completed`/`failed`/`cancelled`)
    /// from the store. Wraps ``ACPClient/clearCompleted()`` and, on success,
    /// optimistically prunes the matching rows from ``sessions`` and
    /// ``sessionOrder`` so the panel updates without waiting for an SSE
    /// round-trip. Active sessions (`running`/`initializing`/`unknown`) are
    /// preserved verbatim — the daemon ignores them server-side too.
    @discardableResult
    public func clearCompleted() async -> Result<Int, ACPClientError> {
        let result = await ACPClient.clearCompleted()
        if case .success = result {
            sessions = sessions.filter { _, viewModel in
                !Self.isTerminal(viewModel.state.status)
            }
            sessionOrder.removeAll { sessions[$0] == nil }
        }
        return result
    }

    // MARK: - Helpers

    /// Status values that count as terminal for the "clear completed" action.
    /// `.unknown` is intentionally excluded — when the client falls back to
    /// `.unknown` due to daemon version skew we have no way to tell whether
    /// the session is still live, so it stays in the list.
    public static func isTerminal(_ status: ACPSessionState.Status) -> Bool {
        switch status {
        case .completed, .failed, .cancelled:
            return true
        case .initializing, .running, .unknown:
            return false
        }
    }

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
