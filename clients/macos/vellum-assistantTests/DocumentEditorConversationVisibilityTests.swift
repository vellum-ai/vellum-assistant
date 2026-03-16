import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class DocumentEditorThreadVisibilityTests: XCTestCase {

    // MARK: - Helpers

    /// Creates a `MainWindowState` pre-configured with the given selection.
    private func makeState(_ selection: ViewSelection?) -> MainWindowState {
        let state = MainWindowState(hasAPIKey: false)
        state.selection = selection
        return state
    }

    // MARK: - isConversationVisible for document editor

    func testDocumentEditorIsConversationVisible() {
        let state = makeState(.panel(.documentEditor))

        XCTAssertTrue(state.isConversationVisible,
                       "Document editor should always report conversation as visible")
    }

    func testDocumentEditorIsNotShowingChat() {
        let state = makeState(.panel(.documentEditor))

        // isShowingChat only covers full-window chat (.thread / nil); panels use isConversationVisible
        XCTAssertFalse(state.isShowingChat,
                        "isShowingChat should be false for document editor (it's a panel)")
    }

    func testThreadSelectionIsConversationVisible() {
        let state = makeState(.thread(UUID()))

        XCTAssertTrue(state.isConversationVisible)
        XCTAssertTrue(state.isShowingChat)
    }

    func testNilSelectionIsConversationVisible() {
        let state = makeState(nil)

        XCTAssertTrue(state.isConversationVisible)
        XCTAssertTrue(state.isShowingChat)
    }

    func testSettingsPanelIsNotConversationVisible() {
        let state = makeState(.panel(.settings))

        // Settings panel without chat bubble should not be conversation-visible
        XCTAssertFalse(state.isConversationVisible)
    }

    // MARK: - ThreadHeaderPresentation for document editor

    func testDocumentEditorShowsThreadTitleWhenActiveThreadExists() {
        let thread = ThreadModel(title: "Doc Session Thread", sessionId: "doc-session-1")
        let vm = ChatViewModel(daemonClient: DaemonClient())
        let presentation = ThreadHeaderPresentation(
            activeThread: thread,
            activeViewModel: vm,
            isConversationVisible: true  // document editor always reports conversation as visible
        )

        XCTAssertEqual(presentation.displayTitle, "Doc Session Thread",
                        "Document editor should show actual thread title, not 'New thread'")
        XCTAssertTrue(presentation.isStarted)
        XCTAssertTrue(presentation.showsActionsMenu)
    }

    func testDocumentEditorShowsNewThreadWhenNoActiveThread() {
        let presentation = ThreadHeaderPresentation(
            activeThread: nil,
            activeViewModel: nil,
            isConversationVisible: true
        )

        XCTAssertEqual(presentation.displayTitle, "New thread")
        XCTAssertFalse(presentation.isStarted)
    }
}
