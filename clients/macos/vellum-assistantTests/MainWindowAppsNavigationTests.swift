import XCTest
@testable import VellumAssistantLib

@MainActor
final class MainWindowAppsNavigationTests: XCTestCase {

    // MARK: - showAppsPanel()

    func testShowAppsPanelSetsSelectionToApps() {
        let state = MainWindowState(hasAPIKey: false)
        state.selection = .thread(UUID())

        state.showAppsPanel()

        XCTAssertEqual(state.selection, .panel(.apps))
    }

    func testShowAppsPanelIsIdempotent() {
        let state = MainWindowState(hasAPIKey: false)
        state.showAppsPanel()
        XCTAssertEqual(state.selection, .panel(.apps))

        // Calling again should remain on apps, not toggle away.
        state.showAppsPanel()
        XCTAssertEqual(state.selection, .panel(.apps))
    }

    func testShowAppsPanelClearsConversationVisible() {
        let state = MainWindowState(hasAPIKey: false)
        // Simulate a prior app-edit flow that left isAppChatOpen = true
        // by toggling the chat dock while in an app editing state.
        let threadId = UUID()
        state.selection = .appEditing(appId: "test-app", threadId: threadId)

        // Now navigate to apps panel.
        state.showAppsPanel()

        XCTAssertEqual(state.selection, .panel(.apps))
        // isConversationVisible should be false for apps panel after showAppsPanel.
        XCTAssertFalse(state.isConversationVisible)
    }

    // MARK: - dismissOverlay() clears sticky state

    func testDismissOverlayClearsAppChatState() {
        let state = MainWindowState(hasAPIKey: false)
        let threadId = UUID()
        state.selection = .thread(threadId)
        // Navigate to app editing then dismiss.
        state.selection = .appEditing(appId: "test-app", threadId: threadId)
        state.dismissOverlay()

        // After dismissing, navigating to apps should not show conversation.
        state.showAppsPanel()
        XCTAssertFalse(state.isConversationVisible)
    }

    // MARK: - closeDynamicPanel() clears sticky state

    func testCloseDynamicPanelClearsAppChatState() {
        let state = MainWindowState(hasAPIKey: false)
        state.selection = .app("test-app")
        state.closeDynamicPanel()

        // After closing dynamic panel, apps should not show conversation.
        state.showAppsPanel()
        XCTAssertFalse(state.isConversationVisible)
    }
}
