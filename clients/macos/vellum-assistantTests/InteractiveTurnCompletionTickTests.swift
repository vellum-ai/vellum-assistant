import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Coverage for the `task_complete` chime gate. The chime is driven by
/// `interactiveTurnCompletionTick`, which only bumps when a user-typed send
/// from this client is paired with a non-aux non-cancel-ack
/// `message_complete`. Daemon-initiated turns (subagents, schedulers,
/// watchers, opportunity wakes) bump `turnCompletionTick` but must leave
/// the interactive tick untouched so they stay silent.
@MainActor
final class InteractiveTurnCompletionTickTests: XCTestCase {

    private var connectionManager: GatewayConnectionManager!
    private var viewModel: ChatViewModel!

    override func setUp() {
        super.setUp()
        connectionManager = GatewayConnectionManager()
        connectionManager.isConnected = true
        viewModel = ChatViewModel(connectionManager: connectionManager, eventStreamClient: connectionManager.eventStreamClient)
        viewModel.conversationId = "test-conversation"
    }

    override func tearDown() {
        viewModel = nil
        connectionManager = nil
        super.tearDown()
    }

    // MARK: - Counter increments only on user-typed sends

    func testUserSendIncrementsPendingUserTurnCount() {
        XCTAssertEqual(viewModel.messageManager.pendingUserTurnCount, 0)

        viewModel.inputText = "Hello"
        viewModel.sendMessage()

        XCTAssertEqual(viewModel.messageManager.pendingUserTurnCount, 1,
                       "User-typed send should mark a pending interactive turn")
    }

    func testHiddenSendDoesNotIncrementPendingUserTurnCount() {
        viewModel.inputText = "Automated payload"
        viewModel.sendMessage(hidden: true)

        XCTAssertEqual(viewModel.messageManager.pendingUserTurnCount, 0,
                       "Automated/hidden sends are programmatic, not interactive")
    }

    func testRapidUserSendsAccumulatePendingTurns() {
        viewModel.inputText = "First"
        viewModel.sendMessage()
        viewModel.inputText = "Second"
        viewModel.sendMessage()
        viewModel.inputText = "Third"
        viewModel.sendMessage()

        XCTAssertEqual(viewModel.messageManager.pendingUserTurnCount, 3,
                       "Each user-typed send should accumulate so each response chimes")
    }

    // MARK: - message_complete decrements counter and bumps interactive tick

    func testMessageCompleteAfterUserSendBumpsInteractiveTick() {
        viewModel.inputText = "Hello"
        viewModel.sendMessage()
        let beforeTick = viewModel.messageManager.interactiveTurnCompletionTick
        let beforeMainTick = viewModel.messageManager.turnCompletionTick

        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))

        XCTAssertEqual(viewModel.messageManager.pendingUserTurnCount, 0,
                       "Counter should decrement on matching message_complete")
        XCTAssertEqual(viewModel.messageManager.interactiveTurnCompletionTick, beforeTick &+ 1,
                       "Interactive tick should bump for a user-initiated turn end")
        XCTAssertEqual(viewModel.messageManager.turnCompletionTick, beforeMainTick &+ 1,
                       "Main tick should also bump (drives notification path)")
    }

    func testMessageCompleteWithoutPendingSendDoesNotBumpInteractiveTick() {
        // Daemon-initiated turn (e.g. subagent dispatch, scheduled job): no
        // user message preceded it, so the chime must stay silent even
        // though the main tick advances.
        let beforeInteractive = viewModel.messageManager.interactiveTurnCompletionTick
        let beforeMain = viewModel.messageManager.turnCompletionTick

        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))

        XCTAssertEqual(viewModel.messageManager.interactiveTurnCompletionTick, beforeInteractive,
                       "Interactive tick must not bump without a pending user turn")
        XCTAssertEqual(viewModel.messageManager.turnCompletionTick, beforeMain &+ 1,
                       "Main tick still advances so notification-pipeline observers fire")
    }

    func testAuxMessageCompleteDoesNotDecrementCounter() {
        viewModel.inputText = "Hello"
        viewModel.sendMessage()
        XCTAssertEqual(viewModel.messageManager.pendingUserTurnCount, 1)

        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage(source: "aux")))

        XCTAssertEqual(viewModel.messageManager.pendingUserTurnCount, 1,
                       "Auxiliary events (call summaries, watcher ticks) must not consume the pending turn")
    }

    func testTwoUserSendsTwoCompletionsBumpInteractiveTickTwice() {
        viewModel.inputText = "First"
        viewModel.sendMessage()
        viewModel.inputText = "Second"
        viewModel.sendMessage()
        let beforeTick = viewModel.messageManager.interactiveTurnCompletionTick

        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))

        XCTAssertEqual(viewModel.messageManager.pendingUserTurnCount, 0)
        XCTAssertEqual(viewModel.messageManager.interactiveTurnCompletionTick, beforeTick &+ 2,
                       "Each user-send/response pair should produce its own chime")
    }

    // MARK: - Cancellation clears the counter

    func testUserCancelClearsPendingUserTurnCount() {
        viewModel.inputText = "Hello"
        viewModel.sendMessage()
        XCTAssertEqual(viewModel.messageManager.pendingUserTurnCount, 1)

        viewModel.isCancelling = true
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(conversationId: "test-conversation")))

        XCTAssertEqual(viewModel.messageManager.pendingUserTurnCount, 0,
                       "User-initiated cancel acks should clear all pending interactive turns")
    }

    func testCancelAckDoesNotBumpInteractiveTick() {
        viewModel.inputText = "Hello"
        viewModel.sendMessage()
        let beforeTick = viewModel.messageManager.interactiveTurnCompletionTick

        // The daemon's `message_complete` after cancel arrives without a
        // body and is treated as a cancel-ack inside ChatActionHandler.
        viewModel.isCancelling = true
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(conversationId: "test-conversation")))

        XCTAssertEqual(viewModel.messageManager.interactiveTurnCompletionTick, beforeTick,
                       "Cancellation must not chime")
    }

    func testPerMessageDaemonCancelDecrementsCounter() {
        // Daemon-emitted cancel for a queued message that won't reach
        // message_complete. The counter must shrink so the next real
        // completion still aligns with what's actually outstanding.
        viewModel.inputText = "First"
        viewModel.sendMessage()
        viewModel.inputText = "Second"
        viewModel.sendMessage()
        XCTAssertEqual(viewModel.messageManager.pendingUserTurnCount, 2)

        // No `isCancelling = true` — this is a daemon-initiated per-message cancel.
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(conversationId: "test-conversation")))

        XCTAssertEqual(viewModel.messageManager.pendingUserTurnCount, 1,
                       "Per-message daemon cancel should consume one pending interactive turn")
    }
}
