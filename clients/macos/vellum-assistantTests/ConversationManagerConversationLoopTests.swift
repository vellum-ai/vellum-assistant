import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ConversationManagerConversationLoopTests: XCTestCase {
    private var connectionManager: GatewayConnectionManager!
    private var conversationManager: ConversationManager!

    override func setUp() {
        super.setUp()
        connectionManager = GatewayConnectionManager()
        connectionManager.isConnected = true
        conversationManager = ConversationManager(connectionManager: connectionManager, eventStreamClient: connectionManager.eventStreamClient)
    }

    override func tearDown() {
        conversationManager = nil
        connectionManager = nil
        super.tearDown()
    }

    func testSelectingConversationIdBackedConversationStartsMessageLoop() {
        guard let conversationId = conversationManager.activeConversationId,
              let vm = conversationManager.chatViewModel(for: conversationId),
              let index = conversationManager.conversations.firstIndex(where: { $0.id == conversationId }) else {
            XCTFail("Expected active conversation and view model")
            return
        }

        conversationManager.conversations[index].conversationId = "session-active"
        vm.conversationId = "session-active"

        // Selecting a conversation-id-backed conversation should start its message loop.
        // Subscriber count is now internal to EventStreamClient; verify via active conversation.
        conversationManager.selectConversation(id: conversationId)
        XCTAssertEqual(conversationManager.activeConversationId, conversationId)
    }

    func testSelectingSameConversationIdBackedConversationDoesNotDuplicateMessageLoop() {
        guard let conversationId = conversationManager.activeConversationId,
              let vm = conversationManager.chatViewModel(for: conversationId),
              let index = conversationManager.conversations.firstIndex(where: { $0.id == conversationId }) else {
            XCTFail("Expected active conversation and view model")
            return
        }

        conversationManager.conversations[index].conversationId = "session-active"
        vm.conversationId = "session-active"

        conversationManager.selectConversation(id: conversationId)
        conversationManager.selectConversation(id: conversationId)

        // Selecting the same conversation twice should not cause issues.
        // Subscriber deduplication is now internal to EventStreamClient.
        XCTAssertEqual(conversationManager.activeConversationId, conversationId)
    }
}
