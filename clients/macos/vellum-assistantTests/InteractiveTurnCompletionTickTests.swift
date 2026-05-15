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

    func testStaleCancelEchoDoesNotConsumeNewSendTurnCount() {
        // Repro for the regression: after a user cancel-batch, the daemon
        // emits one `generation_cancelled` per cancelled queue entry. The
        // first arrives with `isCancelling = true`; subsequent echoes
        // arrive with `isCancelling = false`. If a new user send is
        // dispatched after the batch (e.g. via `dispatchPendingSendDirect`),
        // those late echoes must not consume the new turn's count — the
        // matching `message_complete` for the new send must still bump
        // `interactiveTurnCompletionTick`.
        viewModel.inputText = "First"
        viewModel.sendMessage()
        // Simulate the daemon having queued 2 items behind the in-flight.
        // `pendingQueuedCount` reflects only still-queued entries (the
        // in-flight already triggered `message_dequeued`, which also
        // populates `activeRequestIdToMessageId`). The cancel batch emits
        // 3 events total — 1 for the in-flight (handled by the first
        // event) and 2 trailing echoes for the queued items.
        viewModel.activeRequestIdToMessageId["req-in-flight"] = UUID()
        viewModel.pendingQueuedCount = 2

        // User cancels; daemon emits 3 `generation_cancelled` events. The
        // first carries `isCancelling = true` and runs the batch reset.
        viewModel.isCancelling = true
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(conversationId: "test-conversation")))
        XCTAssertEqual(viewModel.messageManager.pendingUserTurnCount, 0)
        XCTAssertEqual(viewModel.messageManager.staleCancelEventsExpected, 2,
                       "Two trailing echoes should be expected after the batch reset")

        // User starts a new send before the stale echoes arrive.
        viewModel.inputText = "Second"
        viewModel.sendMessage()
        XCTAssertEqual(viewModel.messageManager.pendingUserTurnCount, 1)

        // Two stale echoes arrive with `isCancelling = false`. Neither
        // should decrement the new send's pending turn count.
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(conversationId: "test-conversation")))
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(conversationId: "test-conversation")))

        XCTAssertEqual(viewModel.messageManager.pendingUserTurnCount, 1,
                       "Stale cancel echoes from a prior batch must not consume the new send's count")
        XCTAssertEqual(viewModel.messageManager.staleCancelEventsExpected, 0,
                       "Stale-echo budget should drain to zero after both echoes")

        // `message_complete` for the new send should still bump the tick.
        let beforeTick = viewModel.messageManager.interactiveTurnCompletionTick
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))
        XCTAssertEqual(viewModel.messageManager.interactiveTurnCompletionTick, beforeTick &+ 1,
                       "New send's completion must still bump the interactive tick")
    }

    func testCancelWhileNewestSendStillQueuedDoesNotOvercountBudget() {
        // Codex P2: user sends, `message_queued` arrives, user cancels
        // before `message_dequeued` is processed. There is no dequeued
        // in-flight request — the cancel batch contains only the queued
        // item. The daemon emits exactly one `generation_cancelled`
        // (consumed by the `wasCancelling = true` branch); no trailing
        // echoes follow. The stale-echo budget must therefore be 0, not
        // `pendingQueuedCount` (which would leave 1 stuck and silently
        // absorb the next legitimate per-message daemon cancel).
        viewModel.inputText = "First"
        viewModel.sendMessage()
        // Nothing has been dequeued: `activeRequestIdToMessageId` is empty
        // and `pendingQueuedCount` includes the not-yet-dequeued send.
        XCTAssertTrue(viewModel.activeRequestIdToMessageId.isEmpty)
        viewModel.pendingQueuedCount = 1

        viewModel.isCancelling = true
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(conversationId: "test-conversation")))

        XCTAssertEqual(viewModel.messageManager.staleCancelEventsExpected, 0,
                       "No dequeued in-flight means no trailing echoes; budget must be 0 to avoid overcount")

        // Confirm a subsequent legitimate per-message daemon cancel for a
        // new send is not silently absorbed by leftover budget.
        viewModel.inputText = "Second"
        viewModel.sendMessage()
        XCTAssertEqual(viewModel.messageManager.pendingUserTurnCount, 1)
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(conversationId: "test-conversation")))
        XCTAssertEqual(viewModel.messageManager.pendingUserTurnCount, 0,
                       "Per-message daemon cancel must decrement the new send's count, not drain stale budget")
    }

    func testMessageCompleteForNewSendDrainsResidualBudgetFromEchoLoss() {
        // Devin: if the daemon emits fewer trailing `generation_cancelled`
        // echoes than primed (echo loss without a full stream disconnect),
        // `staleCancelEventsExpected` would otherwise remain positive
        // until the watchdog timeout. During that window, any legitimate
        // per-message daemon cancel would silently drain the stale budget
        // instead of decrementing `pendingUserTurnCount`. The fix: a real
        // `message_complete` for a new send clears the budget, since it
        // implies the prior cancel batch is fully resolved.
        viewModel.inputText = "First"
        viewModel.sendMessage()
        viewModel.activeRequestIdToMessageId["req-in-flight"] = UUID()
        viewModel.pendingQueuedCount = 2

        viewModel.isCancelling = true
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(conversationId: "test-conversation")))
        XCTAssertEqual(viewModel.messageManager.staleCancelEventsExpected, 2)

        // User dispatches a new send; only one trailing echo arrives (the
        // other was dropped). Without the drain, residual budget = 1.
        viewModel.inputText = "Second"
        viewModel.sendMessage()
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(conversationId: "test-conversation")))
        XCTAssertEqual(viewModel.messageManager.staleCancelEventsExpected, 1,
                       "Echo loss left residual budget; setup confirms preconditions for the drain")

        // `message_complete` for the new send must zero the residual.
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))
        XCTAssertEqual(viewModel.messageManager.staleCancelEventsExpected, 0,
                       "message_complete for a new send must drain residual budget from echo loss")

        // A subsequent per-message daemon cancel for a third send must
        // now decrement `pendingUserTurnCount` instead of being absorbed.
        viewModel.inputText = "Third"
        viewModel.sendMessage()
        XCTAssertEqual(viewModel.messageManager.pendingUserTurnCount, 1)
        viewModel.handleServerMessage(.generationCancelled(GenerationCancelledMessage(conversationId: "test-conversation")))
        XCTAssertEqual(viewModel.messageManager.pendingUserTurnCount, 0,
                       "Without leftover budget, the daemon cancel decrements as intended")
    }
}
