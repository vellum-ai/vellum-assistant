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
        XCTAssertEqual(p.displayTitle, "New conversation")
        XCTAssertFalse(p.isStarted)
        XCTAssertFalse(p.showsActionsMenu)
        XCTAssertFalse(p.canCopy)
        XCTAssertFalse(p.showsForkConversationAction)
        XCTAssertFalse(p.showsForkParentLink)
    }

    func testConversationNotVisibleShowsNewConversation() {
        let conversation = ConversationModel(title: "My Conversation", conversationId: "session-1")
        let p = ConversationHeaderPresentation(
            activeConversation: conversation,
            activeViewModel: nil,
            isConversationVisible: false
        )
        XCTAssertEqual(p.displayTitle, "New conversation")
        XCTAssertFalse(p.showsActionsMenu)
        XCTAssertFalse(p.showsForkParentLink)
    }

    // MARK: - Started standard conversation

    func testStartedStandardConversationShowsActionsMenu() {
        let conversation = ConversationModel(title: "Test Conversation", conversationId: "session-1")
        let vm = {
            let dc = GatewayConnectionManager()
            return ChatViewModel(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        }()
        let p = ConversationHeaderPresentation(
            activeConversation: conversation,
            activeViewModel: vm,
            isConversationVisible: true
        )
        XCTAssertEqual(p.displayTitle, "Test Conversation")
        XCTAssertTrue(p.isStarted)
        XCTAssertTrue(p.showsActionsMenu)
        XCTAssertFalse(p.showsForkConversationAction)
    }

    func testStartedStandardConversationWithPersistedTipShowsForkAction() {
        let conversation = ConversationModel(title: "Test Conversation", conversationId: "session-1")
        let vm = {
            let dc = GatewayConnectionManager()
            return ChatViewModel(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        }()
        var message = ChatMessage(role: .assistant, text: "Persisted reply")
        message.daemonMessageId = "msg-tip"
        vm.messages = [message]
        let p = ConversationHeaderPresentation(
            activeConversation: conversation,
            activeViewModel: vm,
            isConversationVisible: true
        )

        XCTAssertTrue(p.showsForkConversationAction)
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
        XCTAssertFalse(p.showsForkConversationAction)
    }

    func testPrivateConversationSuppressesForkParentMetadata() {
        let conversation = ConversationModel(
            title: "Private Chat",
            conversationId: "session-private",
            kind: .private,
            forkParent: ConversationForkParent(
                conversationId: "session-parent",
                messageId: "msg-parent",
                title: "Original"
            )
        )
        let p = ConversationHeaderPresentation(
            activeConversation: conversation,
            activeViewModel: nil,
            isConversationVisible: true
        )

        XCTAssertFalse(p.showsForkParentLink)
        XCTAssertNil(p.forkParentTitle)
        XCTAssertNil(p.forkParentConversationId)
        XCTAssertNil(p.forkParentMessageId)
    }

    // MARK: - Not started (no conversationId, no messages)

    func testUnstartedConversationDoesNotShowActions() {
        let conversation = ConversationModel(title: "New Conversation")
        let vm = {
            let dc = GatewayConnectionManager()
            return ChatViewModel(connectionManager: dc, eventStreamClient: dc.eventStreamClient)
        }()
        let p = ConversationHeaderPresentation(
            activeConversation: conversation,
            activeViewModel: vm,
            isConversationVisible: true
        )
        XCTAssertFalse(p.isStarted)
        XCTAssertFalse(p.showsActionsMenu)
        XCTAssertFalse(p.canCopy)
        XCTAssertFalse(p.showsForkConversationAction)
    }

    // MARK: - Pin state

    func testPinnedConversationShowsPinnedState() {
        let conversation = ConversationModel(title: "Pinned", conversationId: "s", groupId: ConversationGroup.pinned.id)
        let p = ConversationHeaderPresentation(
            activeConversation: conversation,
            activeViewModel: nil,
            isConversationVisible: true
        )
        XCTAssertTrue(p.isPinned)
    }

    func testForkedConversationShowsParentLinkMetadata() {
        let conversation = ConversationModel(
            title: "Forked",
            conversationId: "session-fork",
            forkParent: ConversationForkParent(
                conversationId: "session-parent",
                messageId: "msg-parent",
                title: "Original"
            )
        )
        let p = ConversationHeaderPresentation(
            activeConversation: conversation,
            activeViewModel: nil,
            isConversationVisible: true
        )

        XCTAssertTrue(p.showsForkParentLink)
        XCTAssertEqual(p.forkParentTitle, "Original")
        XCTAssertEqual(p.forkParentConversationId, "session-parent")
        XCTAssertEqual(p.forkParentMessageId, "msg-parent")
    }
}
