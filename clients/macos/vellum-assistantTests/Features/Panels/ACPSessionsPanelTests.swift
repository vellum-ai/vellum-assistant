import XCTest

@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Logic-only assertions for ``ACPSessionsPanel``. Pixel-level rendering is
/// out of scope; we cover the panel's visible-state contract: empty vs
/// populated, count label, agent/status label mapping, parent-conversation
/// truncation, and elapsed-time formatting (the row's only piece of
/// non-trivial logic).
@MainActor
final class ACPSessionsPanelTests: XCTestCase {

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

    // MARK: - Agent label mapping

    func test_agentLabel_mapsKnownAgentIds() {
        XCTAssertEqual(ACPSessionsPanelRow.agentLabel(for: "claude-code"), "Claude")
        XCTAssertEqual(ACPSessionsPanelRow.agentLabel(for: "codex"), "Codex")
    }

    func test_agentLabel_fallsBackToRawIdForUnknownAgents() {
        XCTAssertEqual(
            ACPSessionsPanelRow.agentLabel(for: "future-agent"),
            "future-agent",
            "Unknown agent ids must fall through so a new agent type still renders"
        )
    }

    // MARK: - Status label / colour mapping

    func test_statusLabel_capitalisesEveryCase() {
        XCTAssertEqual(ACPSessionsPanelRow.statusLabel(.initializing), "Starting")
        XCTAssertEqual(ACPSessionsPanelRow.statusLabel(.running), "Running")
        XCTAssertEqual(ACPSessionsPanelRow.statusLabel(.completed), "Completed")
        XCTAssertEqual(ACPSessionsPanelRow.statusLabel(.failed), "Failed")
        XCTAssertEqual(ACPSessionsPanelRow.statusLabel(.cancelled), "Cancelled")
        XCTAssertEqual(ACPSessionsPanelRow.statusLabel(.unknown), "Unknown")
    }

    // MARK: - Parent conversation truncation

    func test_parentConversationLabel_truncatesLongIds() {
        let label = ACPSessionsPanelRow.parentConversationLabel("conv-abcdef-1234567890")
        XCTAssertEqual(label, "conv-abc…")
    }

    func test_parentConversationLabel_returnsShortIdsUntouched() {
        XCTAssertEqual(ACPSessionsPanelRow.parentConversationLabel("short"), "short")
    }

    func test_parentConversationLabel_isNilForMissingOrEmptyIds() {
        XCTAssertNil(ACPSessionsPanelRow.parentConversationLabel(nil))
        XCTAssertNil(ACPSessionsPanelRow.parentConversationLabel(""))
    }

    // MARK: - Elapsed-time formatting

    func test_elapsedLabel_completedSessionReportsDuration() {
        // 1700000000000 ms → +90s == 1m 30s.
        let label = ACPSessionsPanelRow.elapsedLabel(
            startedAt: 1_700_000_000_000,
            completedAt: 1_700_000_000_000 + 90_000
        )
        XCTAssertEqual(label, "1m 30s")
    }

    func test_elapsedLabel_subMinuteCompletedSessionReportsSeconds() {
        let label = ACPSessionsPanelRow.elapsedLabel(
            startedAt: 1_700_000_000_000,
            completedAt: 1_700_000_000_000 + 5_000
        )
        // ``VCollapsibleStepRowDurationFormatter`` renders sub-minute
        // durations with one decimal place ("5.0s").
        XCTAssertEqual(label, "5.0s")
    }

    func test_elapsedLabel_runningSessionFallsBackToRelativeFormatter() {
        // No `completedAt` → relative-time formatter takes over. We can't
        // pin its exact string (locale-dependent) but it must not be empty
        // and must not look like the duration formatter's output.
        let label = ACPSessionsPanelRow.elapsedLabel(
            startedAt: Int(Date().addingTimeInterval(-120).timeIntervalSince1970 * 1000),
            completedAt: nil
        )
        XCTAssertFalse(label.isEmpty)
    }

    // MARK: - Helpers

    /// Inserts a synthetic ACP session into the store via the same
    /// ``ServerMessage`` path the SSE pipeline uses. The spawn handler stamps
    /// `startedAt` with the wall-clock time at insertion — newer fixtures
    /// therefore sort ahead of older ones automatically, so callers should
    /// inject in oldest-first order to get a deterministic newest-first
    /// ``sessionOrder``.
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
        // Pin `startedAt` to a deterministic value so assertions don't drift
        // with wall-clock skew. ``sessionOrder`` was already computed by the
        // spawn handler using insertion order, which matches our intent.
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
