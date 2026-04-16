import XCTest
@testable import VellumAssistantLib

@MainActor
final class MainWindowStateNavigationHistoryTests: XCTestCase {

    func testBackForwardAcrossConversationPanelApp() {
        let state = MainWindowState()
        let id1 = UUID()
        state.selection = .conversation(id1)
        state.selection = .panel(.settings)
        state.selection = .app("myapp")

        // Back twice
        state.navigateBack()
        XCTAssertEqual(state.selection, .panel(.settings))
        state.navigateBack()
        XCTAssertEqual(state.selection, .conversation(id1))

        // Forward twice
        state.navigateForward()
        XCTAssertEqual(state.selection, .panel(.settings))
        state.navigateForward()
        XCTAssertEqual(state.selection, .app("myapp"))
    }

    func testRepeatedShowAppsPanelNoDuplicates() {
        let state = MainWindowState()
        state.showPanel(.apps)
        state.showPanel(.apps)

        // Second call is from == to, so only 1 entry in back stack
        XCTAssertEqual(state.navigationHistory.backStack.count, 1)
    }

    func testBackOnEmptyStackIsNoOp() {
        let state = MainWindowState()
        state.navigateBack()
        XCTAssertNil(state.selection)
    }

    func testBackToChatDefaultRestoresConversation() {
        let state = MainWindowState()
        let someId = UUID()
        state.persistentConversationId = someId
        // selection is nil (chat default), persistentConversationId is someId
        state.selection = .panel(.settings)
        // back should restore chat default with snapshot
        state.navigateBack()
        XCTAssertEqual(state.selection, .conversation(someId))
    }

    func testNavigateBackDoesNotReRecord() {
        let state = MainWindowState()
        let idA = UUID()
        let idB = UUID()
        state.selection = .conversation(idA)
        state.selection = .conversation(idB)
        state.navigateBack()
        // Back stack should now have 1 entry: nil->A creates [chatDefault(nil)], A->B creates [chatDefault(nil), A]
        // navigateBack pops A, so back is [chatDefault(nil)]
        XCTAssertEqual(state.navigationHistory.backStack.count, 1)
    }

    func testRestoreLastActivePanelDoesNotSeedHistory() {
        let freshState = MainWindowState()
        // restoreLastActivePanel reads from @AppStorage which we can't easily mock
        // So just verify the method doesn't crash and check suppression behavior
        freshState.restoreLastActivePanel()
        XCTAssertTrue(freshState.navigationHistory.backStack.isEmpty)
    }

    func testBackToChatDefaultNilResolvesToNilSelection() {
        let state = MainWindowState()
        // selection is nil, persistentConversationId is nil
        state.selection = .panel(.settings)
        state.navigateBack()
        XCTAssertNil(state.selection)
    }

    func testNavigatingToConversationClearsLastActivePanel() {
        let state = MainWindowState()
        // Show a panel so lastActivePanelString is set
        state.showPanel(.settings)
        // Navigate to a conversation
        let convId = UUID()
        state.selection = .conversation(convId)
        // The persisted panel should be cleared so restart lands on chat
        XCTAssertNil(UserDefaults.standard.string(forKey: "lastActivePanel"))
    }

    func testNavigateBackOrDismissUsesHistoryWhenAvailable() {
        // GIVEN a conversation followed by Settings
        let state = MainWindowState()
        let convId = UUID()
        state.selection = .conversation(convId)
        state.selection = .panel(.settings)

        // WHEN navigateBackOrDismiss is called
        state.navigateBackOrDismiss()

        // THEN it returns to the conversation via the history stack
        XCTAssertEqual(state.selection, .conversation(convId))
    }

    func testNavigateBackOrDismissFallsThroughWhenHistoryEmpty() {
        // GIVEN a panel restored on app restart (empty back stack)
        let state = MainWindowState()
        let convId = UUID()
        state.persistentConversationId = convId
        state.navigationHistory.withRecordingSuppressed {
            state.selection = .panel(.settings)
        }
        XCTAssertTrue(state.navigationHistory.backStack.isEmpty)

        // WHEN navigateBackOrDismiss is called
        state.navigateBackOrDismiss()

        // THEN it falls back to dismissOverlay, returning to persistentConversationId
        XCTAssertEqual(state.selection, .conversation(convId))
    }

    func testCloseDynamicPanelClearsState() {
        let state = MainWindowState()
        state.selection = .app("myapp")

        state.closeDynamicPanel()

        XCTAssertNil(state.activeDynamicSurface)
        XCTAssertNil(state.activeDynamicParsedSurface)
        XCTAssertNil(state.selection)
    }
}
