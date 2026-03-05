import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ThreadHeaderPresentationTests: XCTestCase {

    // MARK: - No active thread / draft

    func testDraftShowsNewThreadTitle() {
        let p = ThreadHeaderPresentation(
            activeThread: nil,
            activeViewModel: nil,
            isConversationVisible: true
        )
        XCTAssertEqual(p.displayTitle, "New thread")
        XCTAssertFalse(p.isStarted)
        XCTAssertFalse(p.showsActionsMenu)
        XCTAssertFalse(p.canCopy)
    }

    func testConversationNotVisibleShowsNewThread() {
        let thread = ThreadModel(title: "My Thread", sessionId: "session-1")
        let p = ThreadHeaderPresentation(
            activeThread: thread,
            activeViewModel: nil,
            isConversationVisible: false
        )
        XCTAssertEqual(p.displayTitle, "New thread")
        XCTAssertFalse(p.showsActionsMenu)
    }

    // MARK: - Started standard thread

    func testStartedStandardThreadShowsActionsMenu() {
        let thread = ThreadModel(title: "Test Thread", sessionId: "session-1")
        let vm = ChatViewModel(daemonClient: DaemonClient())
        let p = ThreadHeaderPresentation(
            activeThread: thread,
            activeViewModel: vm,
            isConversationVisible: true
        )
        XCTAssertEqual(p.displayTitle, "Test Thread")
        XCTAssertTrue(p.isStarted)
        XCTAssertTrue(p.showsActionsMenu)
    }

    // MARK: - Private thread

    func testPrivateThreadHidesActionsMenu() {
        let thread = ThreadModel(title: "Private Chat", sessionId: "session-2", kind: .private)
        let p = ThreadHeaderPresentation(
            activeThread: thread,
            activeViewModel: nil,
            isConversationVisible: true
        )
        XCTAssertTrue(p.isStarted)
        XCTAssertTrue(p.isPrivateThread)
        XCTAssertFalse(p.showsActionsMenu)
    }

    // MARK: - Not started (no sessionId, no messages)

    func testUnstartedThreadDoesNotShowActions() {
        let thread = ThreadModel(title: "New Conversation")
        let vm = ChatViewModel(daemonClient: DaemonClient())
        let p = ThreadHeaderPresentation(
            activeThread: thread,
            activeViewModel: vm,
            isConversationVisible: true
        )
        XCTAssertFalse(p.isStarted)
        XCTAssertFalse(p.showsActionsMenu)
        XCTAssertFalse(p.canCopy)
    }

    // MARK: - Pin state

    func testPinnedThreadShowsPinnedState() {
        let thread = ThreadModel(title: "Pinned", sessionId: "s", isPinned: true)
        let p = ThreadHeaderPresentation(
            activeThread: thread,
            activeViewModel: nil,
            isConversationVisible: true
        )
        XCTAssertTrue(p.isPinned)
    }
}
