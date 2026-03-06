import XCTest
@testable import VellumAssistantLib

@MainActor
final class DocumentEditorThreadVisibilityTests: XCTestCase {

    // MARK: - isConversationVisible for document editor

    func testDocumentEditorIsConversationVisible() {
        let state = MainWindowState(hasAPIKey: false)
        state.selection = .panel(.documentEditor)

        XCTAssertTrue(state.isConversationVisible,
                       "Document editor should always report conversation as visible")
    }

    func testDocumentEditorIsNotShowingChat() {
        let state = MainWindowState(hasAPIKey: false)
        state.selection = .panel(.documentEditor)

        // isShowingChat is false for panels — the bug was using this instead of isConversationVisible
        XCTAssertFalse(state.isShowingChat,
                        "isShowingChat should be false for document editor (it's a panel)")
    }

    func testThreadSelectionIsConversationVisible() {
        let state = MainWindowState(hasAPIKey: false)
        state.selection = .thread(UUID())

        XCTAssertTrue(state.isConversationVisible)
        XCTAssertTrue(state.isShowingChat)
    }

    func testNilSelectionIsConversationVisible() {
        let state = MainWindowState(hasAPIKey: false)
        state.selection = nil

        XCTAssertTrue(state.isConversationVisible)
        XCTAssertTrue(state.isShowingChat)
    }

    func testSettingsPanelIsNotConversationVisible() {
        let state = MainWindowState(hasAPIKey: false)
        state.selection = .panel(.settings)

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
            isConversationVisible: true  // what isConversationVisible returns for document editor
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
