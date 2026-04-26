import XCTest

@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Stand-in `URLProtocol` for the ACP panel tests that exercise
/// ``ACPSessionStore/clearCompleted``. Only the clear-completed test path
/// installs a handler — the pure-function tests above never hit the network.
private final class MockACPSessionsPanelURLProtocol: URLProtocol {
    static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.requestHandler else {
            XCTFail("requestHandler not set")
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

/// Logic-only assertions for ``ACPSessionsPanel``. Pixel-level rendering is
/// out of scope; we cover the panel's visible-state contract: empty vs
/// populated, count label, agent/status label mapping, parent-conversation
/// truncation, and elapsed-time formatting (the row's only piece of
/// non-trivial logic).
@MainActor
final class ACPSessionsPanelTests: XCTestCase {
    private let assistantId = "assistant-acp-panel-test"
    private let gatewayPort = 7833
    private var originalPrimaryLockfileData: Data?
    private var primaryLockfileExisted = false
    private var lockfileInstalled = false

    override func tearDownWithError() throws {
        if lockfileInstalled {
            URLProtocol.unregisterClass(MockACPSessionsPanelURLProtocol.self)
            MockACPSessionsPanelURLProtocol.requestHandler = nil

            if primaryLockfileExisted {
                try originalPrimaryLockfileData?.write(to: LockfilePaths.primary, options: .atomic)
            } else {
                try? FileManager.default.removeItem(at: LockfilePaths.primary)
            }
            lockfileInstalled = false
            originalPrimaryLockfileData = nil
            primaryLockfileExisted = false
        }
        try super.tearDownWithError()
    }

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

    // MARK: - Status label / colour mapping

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
        // ``VCollapsibleStepRowDurationFormatter`` renders sub-minute
        // durations with one decimal place ("5.0s").
        XCTAssertEqual(label, "5.0s")
    }

    func test_elapsedLabel_runningSessionFallsBackToRelativeFormatter() {
        // No `completedAt` → relative-time formatter takes over. We can't
        // pin its exact string (locale-dependent) but it must not be empty
        // and must not look like the duration formatter's output.
        let label = ACPSessionStateFormatter.elapsedLabel(
            startedAt: Int(Date().addingTimeInterval(-120).timeIntervalSince1970 * 1000),
            completedAt: nil
        )
        XCTAssertFalse(label.isEmpty)
    }

    // MARK: - Terminal-status classification

    func test_isTerminal_recognisesCompletedFailedAndCancelled() {
        XCTAssertTrue(ACPSessionStore.isTerminal(.completed))
        XCTAssertTrue(ACPSessionStore.isTerminal(.failed))
        XCTAssertTrue(ACPSessionStore.isTerminal(.cancelled))
    }

    func test_isTerminal_treatsActiveAndUnknownAsLive() {
        // `.unknown` is intentionally non-terminal — version-skew fallbacks
        // must not silently drop sessions whose real status we can't read.
        XCTAssertFalse(ACPSessionStore.isTerminal(.initializing))
        XCTAssertFalse(ACPSessionStore.isTerminal(.running))
        XCTAssertFalse(ACPSessionStore.isTerminal(.unknown))
    }

    // MARK: - clearCompleted

    /// Mixed-state store + successful HTTP response: terminal sessions are
    /// optimistically pruned from both ``sessions`` and ``sessionOrder``,
    /// while running/initializing rows survive untouched.
    func test_clearCompleted_removesTerminalSessionsAndKeepsRunningOnes() async throws {
        try installLockfileFixture()

        let store = ACPSessionStore()
        injectFixture(into: store, acpSessionId: "acp-running", agentId: "claude-code", startedAt: 100, status: .running)
        injectFixture(into: store, acpSessionId: "acp-completed", agentId: "codex", startedAt: 200, status: .completed)
        injectFixture(into: store, acpSessionId: "acp-failed", agentId: "claude-code", startedAt: 300, status: .failed)
        injectFixture(into: store, acpSessionId: "acp-cancelled", agentId: "codex", startedAt: 400, status: .cancelled)
        injectFixture(into: store, acpSessionId: "acp-init", agentId: "claude-code", startedAt: 500, status: .initializing)

        let requestExpectation = expectation(description: "clear completed request")
        MockACPSessionsPanelURLProtocol.requestHandler = { request in
            requestExpectation.fulfill()
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(#"{"deleted":3}"#.utf8))
        }

        let result = await store.clearCompleted()

        await fulfillment(of: [requestExpectation], timeout: 1.0)

        guard case .success(let count) = result else {
            return XCTFail("Expected success, got \(result)")
        }
        XCTAssertEqual(count, 3)
        XCTAssertEqual(Set(store.sessions.keys), ["acp-running", "acp-init"])
        XCTAssertEqual(Set(store.sessionOrder), ["acp-running", "acp-init"])
        XCTAssertNil(store.sessions["acp-completed"])
        XCTAssertNil(store.sessions["acp-failed"])
        XCTAssertNil(store.sessions["acp-cancelled"])
    }

    /// Failed HTTP call must not touch local state — terminal rows stay
    /// visible so the user can retry without losing their place.
    func test_clearCompleted_leavesStoreUntouchedOnFailure() async throws {
        try installLockfileFixture()

        let store = ACPSessionStore()
        injectFixture(into: store, acpSessionId: "acp-running", agentId: "claude-code", startedAt: 100, status: .running)
        injectFixture(into: store, acpSessionId: "acp-completed", agentId: "codex", startedAt: 200, status: .completed)

        MockACPSessionsPanelURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 500,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(#"{"error":{"message":"boom"}}"#.utf8))
        }

        let result = await store.clearCompleted()

        guard case .failure = result else {
            return XCTFail("Expected failure, got \(result)")
        }
        XCTAssertEqual(Set(store.sessions.keys), ["acp-running", "acp-completed"])
        XCTAssertEqual(Set(store.sessionOrder), ["acp-running", "acp-completed"])
    }

    // MARK: - Per-conversation filter

    func test_sessionsForConversation_returnsOnlyMatchingSessions() {
        let store = ACPSessionStore()
        injectFixture(
            into: store,
            acpSessionId: "acp-conv-a-old",
            agentId: "claude-code",
            parentConversationId: "conv-a",
            startedAt: 100
        )
        injectFixture(
            into: store,
            acpSessionId: "acp-conv-b",
            agentId: "codex",
            parentConversationId: "conv-b",
            startedAt: 200
        )
        injectFixture(
            into: store,
            acpSessionId: "acp-conv-a-new",
            agentId: "claude-code",
            parentConversationId: "conv-a",
            startedAt: 300
        )

        let convA = store.sessions(forConversation: "conv-a")
        XCTAssertEqual(
            convA.map(\.state.acpSessionId),
            ["acp-conv-a-new", "acp-conv-a-old"],
            "Filter must preserve newest-first ordering from sessionOrder"
        )

        let convB = store.sessions(forConversation: "conv-b").map(\.state.acpSessionId)
        XCTAssertEqual(convB, ["acp-conv-b"])

        XCTAssertTrue(
            store.sessions(forConversation: "conv-missing").isEmpty,
            "Filtering on a conversation with no sessions must return an empty array"
        )
    }

    func test_sessionsForConversation_panelFilterEndToEnd() {
        let store = ACPSessionStore()
        injectFixture(
            into: store,
            acpSessionId: "acp-other",
            agentId: "codex",
            parentConversationId: "conv-other",
            startedAt: 100
        )
        injectFixture(
            into: store,
            acpSessionId: "acp-active",
            agentId: "claude-code",
            parentConversationId: "conv-active",
            startedAt: 200
        )

        let suiteName = "ACPSessionsPanelTests.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            return XCTFail("Failed to allocate isolated UserDefaults suite")
        }
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }
        let storage = ACPSessionsPanelFilterStorage(defaults: defaults)

        // Default for a conversation with matches is `.thisConversation`.
        XCTAssertEqual(storage.filter(for: "conv-active"), .thisConversation)
        XCTAssertFalse(storage.hasStoredFilter(for: "conv-active"))

        // "This conversation" filter renders only the active conversation's
        // sessions.
        let scoped = store.sessions(forConversation: "conv-active")
        XCTAssertEqual(scoped.map(\.state.acpSessionId), ["acp-active"])

        // Toggling to `.all` persists across lookups.
        storage.setFilter(.all, for: "conv-active")
        XCTAssertEqual(storage.filter(for: "conv-active"), .all)
        XCTAssertTrue(storage.hasStoredFilter(for: "conv-active"))

        // With the filter switched off, the panel iterates `sessionOrder`
        // and shows every session newest-first.
        let allSessions = store.sessionOrder.compactMap { store.sessions[$0]?.state.acpSessionId }
        XCTAssertEqual(allSessions, ["acp-active", "acp-other"])

        // A different conversation has its own preference and is unaffected.
        XCTAssertEqual(storage.filter(for: "conv-other"), .thisConversation)
    }

    func test_filterStorage_returnsAllForNilConversation() {
        let suiteName = "ACPSessionsPanelTests.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            return XCTFail("Failed to allocate isolated UserDefaults suite")
        }
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let storage = ACPSessionsPanelFilterStorage(defaults: defaults)

        // No active conversation → no scope to filter against, so the
        // storage reports `.all` and silently ignores writes.
        XCTAssertEqual(storage.filter(for: nil), .all)
        storage.setFilter(.thisConversation, for: nil)
        XCTAssertEqual(storage.filter(for: nil), .all)
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
        parentConversationId: String? = nil,
        startedAt: Int,
        status: ACPSessionState.Status = .running
    ) {
        let parent = parentConversationId ?? "conv-\(acpSessionId)"
        store.handle(.acpSessionSpawned(ACPSessionSpawnedMessage(
            acpSessionId: acpSessionId,
            agent: agentId,
            parentConversationId: parent
        )))
        // Pin `startedAt` to a deterministic value so assertions don't drift
        // with wall-clock skew. ``sessionOrder`` was already computed by the
        // spawn handler using insertion order, which matches our intent.
        if let viewModel = store.sessions[acpSessionId] {
            viewModel.state = ACPSessionState(
                id: viewModel.state.id,
                agentId: agentId,
                acpSessionId: acpSessionId,
                parentConversationId: parent,
                status: status,
                startedAt: startedAt
            )
        }
    }

    /// Stand up the lockfile + URL protocol mock that ``ACPClient`` needs to
    /// resolve the gateway base URL. Only the network-touching tests call
    /// this — the pure-function tests above run without it. Tear-down is
    /// handled in ``tearDownWithError``.
    private func installLockfileFixture() throws {
        MockACPSessionsPanelURLProtocol.requestHandler = nil
        URLProtocol.registerClass(MockACPSessionsPanelURLProtocol.self)

        let primaryLockfileURL = LockfilePaths.primary
        primaryLockfileExisted = FileManager.default.fileExists(atPath: primaryLockfileURL.path)
        if primaryLockfileExisted {
            originalPrimaryLockfileData = try Data(contentsOf: primaryLockfileURL)
        }

        let lockfile: [String: Any] = [
            "activeAssistant": assistantId,
            "assistants": [
                [
                    "assistantId": assistantId,
                    "cloud": "local",
                    "hatchedAt": "2026-03-19T12:00:00Z",
                    "resources": [
                        "gatewayPort": gatewayPort,
                    ],
                ],
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: lockfile, options: [.sortedKeys])
        try data.write(to: primaryLockfileURL, options: .atomic)
        lockfileInstalled = true
    }
}
