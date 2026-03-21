import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class DocumentEditorConversationVisibilityTests: XCTestCase {

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

        // isShowingChat only covers full-window chat (.conversation / nil); panels use isConversationVisible
        XCTAssertFalse(state.isShowingChat,
                        "isShowingChat should be false for document editor (it's a panel)")
    }

    func testConversationSelectionIsConversationVisible() {
        let state = makeState(.conversation(UUID()))

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

    // MARK: - ConversationHeaderPresentation for document editor

    func testDocumentEditorShowsConversationTitleWhenActiveConversationExists() {
        let conversation = ConversationModel(title: "Doc Session Conversation", conversationId: "doc-session-1")
        let vm = ChatViewModel(daemonClient: DaemonClient(), eventStreamClient: DaemonClient().eventStreamClient)
        let presentation = ConversationHeaderPresentation(
            activeConversation: conversation,
            activeViewModel: vm,
            isConversationVisible: true  // document editor always reports conversation as visible
        )

        XCTAssertEqual(presentation.displayTitle, "Doc Session Conversation",
                        "Document editor should show actual conversation title, not 'New conversation'")
        XCTAssertTrue(presentation.isStarted)
        XCTAssertTrue(presentation.showsActionsMenu)
    }

    func testDocumentEditorShowsNewConversationWhenNoActiveConversation() {
        let presentation = ConversationHeaderPresentation(
            activeConversation: nil,
            activeViewModel: nil,
            isConversationVisible: true
        )

        XCTAssertEqual(presentation.displayTitle, "New conversation")
        XCTAssertFalse(presentation.isStarted)
    }
}
