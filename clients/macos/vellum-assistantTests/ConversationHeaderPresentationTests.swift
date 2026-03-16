import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ConversationHeaderPresentationTests: XCTestCase {

    // MARK: - No active conversation / draft

    func testDraftShowsNewConversationTitle() {
        let p = ConversationHeaderPresentation(
            activeConversation: nil,
            activeViewModel: nil,
            isConversationVisible: true
        )
        XCTAssertEqual(p.displayTitle, "New thread")
        XCTAssertFalse(p.isStarted)
        XCTAssertFalse(p.showsActionsMenu)
        XCTAssertFalse(p.canCopy)
    }

    func testConversationNotVisibleShowsNewConversation() {
        let conversation = ConversationModel(title: "My Conversation", conversationId: "session-1")
        let p = ConversationHeaderPresentation(
            activeConversation: conversation,
            activeViewModel: nil,
            isConversationVisible: false
        )
        XCTAssertEqual(p.displayTitle, "New thread")
        XCTAssertFalse(p.showsActionsMenu)
    }

    // MARK: - Started standard conversation

    func testStartedStandardConversationShowsActionsMenu() {
        let conversation = ConversationModel(title: "Test Conversation", conversationId: "session-1")
        let vm = ChatViewModel(daemonClient: DaemonClient())
        let p = ConversationHeaderPresentation(
            activeConversation: conversation,
            activeViewModel: vm,
            isConversationVisible: true
        )
        XCTAssertEqual(p.displayTitle, "Test Conversation")
        XCTAssertTrue(p.isStarted)
        XCTAssertTrue(p.showsActionsMenu)
    }

    // MARK: - Private conversation

    func testPrivateConversationHidesActionsMenu() {
        let conversation = ConversationModel(title: "Private Chat", conversationId: "session-2", kind: .private)
        let p = ConversationHeaderPresentation(
            activeConversation: conversation,
            activeViewModel: nil,
            isConversationVisible: true
        )
        XCTAssertTrue(p.isStarted)
        XCTAssertTrue(p.isPrivateConversation)
        XCTAssertFalse(p.showsActionsMenu)
    }

    // MARK: - Not started (no conversationId, no messages)

    func testUnstartedConversationDoesNotShowActions() {
        let conversation = ConversationModel(title: "New Conversation")
        let vm = ChatViewModel(daemonClient: DaemonClient())
        let p = ConversationHeaderPresentation(
            activeConversation: conversation,
            activeViewModel: vm,
            isConversationVisible: true
        )
        XCTAssertFalse(p.isStarted)
        XCTAssertFalse(p.showsActionsMenu)
        XCTAssertFalse(p.canCopy)
    }

    // MARK: - Pin state

    func testPinnedConversationShowsPinnedState() {
        let conversation = ConversationModel(title: "Pinned", conversationId: "s", isPinned: true)
        let p = ConversationHeaderPresentation(
            activeConversation: conversation,
            activeViewModel: nil,
            isConversationVisible: true
        )
        XCTAssertTrue(p.isPinned)
    }
}
