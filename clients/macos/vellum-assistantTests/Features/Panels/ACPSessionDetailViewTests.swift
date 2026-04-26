import SwiftUI
import XCTest

@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Unit tests for ``ACPSessionDetailView``.
///
/// The bulk of the view's logic is the pure event-stream → timeline-row
/// reduction (`buildRows(events:)`); we cover that exhaustively below plus a
/// smoke test that proves each fixture builds a body without crashing. The
/// cancel button and steer footer add interactive surfaces — their tap
/// handlers are exposed at internal access so tests can drive them via the
/// ``SpyACPSessionStore`` instead of round-tripping through SwiftUI's view
/// tree (XCTest can't tap a `Button` in a unit-test target).
@MainActor
final class ACPSessionDetailViewTests: XCTestCase {

    // MARK: - Setup / Teardown

    /// AppStorage key for the "Show thoughts" header toggle.
    private static let showThoughtsKey = "acp.showThoughts"

    override func setUp() {
        super.setUp()
        // Reset the toggle to its default between cases so a leak in one
        // test doesn't taint the next.
        UserDefaults.standard.removeObject(forKey: Self.showThoughtsKey)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: Self.showThoughtsKey)
        super.tearDown()
    }

    // MARK: - Mock store

    /// Records invocations of ``ACPSessionStore``'s mutating entry points so
    /// detail-view tests can assert taps reach the store without spinning up
    /// the full `URLProtocol` mocking apparatus that the network-layer tests
    /// use. Tests can flip ``deleteResult`` to simulate a daemon failure
    /// (e.g. the 409 returned for active sessions).
    private final class SpyACPSessionStore: ACPSessionStore {
        var cancelInvocations: [String] = []
        var steerInvocations: [(id: String, instruction: String)] = []
        var deleteInvocations: [String] = []
        /// Result the next ``delete(id:)`` call should return. Defaults to
        /// `.success(true)` (the deleted-from-history happy path); tests
        /// override to `.failure(...)` to drive the error branch.
        var deleteResult: Result<Bool, ACPClientError> = .success(true)

        override func cancel(id: String) async -> Result<Bool, ACPClientError> {
            cancelInvocations.append(id)
            // Mirror the real store's optimistic update so views reading
            // `session.state.status` after the call see a terminal state —
            // no different from the production path on a successful HTTP 200.
            if let viewModel = sessions[id] {
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
            return .success(true)
        }

        override func steer(id: String, instruction: String) async -> Result<Bool, ACPClientError> {
            steerInvocations.append((id: id, instruction: instruction))
            // The real store does not mutate state synchronously on steer —
            // the daemon round-trips an SSE update to confirm. Mirror that:
            // no view-model mutation here, just record and ack.
            return .success(true)
        }

        override func delete(id: String) async -> Result<Bool, ACPClientError> {
            deleteInvocations.append(id)
            // Mirror the production store: only drop the row when the
            // (mocked) HTTP call would have succeeded.
            if case .success = deleteResult {
                sessions.removeValue(forKey: id)
                sessionOrder.removeAll { $0 == id }
            }
            return deleteResult
        }
    }

    // MARK: - Fixtures

    private func makeSession(
        agentId: String = "claude-code",
        status: ACPSessionState.Status = .running,
        startedAtMillis: Int = 1_700_000_000_000,
        completedAtMillis: Int? = nil,
        parentConversationId: String? = "conv-1",
        events: [ACPSessionUpdateMessage] = []
    ) -> ACPSessionViewModel {
        let state = ACPSessionState(
            id: "sess-1",
            agentId: agentId,
            acpSessionId: "acp-1",
            parentConversationId: parentConversationId,
            status: status,
            startedAt: startedAtMillis,
            completedAt: completedAtMillis
        )
        let viewModel = ACPSessionViewModel(state: state)
        for event in events {
            viewModel.appendEvent(event)
        }
        return viewModel
    }

    private func update(
        _ type: ACPSessionUpdateMessage.UpdateType,
        content: String? = nil,
        toolCallId: String? = nil,
        toolTitle: String? = nil,
        toolKind: String? = nil,
        toolStatus: String? = nil
    ) -> ACPSessionUpdateMessage {
        ACPSessionUpdateMessage(
            acpSessionId: "acp-1",
            updateType: type,
            content: content,
            toolCallId: toolCallId,
            toolTitle: toolTitle,
            toolKind: toolKind,
            toolStatus: toolStatus
        )
    }

    // MARK: - Row reduction

    func test_buildRows_concatenatesAgentMessageChunks() {
        let rows = ACPSessionDetailView.buildRows(events: [
            update(.agentMessageChunk, content: "Hello, "),
            update(.agentMessageChunk, content: "world!"),
        ])

        XCTAssertEqual(rows.count, 1, "Consecutive agent chunks should fold into a single row")
        guard case let .agentMessage(_, content) = rows[0] else {
            return XCTFail("Expected .agentMessage row, got \(rows[0])")
        }
        XCTAssertEqual(content, "Hello, world!")
    }

    func test_buildRows_concatenatesUserMessageChunks() {
        let rows = ACPSessionDetailView.buildRows(events: [
            update(.userMessageChunk, content: "ping "),
            update(.userMessageChunk, content: "pong"),
        ])

        XCTAssertEqual(rows.count, 1)
        guard case let .userMessage(_, content) = rows[0] else {
            return XCTFail("Expected .userMessage row, got \(rows[0])")
        }
        XCTAssertEqual(content, "ping pong")
    }

    func test_buildRows_concatenatesThoughtChunks() {
        let rows = ACPSessionDetailView.buildRows(events: [
            update(.agentThoughtChunk, content: "Hmm, "),
            update(.agentThoughtChunk, content: "let me think."),
        ])

        XCTAssertEqual(rows.count, 1)
        guard case let .thought(_, content) = rows[0] else {
            return XCTFail("Expected .thought row, got \(rows[0])")
        }
        XCTAssertEqual(content, "Hmm, let me think.")
    }

    func test_buildRows_breaksChunkRunOnNonMatchingType() {
        let rows = ACPSessionDetailView.buildRows(events: [
            update(.agentMessageChunk, content: "Sure, "),
            update(.toolCall, toolCallId: "t1", toolTitle: "search", toolStatus: "running"),
            update(.agentMessageChunk, content: "found it."),
        ])

        XCTAssertEqual(rows.count, 3, "Tool call should split the agent chunk run")
        guard case .agentMessage(_, let first) = rows[0],
              case .toolCall = rows[1],
              case .agentMessage(_, let second) = rows[2]
        else {
            return XCTFail("Unexpected row shape: \(rows)")
        }
        XCTAssertEqual(first, "Sure, ")
        XCTAssertEqual(second, "found it.")
    }

    func test_buildRows_coalescesToolCallUpdatesIntoLatestStatus() {
        let rows = ACPSessionDetailView.buildRows(events: [
            update(.toolCall, toolCallId: "t1", toolTitle: "ripgrep", toolKind: "search", toolStatus: "pending"),
            update(.toolCallUpdate, toolCallId: "t1", toolStatus: "running"),
            update(.toolCallUpdate, toolCallId: "t1", toolStatus: "completed"),
        ])

        XCTAssertEqual(rows.count, 1, "Tool-call updates must fold onto the parent row")
        guard case let .toolCall(_, toolCallId, title, kind, status) = rows[0] else {
            return XCTFail("Expected .toolCall row, got \(rows[0])")
        }
        XCTAssertEqual(toolCallId, "t1")
        XCTAssertEqual(title, "ripgrep")
        XCTAssertEqual(kind, "search")
        XCTAssertEqual(status, "completed", "Latest status should win")
    }

    func test_buildRows_toolCallUpdateOverridesTitleAndKindWhenProvided() {
        let rows = ACPSessionDetailView.buildRows(events: [
            update(.toolCall, toolCallId: "t1", toolTitle: "old title", toolKind: "old", toolStatus: "running"),
            update(.toolCallUpdate, toolCallId: "t1", toolTitle: "new title", toolKind: "new", toolStatus: "completed"),
        ])

        guard case let .toolCall(_, _, title, kind, status) = rows[0] else {
            return XCTFail("Expected .toolCall row")
        }
        XCTAssertEqual(title, "new title")
        XCTAssertEqual(kind, "new")
        XCTAssertEqual(status, "completed")
    }

    func test_buildRows_orphanToolCallUpdate_isDropped() {
        let rows = ACPSessionDetailView.buildRows(events: [
            update(.toolCallUpdate, toolCallId: "ghost", toolStatus: "running"),
        ])

        XCTAssertTrue(rows.isEmpty, "Tool-call update without a matching parent should be dropped")
    }

    func test_buildRows_unknownEventType_isDropped() {
        let rows = ACPSessionDetailView.buildRows(events: [
            update(.unknown, content: "no idea"),
        ])

        XCTAssertTrue(rows.isEmpty, "Unknown event types should not surface in the timeline")
    }

    func test_buildRows_planEvent_parsesMarkdownChecklist() {
        let rows = ACPSessionDetailView.buildRows(events: [
            update(.plan, content: """
            - [x] First step
            - [ ] Second step
            - [ ] Third step
            """),
        ])

        XCTAssertEqual(rows.count, 1)
        guard case let .plan(_, items) = rows[0] else {
            return XCTFail("Expected .plan row")
        }
        XCTAssertEqual(items.count, 3)
        XCTAssertEqual(items[0], .init(text: "First step", isComplete: true))
        XCTAssertEqual(items[1], .init(text: "Second step", isComplete: false))
        XCTAssertEqual(items[2], .init(text: "Third step", isComplete: false))
    }

    func test_buildRows_planEvent_parsesJSONShape() {
        let rows = ACPSessionDetailView.buildRows(events: [
            update(.plan, content: """
            {"items":[
              {"text":"Build","status":"completed"},
              {"text":"Test","status":"in_progress"}
            ]}
            """),
        ])

        guard case let .plan(_, items) = rows[0] else {
            return XCTFail("Expected .plan row")
        }
        XCTAssertEqual(items.count, 2)
        XCTAssertEqual(items[0], .init(text: "Build", isComplete: true))
        XCTAssertEqual(items[1], .init(text: "Test", isComplete: false))
    }

    func test_buildRows_planEvent_emptyContent_yieldsEmptyItems() {
        let rows = ACPSessionDetailView.buildRows(events: [
            update(.plan, content: ""),
        ])

        guard case let .plan(_, items) = rows[0] else {
            return XCTFail("Expected .plan row")
        }
        XCTAssertTrue(items.isEmpty)
    }

    func test_buildRows_orderingPreserved_acrossMixedEvents() {
        let rows = ACPSessionDetailView.buildRows(events: [
            update(.userMessageChunk, content: "search for foo"),
            update(.agentMessageChunk, content: "Looking..."),
            update(.toolCall, toolCallId: "t1", toolTitle: "rg", toolStatus: "running"),
            update(.toolCallUpdate, toolCallId: "t1", toolStatus: "completed"),
            update(.agentMessageChunk, content: " Found 3 hits."),
            update(.plan, content: "- [x] Step\n- [ ] Next"),
        ])

        XCTAssertEqual(rows.count, 5)
        XCTAssertTrue({
            if case .userMessage = rows[0] { return true }; return false
        }())
        XCTAssertTrue({
            if case .agentMessage(_, let c) = rows[1], c == "Looking..." { return true }; return false
        }())
        XCTAssertTrue({
            if case .toolCall(_, _, _, _, let s) = rows[2], s == "completed" { return true }; return false
        }())
        XCTAssertTrue({
            if case .agentMessage(_, let c) = rows[3], c == " Found 3 hits." { return true }; return false
        }())
        XCTAssertTrue({
            if case .plan = rows[4] { return true }; return false
        }())
    }

    // MARK: - Plan parsing

    func test_parsePlanItems_handlesPlainBulletedList() {
        let items = ACPSessionDetailView.parsePlanItems("- foo\n- bar")
        XCTAssertEqual(items, [
            .init(text: "foo", isComplete: false),
            .init(text: "bar", isComplete: false),
        ])
    }

    func test_parsePlanItems_handlesUnformattedFallback() {
        let items = ACPSessionDetailView.parsePlanItems("just a single thing")
        XCTAssertEqual(items, [.init(text: "just a single thing", isComplete: false)])
    }

    // MARK: - Elapsed formatting

    func test_formatElapsed_belowOneHour_usesMinuteSecond() {
        XCTAssertEqual(ACPSessionDetailView.formatElapsed(0), "0:00")
        XCTAssertEqual(ACPSessionDetailView.formatElapsed(5), "0:05")
        XCTAssertEqual(ACPSessionDetailView.formatElapsed(125), "2:05")
        XCTAssertEqual(ACPSessionDetailView.formatElapsed(3599), "59:59")
    }

    func test_formatElapsed_oneHourOrMore_usesHourMinuteSecond() {
        XCTAssertEqual(ACPSessionDetailView.formatElapsed(3600), "1:00:00")
        XCTAssertEqual(ACPSessionDetailView.formatElapsed(3725), "1:02:05")
    }

    // MARK: - View body smoke tests

    /// Each event-type fixture must build a body without trapping. SwiftUI
    /// preview crashes (e.g. nil-unwrap inside a `@ViewBuilder` switch)
    /// would otherwise only surface at runtime — these tests are the cheap
    /// guard.
    func test_body_buildsWithoutCrash_acrossAllEventTypes() {
        let session = makeSession(events: [
            update(.userMessageChunk, content: "go ahead"),
            update(.agentMessageChunk, content: "Working on it"),
            update(.agentThoughtChunk, content: "(thinking)"),
            update(.toolCall, toolCallId: "t1", toolTitle: "rg", toolKind: "search", toolStatus: "running"),
            update(.toolCallUpdate, toolCallId: "t1", toolStatus: "completed"),
            update(.plan, content: "- [x] First\n- [ ] Second"),
            update(.unknown, content: "ignored"),
        ])

        let view = ACPSessionDetailView(session: session, store: ACPSessionStore())
        _ = view.body
    }

    func test_body_buildsWithoutCrash_emptyEventStream() {
        let session = makeSession(events: [])
        let view = ACPSessionDetailView(session: session, store: ACPSessionStore())
        _ = view.body
    }

    func test_body_buildsWithoutCrash_terminalSession() {
        let session = makeSession(
            status: .completed,
            startedAtMillis: 1_700_000_000_000,
            completedAtMillis: 1_700_000_005_000,
            events: [update(.agentMessageChunk, content: "done")]
        )
        let view = ACPSessionDetailView(session: session, store: ACPSessionStore())
        _ = view.body
    }

    func test_body_buildsWithoutCrash_noParentConversation() {
        let session = makeSession(parentConversationId: nil, events: [])
        let view = ACPSessionDetailView(session: session, store: ACPSessionStore())
        _ = view.body
    }

    func test_body_buildsWithoutCrash_withCloseHandler() {
        let session = makeSession(events: [])
        let view = ACPSessionDetailView(
            session: session,
            store: ACPSessionStore(),
            onSelectParentConversation: { _ in },
            onClose: {}
        )
        _ = view.body
    }

    // MARK: - Show-thoughts toggle

    /// `buildRows` is the contract the timeline renders against. With a
    /// mixed event stream we expect a thought row to be present, and the
    /// test then asserts that filtering it out (the path the view takes
    /// when `showThoughts == false`) leaves the other rows intact.
    func test_buildRows_thoughtRowIsEmitted_andCanBeFilteredOut() {
        let allRows = ACPSessionDetailView.buildRows(events: [
            update(.userMessageChunk, content: "do the thing"),
            update(.agentThoughtChunk, content: "let me think about this"),
            update(.agentMessageChunk, content: "Sure, here goes."),
        ])

        // Sanity: a thought row exists in the unfiltered output.
        XCTAssertEqual(allRows.count, 3)
        XCTAssertTrue({
            if case .thought = allRows[1] { return true }; return false
        }())

        let filtered = allRows.filter { row in
            if case .thought = row { return false }
            return true
        }
        XCTAssertEqual(filtered.count, 2, "Filtering thoughts should drop only the thought row")
        XCTAssertTrue({
            if case .userMessage = filtered[0] { return true }; return false
        }())
        XCTAssertTrue({
            if case .agentMessage(_, let content) = filtered[1], content == "Sure, here goes." { return true }; return false
        }())
    }

    /// When `showThoughts` is off, the body must still build cleanly with a
    /// fixture that contains thought events. This is the cheap crash-guard
    /// for the filtered-rendering path.
    func test_body_buildsWithoutCrash_whenShowThoughtsIsOff() {
        UserDefaults.standard.set(false, forKey: Self.showThoughtsKey)

        let session = makeSession(events: [
            update(.agentMessageChunk, content: "Working"),
            update(.agentThoughtChunk, content: "(thinking)"),
            update(.agentMessageChunk, content: " on it."),
        ])
        let view = ACPSessionDetailView(session: session, store: ACPSessionStore())
        _ = view.body
    }

    /// Round-trip the AppStorage value to confirm the toggle persists
    /// across detail-view re-opens. Two views are constructed with the
    /// same key, and the second instance must observe the value the first
    /// stored.
    func test_showThoughtsToggle_persistsAcrossViewInstances() {
        UserDefaults.standard.set(false, forKey: Self.showThoughtsKey)

        let store = ACPSessionStore()
        let session = makeSession(events: [update(.agentThoughtChunk, content: "hmm")])
        // First instance — building the body forces SwiftUI to wire up the
        // @AppStorage binding to UserDefaults.
        _ = ACPSessionDetailView(session: session, store: store).body
        // Second instance — must read back the persisted value.
        _ = ACPSessionDetailView(session: session, store: store).body

        XCTAssertEqual(
            UserDefaults.standard.bool(forKey: Self.showThoughtsKey),
            false,
            "AppStorage value should persist across view re-instantiations"
        )

        // Flip and confirm the new value persists too.
        UserDefaults.standard.set(true, forKey: Self.showThoughtsKey)
        _ = ACPSessionDetailView(session: session, store: store).body
        XCTAssertEqual(
            UserDefaults.standard.bool(forKey: Self.showThoughtsKey),
            true
        )
    }

    /// Default value for the toggle is `true` — `@AppStorage` does *not*
    /// write its default into the underlying store until the user mutates
    /// the binding, so building the view with a missing key must leave the
    /// store untouched. This guards against accidentally swapping the
    /// declared default to `false` (which would be a behaviour change for
    /// every existing user).
    func test_showThoughtsToggle_defaultDoesNotPersistUntilToggled() {
        UserDefaults.standard.removeObject(forKey: Self.showThoughtsKey)
        let session = makeSession(events: [update(.agentThoughtChunk, content: "hi")])
        _ = ACPSessionDetailView(session: session, store: ACPSessionStore()).body
        XCTAssertNil(
            UserDefaults.standard.object(forKey: Self.showThoughtsKey),
            "@AppStorage default value should not be written to the store at view build time"
        )
    }

    // MARK: - Cancel button

    func test_handleCancelTap_invokesStoreCancelExactlyOnce() async {
        let store = SpyACPSessionStore()
        let session = makeSession(status: .running)
        // Register the session with the store so the optimistic mutation in
        // the spy override has a view model to update — mirrors how the
        // production store is populated via `seed()` / SSE before the user
        // can interact with the detail view.
        store.sessions[session.state.id] = session

        let view = ACPSessionDetailView(session: session, store: store)
        view.handleCancelTap()

        // The Task spawned inside `handleCancelTap` runs on the main actor;
        // yield until it completes so the assertion sees the recorded call.
        await waitForSpyInvocation { !store.cancelInvocations.isEmpty }

        XCTAssertEqual(store.cancelInvocations, [session.state.id])
    }

    func test_isCancelable_runningAndInitializing() {
        let store = ACPSessionStore()
        let running = ACPSessionDetailView(session: makeSession(status: .running), store: store)
        let initializing = ACPSessionDetailView(session: makeSession(status: .initializing), store: store)
        let completed = ACPSessionDetailView(session: makeSession(status: .completed), store: store)
        let failed = ACPSessionDetailView(session: makeSession(status: .failed), store: store)
        let cancelled = ACPSessionDetailView(session: makeSession(status: .cancelled), store: store)

        XCTAssertTrue(running.isCancelable)
        XCTAssertTrue(initializing.isCancelable)
        XCTAssertFalse(completed.isCancelable)
        XCTAssertFalse(failed.isCancelable)
        XCTAssertFalse(cancelled.isCancelable)
    }

    // MARK: - Steer footer

    func test_submitSteer_invokesStoreWithTrimmedInstructionAndAppendsSyntheticEvent() async {
        let store = SpyACPSessionStore()
        let session = makeSession(status: .running)
        store.sessions[session.state.id] = session

        let view = ACPSessionDetailView(session: session, store: store)
        // Leading/trailing whitespace exercises the trim path — return-key
        // submissions often pick up a stray space.
        view.submitSteer(rawInstruction: "   slow down and explain   ")

        // Synthetic event lands immediately for instant feedback.
        XCTAssertEqual(session.events.count, 1, "Synthetic feedback row should append immediately")
        XCTAssertEqual(session.events.first?.updateType, .userMessageChunk)
        XCTAssertEqual(session.events.first?.content, "→ steered: slow down and explain")

        await waitForSpyInvocation { !store.steerInvocations.isEmpty }

        XCTAssertEqual(store.steerInvocations.count, 1)
        XCTAssertEqual(store.steerInvocations.first?.id, session.state.id)
        XCTAssertEqual(
            store.steerInvocations.first?.instruction,
            "slow down and explain",
            "Trimmed instruction must reach the store"
        )
    }

    func test_submitSteer_emptyInputIsNoOp() async {
        let store = SpyACPSessionStore()
        let session = makeSession(status: .running)
        store.sessions[session.state.id] = session

        let view = ACPSessionDetailView(session: session, store: store)
        view.submitSteer(rawInstruction: "   ")

        // Yield once — give any erroneous Task a chance to run so the
        // assertion below catches a regression that calls store anyway.
        await Task.yield()

        XCTAssertTrue(session.events.isEmpty, "Whitespace-only input should not append a synthetic row")
        XCTAssertTrue(store.steerInvocations.isEmpty, "Empty input must not reach the store")
    }

    // MARK: - Delete from history

    func test_isDeletable_terminalStatusesOnly() {
        let store = ACPSessionStore()
        let running = ACPSessionDetailView(session: makeSession(status: .running), store: store)
        let initializing = ACPSessionDetailView(session: makeSession(status: .initializing), store: store)
        let completed = ACPSessionDetailView(session: makeSession(status: .completed), store: store)
        let failed = ACPSessionDetailView(session: makeSession(status: .failed), store: store)
        let cancelled = ACPSessionDetailView(session: makeSession(status: .cancelled), store: store)
        let unknown = ACPSessionDetailView(session: makeSession(status: .unknown), store: store)

        XCTAssertTrue(completed.isDeletable)
        XCTAssertTrue(failed.isDeletable)
        XCTAssertTrue(cancelled.isDeletable)
        XCTAssertFalse(running.isDeletable)
        XCTAssertFalse(initializing.isDeletable)
        XCTAssertFalse(unknown.isDeletable, "Unknown is treated as live until proven terminal")
    }

    func test_handleDeleteTap_invokesStoreDeleteOnce_andDismisses() async {
        let store = SpyACPSessionStore()
        let session = makeSession(status: .completed)
        store.sessions[session.state.id] = session
        store.sessionOrder = [session.state.id]

        let dismissed = expectation(description: "onDismiss fires")
        let view = ACPSessionDetailView(
            session: session,
            store: store,
            onDismiss: { dismissed.fulfill() }
        )
        view.handleDeleteTap()

        // `onDismiss` only fires after the Task spawned inside
        // `handleDeleteTap` finishes running on the main actor; expectations
        // make the wait observable without polling.
        await fulfillment(of: [dismissed], timeout: 1.0)

        XCTAssertEqual(store.deleteInvocations, [session.state.id])
        XCTAssertNil(store.sessions[session.state.id],
                     "Spy store mirror should drop the row on success")
        XCTAssertFalse(store.sessionOrder.contains(session.state.id))
    }

    func test_handleDeleteTap_doesNotDismiss_whenStoreReportsFailure() async {
        let store = SpyACPSessionStore()
        // 409 maps to an `httpError` failure; the view must keep the row in
        // place and skip the dismissal so the user has a chance to react.
        store.deleteResult = .failure(.httpError(statusCode: 409))
        let session = makeSession(status: .completed)
        store.sessions[session.state.id] = session
        store.sessionOrder = [session.state.id]

        var dismissCount = 0
        let view = ACPSessionDetailView(
            session: session,
            store: store,
            onDismiss: { dismissCount += 1 }
        )
        view.handleDeleteTap()

        await waitForSpyInvocation { !store.deleteInvocations.isEmpty }
        // After the spy records the call the in-flight Task must also finish
        // its post-await work (resetting `isDeleting`, skipping `onDismiss`).
        // Yielding once gives the scheduler a chance to drain it before the
        // negative assertion below.
        await Task.yield()

        XCTAssertEqual(store.deleteInvocations, [session.state.id])
        XCTAssertEqual(dismissCount, 0, "onDismiss must not fire on failure")
        XCTAssertNotNil(store.sessions[session.state.id],
                        "Failed delete should leave the row in place")
    }

    /// Spin briefly on the main actor until ``predicate`` returns true.
    /// Bounded so a regression that drops the awaited invocation still
    /// fails the test rather than hanging forever.
    private func waitForSpyInvocation(_ predicate: () -> Bool) async {
        for _ in 0..<50 {
            if predicate() { return }
            await Task.yield()
        }
    }
}
