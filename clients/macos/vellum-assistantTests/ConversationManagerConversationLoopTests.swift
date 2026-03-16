import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ConversationManagerSessionLoopTests: XCTestCase {
    private var daemonClient: DaemonClient!
    private var conversationManager: ConversationManager!

    override func setUp() {
        super.setUp()
        daemonClient = DaemonClient()
        daemonClient.isConnected = true
        daemonClient.sendOverride = { _ in }
        conversationManager = ConversationManager(daemonClient: daemonClient)
    }

    override func tearDown() {
        daemonClient?.sendOverride = nil
        conversationManager = nil
        daemonClient = nil
        super.tearDown()
    }

    func testSelectingSessionBackedConversationStartsMessageLoop() {
        guard let conversationId = conversationManager.activeConversationId,
              let vm = conversationManager.chatViewModel(for: conversationId),
              let index = conversationManager.conversations.firstIndex(where: { $0.id == conversationId }) else {
            XCTFail("Expected active conversation and view model")
            return
        }

        conversationManager.conversations[index].conversationId = "session-active"
        vm.conversationId = "session-active"

        XCTAssertEqual(daemonClient.subscribers.count, 0)
        conversationManager.selectConversation(id: conversationId)
        XCTAssertEqual(daemonClient.subscribers.count, 1)
    }

    func testSelectingSameSessionBackedConversationDoesNotDuplicateMessageLoop() {
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

        XCTAssertEqual(daemonClient.subscribers.count, 1)
    }
}
