import XCTest
@testable import VellumAssistantShared

@MainActor
final class ChatViewModelSendWatchdogTests: XCTestCase {

    private var connectionManager: GatewayConnectionManager!
    private var viewModel: ChatViewModel!

    override func setUp() {
        super.setUp()
        connectionManager = GatewayConnectionManager()
        connectionManager.isConnected = true
        viewModel = ChatViewModel(connectionManager: connectionManager, eventStreamClient: connectionManager.eventStreamClient)
        viewModel.conversationId = "sess-1"
    }

    override func tearDown() {
        viewModel.isSending = false
        viewModel.isThinking = false
        viewModel = nil
        connectionManager = nil
        super.tearDown()
    }

    func testDirectSendArmsStuckTurnWatchdogs() {
        XCTAssertFalse(viewModel.isSendingWatchdogArmedForTesting)
        XCTAssertFalse(viewModel.isThinkingWatchdogArmedForTesting)

        viewModel.inputText = "hello"
        viewModel.sendMessage()

        XCTAssertTrue(viewModel.isSending)
        XCTAssertTrue(viewModel.isThinking)
        XCTAssertTrue(viewModel.isSendingWatchdogArmedForTesting)
        XCTAssertTrue(viewModel.isThinkingWatchdogArmedForTesting)
    }
}
