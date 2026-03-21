import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ConversationManagerBusyStateTests: XCTestCase {

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

    // MARK: - Busy state derivation

    func testBusyFalseByDefault() {
        // init creates a default conversation
        let conversationId = conversationManager.activeConversationId!
        XCTAssertFalse(conversationManager.isConversationBusy(conversationId), "Conversation should not be busy by default")
        XCTAssertTrue(conversationManager.busyConversationIds.isEmpty)
    }

    func testBusyTrueWhenIsSending() {
        let conversationId = conversationManager.activeConversationId!
        let vm = conversationManager.activeViewModel!
        vm.isSending = true

        // Allow Combine pipeline to deliver
        let exp = expectation(description: "busy state propagates")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { exp.fulfill() }
        wait(for: [exp], timeout: 1.0)

        XCTAssertTrue(conversationManager.isConversationBusy(conversationId), "Conversation should be busy when isSending is true")
    }

    func testBusyTrueWhenIsThinking() {
        let conversationId = conversationManager.activeConversationId!
        let vm = conversationManager.activeViewModel!
        vm.isThinking = true

        let exp = expectation(description: "busy state propagates")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { exp.fulfill() }
        wait(for: [exp], timeout: 1.0)

        XCTAssertTrue(conversationManager.isConversationBusy(conversationId), "Conversation should be busy when isThinking is true")
    }

    func testBusyTrueWhenPendingQueuedCountPositive() {
        let conversationId = conversationManager.activeConversationId!
        let vm = conversationManager.activeViewModel!
        vm.pendingQueuedCount = 3

        let exp = expectation(description: "busy state propagates")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { exp.fulfill() }
        wait(for: [exp], timeout: 1.0)

        XCTAssertTrue(conversationManager.isConversationBusy(conversationId), "Conversation should be busy when pendingQueuedCount > 0")
    }

    func testBusyFalseAfterAllReturnToIdle() {
        let conversationId = conversationManager.activeConversationId!
        let vm = conversationManager.activeViewModel!

        // Set busy
        vm.isSending = true
        vm.isThinking = true
        vm.pendingQueuedCount = 1

        let expBusy = expectation(description: "busy state set")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { expBusy.fulfill() }
        wait(for: [expBusy], timeout: 1.0)
        XCTAssertTrue(conversationManager.isConversationBusy(conversationId))

        // Return to idle
        vm.isSending = false
        vm.isThinking = false
        vm.pendingQueuedCount = 0

        let expIdle = expectation(description: "idle state propagates")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { expIdle.fulfill() }
        wait(for: [expIdle], timeout: 1.0)

        XCTAssertFalse(conversationManager.isConversationBusy(conversationId), "Conversation should not be busy after all states return to idle")
        XCTAssertTrue(conversationManager.busyConversationIds.isEmpty)
    }

    func testLRUEvictionSkipsBusyBackgroundConversation() {
        guard let originalConversationId = conversationManager.activeConversationId else {
            XCTFail("Expected initial active conversation")
            return
        }

        for _ in 0..<9 {
            conversationManager.activeViewModel?.messages.append(ChatMessage(role: .user, text: "seed"))
            conversationManager.createConversation()
        }

        guard let busyVm = conversationManager.existingChatViewModel(for: originalConversationId) else {
            XCTFail("Expected original conversation view model")
            return
        }
        busyVm.isSending = true

        let expBusy = expectation(description: "busy conversation marked")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { expBusy.fulfill() }
        wait(for: [expBusy], timeout: 1.0)
        XCTAssertTrue(conversationManager.isConversationBusy(originalConversationId))

        // Trigger one more creation to force an LRU eviction pass.
        conversationManager.activeViewModel?.messages.append(ChatMessage(role: .user, text: "seed"))
        conversationManager.createConversation()

        let expEvict = expectation(description: "eviction pass complete")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { expEvict.fulfill() }
        wait(for: [expEvict], timeout: 1.0)

        XCTAssertNotNil(conversationManager.existingChatViewModel(for: originalConversationId), "Busy conversation should not be evicted")
        XCTAssertTrue(conversationManager.isConversationBusy(originalConversationId), "Busy state should be preserved after eviction pass")
    }
}
