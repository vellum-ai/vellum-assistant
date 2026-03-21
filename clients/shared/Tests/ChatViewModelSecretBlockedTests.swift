import XCTest
@testable import VellumAssistantShared

@MainActor
final class ChatViewModelSecretBlockedTests: XCTestCase {

    private var daemonClient: GatewayConnectionManager!
    private var viewModel: ChatViewModel!

    override func setUp() {
        super.setUp()
        daemonClient = GatewayConnectionManager()
        daemonClient.isConnected = true
        viewModel = ChatViewModel(daemonClient: daemonClient, eventStreamClient: daemonClient.eventStreamClient)
        viewModel.conversationId = "sess-1"
    }

    override func tearDown() {
        viewModel = nil
        daemonClient = nil
        super.tearDown()
    }

    func testSecretBlockedErrorRemovesBlockedUserMessage() {
        viewModel.inputText = "Here is my token 123456789:ABCDefGHIJklmnopQRSTuvwxyz012345678"
        viewModel.sendMessage()

        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].role, .user)

        viewModel.handleServerMessage(.error(ErrorMessage(
            message: "Blocked for secrets",
            category: "secret_blocked"
        )))

        XCTAssertEqual(viewModel.messages.count, 0, "Blocked user message should be removed from chat history")
        XCTAssertTrue(viewModel.isSecretBlockError, "Secret-blocked state should still be available")
        XCTAssertEqual(
            viewModel.secretBlockedMessageText,
            "Here is my token 123456789:ABCDefGHIJklmnopQRSTuvwxyz012345678"
        )
    }

    func testSecretBlockedErrorCleansQueuedBookkeepingForRemovedMessage() {
        viewModel.isSending = true
        viewModel.isThinking = true
        viewModel.pendingQueuedCount = 1
        viewModel.currentTurnUserText = "secret queued message"

        let queuedMessage = ChatMessage(role: .user, text: "secret queued message", status: .queued(position: 0))
        viewModel.messages.append(queuedMessage)
        viewModel.pendingMessageIds = [queuedMessage.id]
        viewModel.requestIdToMessageId = ["req-secret-1": queuedMessage.id]

        viewModel.handleServerMessage(.error(ErrorMessage(
            message: "Blocked for secrets",
            category: "secret_blocked"
        )))

        XCTAssertEqual(viewModel.messages.count, 0, "Blocked queued message should be removed")
        XCTAssertEqual(viewModel.pendingQueuedCount, 0, "Queue count should drop for removed blocked message")
        XCTAssertTrue(viewModel.pendingMessageIds.isEmpty, "Pending message IDs should remove the blocked message")
        XCTAssertTrue(viewModel.requestIdToMessageId.isEmpty, "Request mapping should remove the blocked message")
    }
}
