import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Switching conversations must be a pure in-memory operation for any VM in
/// the LRU cache. Returning to a cached conversation must not reload its
/// history or strip its heavy content — both are user-visible regressions
/// (spinners, empty tool-call bubbles).
@MainActor
final class ConversationManagerThreadSwitchCacheTests: XCTestCase {

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

    /// `isHistoryLoaded` gates `ConversationRestorer.loadHistoryIfNeeded` — if
    /// it flips back to `false` on switch-away, re-activation triggers a
    /// blocking `/history` round-trip.
    func testSwitchingAwayPreservesIsHistoryLoaded() {
        let a = makeLoadedConversation(title: "A", conversationId: "session-a")
        let b = makeLoadedConversation(title: "B", conversationId: "session-b")

        conversationManager.selectConversation(id: a.id)
        let vmA = conversationManager.existingChatViewModel(for: a.id)
        XCTAssertEqual(vmA?.isHistoryLoaded, true, "Precondition: A was loaded")

        conversationManager.selectConversation(id: b.id)

        XCTAssertEqual(
            conversationManager.existingChatViewModel(for: a.id)?.isHistoryLoaded,
            true,
            "Switching away from A must not reset its isHistoryLoaded flag"
        )
    }

    /// `stripHeavyContent` empties tool-call results, attachment data, and
    /// inline-surface payloads in place and sets `isContentStripped`. Inactive
    /// cached VMs must not be stripped, or re-activation renders empty bubbles.
    func testSwitchingAwayDoesNotStripMessageContent() {
        let a = makeLoadedConversation(title: "A", conversationId: "session-a")
        let b = makeLoadedConversation(title: "B", conversationId: "session-b")

        guard let vmA = conversationManager.existingChatViewModel(for: a.id) else {
            XCTFail("Expected VM for conversation A")
            return
        }
        var message = ChatMessage(role: .assistant, text: "assistant reply")
        message.daemonMessageId = "msg-1"
        vmA.messages = [message]

        conversationManager.selectConversation(id: a.id)
        conversationManager.selectConversation(id: b.id)

        let retainedA = conversationManager.existingChatViewModel(for: a.id)
        XCTAssertEqual(retainedA?.messages.count, 1)
        XCTAssertEqual(retainedA?.messages.first?.isContentStripped, false,
                       "Switching away must not strip heavy content from cached messages")
        XCTAssertEqual(retainedA?.messages.first?.text, "assistant reply",
                       "Message content should be preserved across switches")
    }

    /// Rapid round-tripping is the common user motion (skimming between two
    /// threads). Both VMs must retain `isHistoryLoaded` throughout.
    func testRapidRoundTripPreservesBothConversations() {
        let a = makeLoadedConversation(title: "A", conversationId: "session-a")
        let b = makeLoadedConversation(title: "B", conversationId: "session-b")

        for _ in 0..<5 {
            conversationManager.selectConversation(id: a.id)
            conversationManager.selectConversation(id: b.id)
        }

        XCTAssertEqual(
            conversationManager.existingChatViewModel(for: a.id)?.isHistoryLoaded,
            true
        )
        XCTAssertEqual(
            conversationManager.existingChatViewModel(for: b.id)?.isHistoryLoaded,
            true
        )
    }

    // MARK: - Helpers

    /// Install a conversation with a VM pre-flagged as if `populateFromHistory`
    /// had already completed — skips network bootstrap in tests.
    @discardableResult
    private func makeLoadedConversation(title: String, conversationId: String) -> ConversationModel {
        let conversation = ConversationModel(title: title, conversationId: conversationId)
        let viewModel = conversationManager.makeViewModel()
        viewModel.conversationId = conversationId
        viewModel.isHistoryLoaded = true
        conversationManager.conversations.append(conversation)
        conversationManager.setChatViewModel(viewModel, for: conversation.id)
        return conversation
    }
}
