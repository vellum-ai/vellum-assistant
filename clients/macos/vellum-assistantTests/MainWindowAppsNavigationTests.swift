import XCTest
@testable import VellumAssistantLib

@MainActor
final class MainWindowAppsNavigationTests: XCTestCase {

    // MARK: - showPanel(.apps)

    func testShowAppsPanelSetsSelectionToApps() {
        let state = MainWindowState(hasAPIKey: false)
        state.selection = .conversation(UUID())

        state.showPanel(.apps)

        XCTAssertEqual(state.selection, .panel(.apps))
    }

    func testShowAppsPanelIsIdempotent() {
        let state = MainWindowState(hasAPIKey: false)
        state.showPanel(.apps)
        XCTAssertEqual(state.selection, .panel(.apps))

        // Calling again should remain on apps, not toggle away.
        state.showPanel(.apps)
        XCTAssertEqual(state.selection, .panel(.apps))
    }

    func testShowAppsPanelClearsConversationVisible() {
        let state = MainWindowState(hasAPIKey: false)
        // Simulate a prior app-edit flow that left isAppChatOpen = true
        // by toggling the chat dock while in an app editing state.
        let threadId = UUID()
        state.selection = .appEditing(appId: "test-app", conversationId: threadId)

        // Now navigate to apps panel.
        state.showPanel(.apps)

        XCTAssertEqual(state.selection, .panel(.apps))
        // isConversationVisible should be false for apps panel after showPanel(.apps).
        XCTAssertFalse(state.isConversationVisible)
    }

    // MARK: - dismissOverlay() clears sticky state

    func testDismissOverlayClearsAppChatState() {
        let state = MainWindowState(hasAPIKey: false)
        let threadId = UUID()
        state.selection = .conversation(threadId)
        // Navigate to app editing then dismiss.
        state.selection = .appEditing(appId: "test-app", conversationId: threadId)
        state.dismissOverlay()

        // After dismissing, navigating to apps should not show conversation.
        state.showPanel(.apps)
        XCTAssertFalse(state.isConversationVisible)
    }

    // MARK: - closeDynamicPanel() clears sticky state

    func testCloseDynamicPanelClearsAppChatState() {
        let state = MainWindowState(hasAPIKey: false)
        state.selection = .app("test-app")
        state.closeDynamicPanel()

        // After closing dynamic panel, apps should not show conversation.
        state.showPanel(.apps)
        XCTAssertFalse(state.isConversationVisible)
    }
}
