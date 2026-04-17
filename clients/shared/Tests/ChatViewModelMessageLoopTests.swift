import XCTest
@testable import VellumAssistantShared

@MainActor
final class ChatViewModelMessageLoopTests: XCTestCase {

    private var connectionManager: GatewayConnectionManager!
    private var viewModel: ChatViewModel!

    override func setUp() {
        super.setUp()
        connectionManager = GatewayConnectionManager()
        connectionManager.isConnected = true
        viewModel = ChatViewModel(
            connectionManager: connectionManager,
            eventStreamClient: connectionManager.eventStreamClient
        )
        viewModel.conversationId = "sess-message-loop"
    }

    override func tearDown() {
        viewModel = nil
        connectionManager = nil
        super.tearDown()
    }

    func testRepeatedSynchronousRestartsDoNotDuplicateAssistantTextDelta() async {
        for _ in 0..<4 {
            viewModel.startMessageLoop()
        }

        connectionManager.eventStreamClient.broadcastMessage(
            .assistantTextDelta(
                AssistantTextDeltaMessage(text: "delta-once", conversationId: "sess-message-loop")
            )
        )

        try? await Task.sleep(
            nanoseconds: UInt64((ChatViewModel.streamingFlushInterval * 2) * 1_000_000_000)
        )

        let assistantMessages = viewModel.messages.filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 1, "A single delta should render into one assistant row")
        XCTAssertEqual(assistantMessages.first?.text, "delta-once")

        let renderedCount = assistantMessages.first?.text.components(separatedBy: "delta-once").count ?? 0
        XCTAssertEqual(renderedCount - 1, 1, "Rendered assistant text should contain the delta exactly once")
    }

    func testIdleRestartFinishesPreviousLoopWithoutWaitingForLaterTraffic() async {
        viewModel.startMessageLoop()
        let previousTask = viewModel.messageLoopTask

        XCTAssertNotNil(previousTask, "Initial start should install a message-loop task")

        viewModel.startMessageLoop()
        let replacementTask = viewModel.messageLoopTask

        XCTAssertNotNil(replacementTask, "Restart should install a replacement task immediately")

        let previousLoopExited = expectation(
            description: "Previous message-loop task exits promptly after synchronous subscription teardown"
        )

        Task {
            await previousTask?.value
            previousLoopExited.fulfill()
        }

        await fulfillment(of: [previousLoopExited], timeout: 1.0)

        XCTAssertNotNil(viewModel.messageLoopTask, "Stale-loop cleanup must not clear the replacement task")
        XCTAssertNotNil(viewModel.messageLoopSubscription, "Replacement subscription should remain installed")

        connectionManager.eventStreamClient.broadcastMessage(
            .assistantTextDelta(
                AssistantTextDeltaMessage(text: "replacement-delta", conversationId: "sess-message-loop")
            )
        )

        try? await Task.sleep(
            nanoseconds: UInt64((ChatViewModel.streamingFlushInterval * 2) * 1_000_000_000)
        )

        let assistantMessages = viewModel.messages.filter { $0.role == .assistant }
        XCTAssertEqual(assistantMessages.count, 1)
        XCTAssertEqual(assistantMessages.first?.text, "replacement-delta")
    }
}
