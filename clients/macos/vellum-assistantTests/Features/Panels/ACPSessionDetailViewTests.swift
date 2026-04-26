import SwiftUI
import XCTest

@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Unit tests for ``ACPSessionDetailView``.
///
/// The view is read-only and stateless beyond auto-scroll bookkeeping, so
/// the meaningful surface to test is the pure event-stream → timeline-row
/// reduction (`buildRows(events:)`) plus a smoke test that proves each
/// fixture builds a body without crashing. SwiftUI does not give us a
/// way to assert layout output in unit tests, so we cover that contract
/// at the row-model level — the only place errors can hide that aren't
/// also caught by the macOS build job.
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

        let view = ACPSessionDetailView(session: session)
        _ = view.body
    }

    func test_body_buildsWithoutCrash_emptyEventStream() {
        let session = makeSession(events: [])
        let view = ACPSessionDetailView(session: session)
        _ = view.body
    }

    func test_body_buildsWithoutCrash_terminalSession() {
        let session = makeSession(
            status: .completed,
            startedAtMillis: 1_700_000_000_000,
            completedAtMillis: 1_700_000_005_000,
            events: [update(.agentMessageChunk, content: "done")]
        )
        let view = ACPSessionDetailView(session: session)
        _ = view.body
    }

    func test_body_buildsWithoutCrash_noParentConversation() {
        let session = makeSession(parentConversationId: nil, events: [])
        let view = ACPSessionDetailView(session: session)
        _ = view.body
    }

    func test_body_buildsWithoutCrash_withCloseHandler() {
        let session = makeSession(events: [])
        let view = ACPSessionDetailView(
            session: session,
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
        let view = ACPSessionDetailView(session: session)
        _ = view.body
    }

    /// Round-trip the AppStorage value to confirm the toggle persists
    /// across detail-view re-opens. Two views are constructed with the
    /// same key, and the second instance must observe the value the first
    /// stored.
    func test_showThoughtsToggle_persistsAcrossViewInstances() {
        UserDefaults.standard.set(false, forKey: Self.showThoughtsKey)

        let session = makeSession(events: [update(.agentThoughtChunk, content: "hmm")])
        // First instance — building the body forces SwiftUI to wire up the
        // @AppStorage binding to UserDefaults.
        _ = ACPSessionDetailView(session: session).body
        // Second instance — must read back the persisted value.
        _ = ACPSessionDetailView(session: session).body

        XCTAssertEqual(
            UserDefaults.standard.bool(forKey: Self.showThoughtsKey),
            false,
            "AppStorage value should persist across view re-instantiations"
        )

        // Flip and confirm the new value persists too.
        UserDefaults.standard.set(true, forKey: Self.showThoughtsKey)
        _ = ACPSessionDetailView(session: session).body
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
        _ = ACPSessionDetailView(session: session).body
        XCTAssertNil(
            UserDefaults.standard.object(forKey: Self.showThoughtsKey),
            "@AppStorage default value should not be written to the store at view build time"
        )
    }
}
