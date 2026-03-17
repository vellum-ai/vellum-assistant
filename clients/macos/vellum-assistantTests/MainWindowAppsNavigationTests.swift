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
        let conversationId = UUID()
        state.selection = .appEditing(appId: "test-app", conversationId: conversationId)

        // Now navigate to apps panel.
        state.showPanel(.apps)

        XCTAssertEqual(state.selection, .panel(.apps))
        // isConversationVisible should be false for apps panel after showPanel(.apps).
        XCTAssertFalse(state.isConversationVisible)
    }

    // MARK: - dismissOverlay() clears sticky state

    func testDismissOverlayClearsAppChatState() {
        let state = MainWindowState(hasAPIKey: false)
        let conversationId = UUID()
        state.selection = .conversation(conversationId)
        // Navigate to app editing then dismiss.
        state.selection = .appEditing(appId: "test-app", conversationId: conversationId)
        state.dismissOverlay()

        // After dismissing, navigating to apps should not show conversation.
        state.showPanel(.apps)
        XCTAssertFalse(state.isConversationVisible)
    }

    // MARK: - Conversation selection from appEditing

    /// Selecting a conversation while in appEditing mode should dismiss the app
    /// panel and transition to the conversation, not keep the app open.
    func testSelectingConversationFromAppEditingDismissesApp() {
        // GIVEN the user is editing an app alongside a conversation
        let state = MainWindowState(hasAPIKey: false)
        let originalConversationId = UUID()
        state.selection = .appEditing(appId: "test-app", conversationId: originalConversationId)

        // WHEN the user selects a different conversation
        let newConversationId = UUID()
        state.selection = .conversation(newConversationId)

        // THEN the selection should be the new conversation (app dismissed)
        XCTAssertEqual(state.selection, .conversation(newConversationId))
        XCTAssertFalse(state.isDynamicExpanded)
        XCTAssertFalse(state.isChatDockOpen)
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
