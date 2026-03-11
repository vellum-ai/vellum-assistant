import XCTest
@testable import VellumAssistantLib

@MainActor
final class MainWindowStateNavigationHistoryTests: XCTestCase {

    func testBackForwardAcrossThreadPanelApp() {
        let state = MainWindowState(hasAPIKey: false)
        let id1 = UUID()
        state.selection = .thread(id1)
        state.selection = .panel(.settings)
        state.selection = .app("myapp")

        // Back twice
        state.navigateBack()
        XCTAssertEqual(state.selection, .panel(.settings))
        state.navigateBack()
        XCTAssertEqual(state.selection, .thread(id1))

        // Forward twice
        state.navigateForward()
        XCTAssertEqual(state.selection, .panel(.settings))
        state.navigateForward()
        XCTAssertEqual(state.selection, .app("myapp"))
    }

    func testRepeatedShowAppsPanelNoDuplicates() {
        let state = MainWindowState(hasAPIKey: false)
        state.showPanel(.apps)
        state.showPanel(.apps)

        // Second call is from == to, so only 1 entry in back stack
        XCTAssertEqual(state.navigationHistory.backStack.count, 1)
    }

    func testBackOnEmptyStackIsNoOp() {
        let state = MainWindowState(hasAPIKey: false)
        state.navigateBack()
        XCTAssertNil(state.selection)
    }

    func testBackToChatDefaultRestoresThread() {
        let state = MainWindowState(hasAPIKey: false)
        let someId = UUID()
        state.persistentThreadId = someId
        // selection is nil (chat default), persistentThreadId is someId
        state.selection = .panel(.settings)
        // back should restore chat default with snapshot
        state.navigateBack()
        XCTAssertEqual(state.selection, .thread(someId))
    }

    func testNavigateBackDoesNotReRecord() {
        let state = MainWindowState(hasAPIKey: false)
        let idA = UUID()
        let idB = UUID()
        state.selection = .thread(idA)
        state.selection = .thread(idB)
        state.navigateBack()
        // Back stack should now have 1 entry: nil->A creates [chatDefault(nil)], A->B creates [chatDefault(nil), A]
        // navigateBack pops A, so back is [chatDefault(nil)]
        XCTAssertEqual(state.navigationHistory.backStack.count, 1)
    }

    func testRestoreLastActivePanelDoesNotSeedHistory() {
        let freshState = MainWindowState(hasAPIKey: false)
        // restoreLastActivePanel reads from @AppStorage which we can't easily mock
        // So just verify the method doesn't crash and check suppression behavior
        freshState.restoreLastActivePanel()
        XCTAssertTrue(freshState.navigationHistory.backStack.isEmpty)
    }

    func testBackToChatDefaultNilResolvesToNilSelection() {
        let state = MainWindowState(hasAPIKey: false)
        // selection is nil, persistentThreadId is nil
        state.selection = .panel(.settings)
        state.navigateBack()
        XCTAssertNil(state.selection)
    }
}
