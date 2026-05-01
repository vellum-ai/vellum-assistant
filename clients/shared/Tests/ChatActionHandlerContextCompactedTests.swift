import XCTest
@testable import VellumAssistantShared

@MainActor
final class ChatActionHandlerContextCompactedTests: XCTestCase {

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

    /// Decoding: a `context_compacted` JSON payload must decode through
    /// `ServerMessage` as the `.contextCompacted` case and preserve the
    /// post-compaction token counts that drive the UI ring. `maxInputTokens`
    /// is the assistant-resolved effective budget for this conversation, not
    /// the selected model's global catalog maximum.
    func testContextCompactedServerMessageDecodes() throws {
        let json = """
        {
          "type": "context_compacted",
          "conversationId": "sess-1",
          "previousEstimatedInputTokens": 140000,
          "estimatedInputTokens": 80000,
          "maxInputTokens": 150000,
          "thresholdTokens": 120000,
          "compactedMessages": 12,
          "summaryCalls": 1,
          "summaryInputTokens": 15000,
          "summaryOutputTokens": 2000,
          "summaryModel": "claude-sonnet"
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(ServerMessage.self, from: json)
        guard case .contextCompacted(let event) = decoded else {
            XCTFail("Expected .contextCompacted, got \(decoded)")
            return
        }
        XCTAssertEqual(event.conversationId, "sess-1")
        XCTAssertEqual(event.estimatedInputTokens, 80_000)
        XCTAssertEqual(event.maxInputTokens, 150_000)
        XCTAssertEqual(event.previousEstimatedInputTokens, 140_000)
    }

    /// Dispatch: `usage_update.contextWindowMaxTokens` is already the
    /// effective current conversation budget resolved by the assistant. The
    /// client must preserve that value instead of substituting a model catalog
    /// maximum such as 200k.
    func testUsageUpdateUsesEffectiveConversationBudgetFromEvent() {
        viewModel.handleServerMessage(.usageUpdate(UsageUpdate(
            type: "usage_update",
            conversationId: "sess-1",
            inputTokens: 4_000,
            outputTokens: 700,
            totalInputTokens: 30_000,
            totalOutputTokens: 2_000,
            estimatedCost: 0.42,
            model: "gpt-5.5",
            contextWindowTokens: 50_000,
            contextWindowMaxTokens: 150_000
        )))

        XCTAssertEqual(viewModel.contextWindowTokens, 50_000)
        XCTAssertEqual(viewModel.contextWindowMaxTokens, 150_000)
        XCTAssertEqual(viewModel.contextWindowFillRatio, Double(50_000) / Double(150_000))
    }

    /// Dispatch: feeding a `.contextCompacted` event through the chat action
    /// handler must update `contextWindowTokens` to the post-compaction value
    /// and replace `contextWindowMaxTokens` with the event's effective
    /// conversation budget. This is what makes the context-window indicator
    /// shrink immediately after compaction instead of waiting for the next
    /// full turn's usage_update.
    func testContextCompactedUpdatesContextWindowTokensAndEffectiveMax() {
        viewModel.contextWindowTokens = 180_000
        viewModel.contextWindowMaxTokens = 200_000

        let event = ContextCompacted(
            type: "context_compacted",
            conversationId: "sess-1",
            previousEstimatedInputTokens: 180_000,
            estimatedInputTokens: 80_000,
            maxInputTokens: 150_000,
            thresholdTokens: 120_000,
            compactedMessages: 12,
            summaryCalls: 1,
            summaryInputTokens: 15_000,
            summaryOutputTokens: 2_000,
            summaryModel: "claude-sonnet"
        )

        viewModel.handleServerMessage(.contextCompacted(event))

        XCTAssertEqual(viewModel.contextWindowTokens, 80_000, "Post-compaction estimated input tokens should overwrite contextWindowTokens")
        XCTAssertEqual(viewModel.contextWindowMaxTokens, 150_000, "contextWindowMaxTokens should be set from the event's maxInputTokens")
    }

    /// `EventStreamClient` broadcasts every parsed server message to all
    /// subscribers, so the handler MUST ignore events whose `conversationId`
    /// does not match this VM. Otherwise a compaction in one conversation
    /// would overwrite the context-window indicator on every open chat.
    func testActionHandlerIgnoresEventsFromOtherConversations() {
        viewModel.contextWindowTokens = 42_000
        viewModel.contextWindowMaxTokens = 200_000

        // Event for a different conversation — the VM should not mutate.
        viewModel.handleServerMessage(.contextCompacted(ContextCompacted(
            type: "context_compacted",
            conversationId: "sess-other",
            previousEstimatedInputTokens: 180_000,
            estimatedInputTokens: 80_000,
            maxInputTokens: 200_000,
            thresholdTokens: 160_000,
            compactedMessages: 12,
            summaryCalls: 1,
            summaryInputTokens: 15_000,
            summaryOutputTokens: 2_000,
            summaryModel: "claude-sonnet"
        )))

        XCTAssertEqual(viewModel.contextWindowTokens, 42_000, "Indicator must not be mutated by compactions from sibling conversations")
        XCTAssertEqual(viewModel.contextWindowMaxTokens, 200_000)
    }
}
