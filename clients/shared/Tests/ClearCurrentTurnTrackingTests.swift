import XCTest
@testable import VellumAssistantShared

@MainActor
final class ClearCurrentTurnTrackingTests: XCTestCase {

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
        viewModel = nil
        connectionManager = nil
        super.tearDown()
    }

    func testClearsAllTrackingProperties() {
        viewModel.currentAssistantMessageId = UUID()
        viewModel.currentTurnUserText = "hello"
        viewModel.currentAssistantHasText = true

        viewModel.clearCurrentTurnTracking()

        XCTAssertNil(viewModel.currentAssistantMessageId)
        XCTAssertNil(viewModel.currentTurnUserText)
        XCTAssertFalse(viewModel.currentAssistantHasText)
    }

    func testCancelsIdleFallbackTask() {
        viewModel.currentAssistantMessageId = UUID()
        viewModel.scheduleIdleFallbackCleanup()
        XCTAssertNotNil(viewModel.idleFallbackTask, "Precondition: fallback task should be scheduled")

        viewModel.clearCurrentTurnTracking()

        XCTAssertNil(viewModel.idleFallbackTask, "Idle fallback task should be cancelled and nil'd")
    }

    func testIsIdempotent() {
        viewModel.clearCurrentTurnTracking()
        viewModel.clearCurrentTurnTracking()

        XCTAssertNil(viewModel.currentAssistantMessageId)
        XCTAssertNil(viewModel.currentTurnUserText)
        XCTAssertFalse(viewModel.currentAssistantHasText)
        XCTAssertNil(viewModel.idleFallbackTask)
    }

    func testDoesNotAffectOtherTurnState() {
        viewModel.isSending = true
        viewModel.isThinking = true
        viewModel.isCompacting = true
        viewModel.currentAssistantMessageId = UUID()

        viewModel.clearCurrentTurnTracking()

        XCTAssertTrue(viewModel.isSending, "isSending should not be cleared by clearCurrentTurnTracking")
        XCTAssertTrue(viewModel.isCompacting, "isCompacting should not be cleared by clearCurrentTurnTracking")
        // isThinking uses a setter that may schedule/cancel watchdogs, so just verify
        // the method doesn't crash when other turn state is set.
    }

    func testDiscardsStreamingBuffers() {
        // A flush scheduled after the turn is cleared would otherwise either
        // create an orphan message or splice dropped leading chunks into the
        // next turn's response (corrupting inline <thinking> tags on render).
        viewModel.currentAssistantMessageId = UUID()
        viewModel.streamingDeltaBuffer = "buffered text from cancelled turn"
        viewModel.streamingFlushTask = Task { @MainActor in }
        viewModel.thinkingDeltaBuffer = "buffered thinking"
        viewModel.thinkingFlushTask = Task { @MainActor in }

        viewModel.clearCurrentTurnTracking()

        XCTAssertTrue(viewModel.streamingDeltaBuffer.isEmpty,
                      "streamingDeltaBuffer should be discarded")
        XCTAssertNil(viewModel.streamingFlushTask,
                     "streamingFlushTask should be cancelled and nil'd")
        XCTAssertTrue(viewModel.thinkingDeltaBuffer.isEmpty,
                      "thinkingDeltaBuffer should be discarded")
        XCTAssertNil(viewModel.thinkingFlushTask,
                     "thinkingFlushTask should be cancelled and nil'd")
    }
}
