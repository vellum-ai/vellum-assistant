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
    /// post-compaction token counts that drive the UI ring.
    func testContextCompactedServerMessageDecodes() throws {
        let json = """
        {
          "type": "context_compacted",
          "previousEstimatedInputTokens": 180000,
          "estimatedInputTokens": 80000,
          "maxInputTokens": 200000,
          "thresholdTokens": 160000,
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
        XCTAssertEqual(event.estimatedInputTokens, 80_000)
        XCTAssertEqual(event.maxInputTokens, 200_000)
        XCTAssertEqual(event.previousEstimatedInputTokens, 180_000)
    }

    /// Dispatch: feeding a `.contextCompacted` event through the chat action
    /// handler must update `contextWindowTokens` to the post-compaction value
    /// and leave `contextWindowMaxTokens` at the existing max. This is what
    /// makes the context-window indicator shrink immediately after
    /// compaction instead of waiting for the next full turn's usage_update.
    func testContextCompactedUpdatesContextWindowTokens() {
        viewModel.contextWindowTokens = 180_000
        viewModel.contextWindowMaxTokens = 200_000

        let event = ContextCompacted(
            type: "context_compacted",
            previousEstimatedInputTokens: 180_000,
            estimatedInputTokens: 80_000,
            maxInputTokens: 200_000,
            thresholdTokens: 160_000,
            compactedMessages: 12,
            summaryCalls: 1,
            summaryInputTokens: 15_000,
            summaryOutputTokens: 2_000,
            summaryModel: "claude-sonnet"
        )

        viewModel.handleServerMessage(.contextCompacted(event))

        XCTAssertEqual(viewModel.contextWindowTokens, 80_000, "Post-compaction estimated input tokens should overwrite contextWindowTokens")
        XCTAssertEqual(viewModel.contextWindowMaxTokens, 200_000, "contextWindowMaxTokens should be set from the event's maxInputTokens")
    }
}
