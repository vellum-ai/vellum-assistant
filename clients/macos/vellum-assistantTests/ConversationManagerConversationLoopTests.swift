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

    func testSelectingSessionBackedThreadStartsMessageLoop() {
        guard let threadId = conversationManager.activeConversationId,
              let vm = conversationManager.chatViewModel(for: threadId),
              let index = conversationManager.conversations.firstIndex(where: { $0.id == threadId }) else {
            XCTFail("Expected active conversation and view model")
            return
        }

        conversationManager.conversations[index].conversationId = "session-active"
        vm.conversationId = "session-active"

        XCTAssertEqual(daemonClient.subscribers.count, 0)
        conversationManager.selectConversation(id: threadId)
        XCTAssertEqual(daemonClient.subscribers.count, 1)
    }

    func testSelectingSameSessionBackedThreadDoesNotDuplicateMessageLoop() {
        guard let threadId = conversationManager.activeConversationId,
              let vm = conversationManager.chatViewModel(for: threadId),
              let index = conversationManager.conversations.firstIndex(where: { $0.id == threadId }) else {
            XCTFail("Expected active conversation and view model")
            return
        }

        conversationManager.conversations[index].conversationId = "session-active"
        vm.conversationId = "session-active"

        conversationManager.selectConversation(id: threadId)
        conversationManager.selectConversation(id: threadId)

        XCTAssertEqual(daemonClient.subscribers.count, 1)
    }
}
