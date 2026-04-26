#if canImport(UIKit)
import XCTest

@testable import VellumAssistantShared
@testable import vellum_assistant_ios

/// Logic-only assertions for ``ACPSessionsView``. Pixel-level rendering is
/// out of scope; we cover the view's visible-state contract: empty vs
/// populated store, agent/status label mapping, parent-conversation
/// truncation, elapsed-time formatting, and swipe-to-cancel.
@MainActor
final class ACPSessionsViewIOSTests: XCTestCase {

    // MARK: - Empty state vs populated

    func test_emptyStore_hasNoSessionsAndZeroCount() {
        let store = ACPSessionStore()
        XCTAssertEqual(store.sessions.count, 0)
        XCTAssertEqual(store.sessionOrder.count, 0)
    }

    func test_populatedStore_listsBothFixturesNewestFirst() {
        let store = ACPSessionStore()
        injectFixture(into: store, acpSessionId: "acp-old", agentId: "claude-code", startedAt: 100)
        injectFixture(into: store, acpSessionId: "acp-new", agentId: "codex", startedAt: 300)

        XCTAssertEqual(store.sessions.count, 2)
        // ``ACPSessionStore.sessionOrder`` sorts by startedAt descending.
        XCTAssertEqual(store.sessionOrder, ["acp-new", "acp-old"])
        XCTAssertEqual(store.sessions["acp-new"]?.state.agentId, "codex")
        XCTAssertEqual(store.sessions["acp-old"]?.state.agentId, "claude-code")
    }

    // MARK: - Agent / status label mapping

    func test_agentLabel_mapsKnownAgentIds() {
        XCTAssertEqual(ACPSessionStateFormatter.agentLabel(for: "claude-code"), "Claude")
        XCTAssertEqual(ACPSessionStateFormatter.agentLabel(for: "codex"), "Codex")
    }

    func test_agentLabel_fallsBackToRawIdForUnknownAgents() {
        XCTAssertEqual(
            ACPSessionStateFormatter.agentLabel(for: "future-agent"),
            "future-agent",
            "Unknown agent ids must fall through so a new agent type still renders"
        )
    }

    func test_statusLabel_capitalisesEveryCase() {
        XCTAssertEqual(ACPSessionStateFormatter.statusLabel(.initializing), "Starting")
        XCTAssertEqual(ACPSessionStateFormatter.statusLabel(.running), "Running")
        XCTAssertEqual(ACPSessionStateFormatter.statusLabel(.completed), "Completed")
        XCTAssertEqual(ACPSessionStateFormatter.statusLabel(.failed), "Failed")
        XCTAssertEqual(ACPSessionStateFormatter.statusLabel(.cancelled), "Cancelled")
        XCTAssertEqual(ACPSessionStateFormatter.statusLabel(.unknown), "Unknown")
    }

    // MARK: - Parent conversation truncation

    func test_parentConversationLabel_truncatesLongIds() {
        let label = ACPSessionStateFormatter.parentConversationLabel("conv-abcdef-1234567890")
        XCTAssertEqual(label, "conv-abc…")
    }

    func test_parentConversationLabel_returnsShortIdsUntouched() {
        XCTAssertEqual(ACPSessionStateFormatter.parentConversationLabel("short"), "short")
    }

    func test_parentConversationLabel_isNilForMissingOrEmptyIds() {
        XCTAssertNil(ACPSessionStateFormatter.parentConversationLabel(nil))
        XCTAssertNil(ACPSessionStateFormatter.parentConversationLabel(""))
    }

    // MARK: - Elapsed-time formatting

    func test_elapsedLabel_completedSessionReportsDuration() {
        // 1700000000000 ms → +90s == 1m 30s.
        let label = ACPSessionStateFormatter.elapsedLabel(
            startedAt: 1_700_000_000_000,
            completedAt: 1_700_000_000_000 + 90_000
        )
        XCTAssertEqual(label, "1m 30s")
    }

    func test_elapsedLabel_subMinuteCompletedSessionReportsSeconds() {
        let label = ACPSessionStateFormatter.elapsedLabel(
            startedAt: 1_700_000_000_000,
            completedAt: 1_700_000_000_000 + 5_000
        )
        XCTAssertEqual(label, "5.0s")
    }

    func test_elapsedLabel_runningSessionFallsBackToRelativeFormatter() {
        // No `completedAt` → relative-time formatter takes over. We can't
        // pin its exact string (locale-dependent) but it must not be empty.
        let label = ACPSessionStateFormatter.elapsedLabel(
            startedAt: Int(Date().addingTimeInterval(-120).timeIntervalSince1970 * 1000),
            completedAt: nil
        )
        XCTAssertFalse(label.isEmpty)
    }

    // MARK: - Swipe-to-cancel availability

    func test_isCancellable_isTrueOnlyForLiveSessions() {
        XCTAssertTrue(ACPSessionsView.isCancellable(.running))
        XCTAssertTrue(ACPSessionsView.isCancellable(.initializing))
        XCTAssertFalse(ACPSessionsView.isCancellable(.completed))
        XCTAssertFalse(ACPSessionsView.isCancellable(.failed))
        XCTAssertFalse(ACPSessionsView.isCancellable(.cancelled))
        XCTAssertFalse(ACPSessionsView.isCancellable(.unknown))
    }

    func test_optimisticCancel_marksRunningSessionAsCancelledLocally() async {
        // ``ACPSessionStore.cancel`` issues a network call we can't make
        // in tests, but the store also exposes a ``handle(_:)`` path the
        // SSE pipeline uses — exercising it ensures the row's swipe
        // wiring would land the session in `.cancelled` once the daemon
        // emits its terminal event.
        let store = ACPSessionStore()
        injectFixture(into: store, acpSessionId: "acp-1", agentId: "claude-code", startedAt: 100)
        XCTAssertEqual(store.sessions["acp-1"]?.state.status, .running)

        store.handle(.acpSessionCompleted(ACPSessionCompletedMessage(
            acpSessionId: "acp-1",
            stopReason: .cancelled
        )))

        XCTAssertEqual(store.sessions["acp-1"]?.state.status, .cancelled)
    }

    // MARK: - Helpers

    /// Inserts a synthetic ACP session into the store via the same
    /// ``ServerMessage`` path the SSE pipeline uses, then pins
    /// `startedAt` to a deterministic value so assertions don't drift
    /// with wall-clock skew.
    private func injectFixture(
        into store: ACPSessionStore,
        acpSessionId: String,
        agentId: String,
        startedAt: Int
    ) {
        store.handle(.acpSessionSpawned(ACPSessionSpawnedMessage(
            acpSessionId: acpSessionId,
            agent: agentId,
            parentConversationId: "conv-\(acpSessionId)"
        )))
        if let viewModel = store.sessions[acpSessionId] {
            viewModel.state = ACPSessionState(
                id: viewModel.state.id,
                agentId: agentId,
                acpSessionId: acpSessionId,
                parentConversationId: "conv-\(acpSessionId)",
                status: .running,
                startedAt: startedAt
            )
        }
    }
}
#endif
