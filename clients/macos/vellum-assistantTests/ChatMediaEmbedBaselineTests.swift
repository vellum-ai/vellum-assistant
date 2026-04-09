import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Baseline characterization tests proving the current codebase has no automatic
/// media embed behavior. When a user or assistant message contains a YouTube,
/// Vimeo, Loom, or image URL, the text is rendered as-is — no inline video
/// player, no preview card, no iframe-like embed view is generated.
///
/// These tests lock the pre-embed status quo so that future PRs introducing
/// media embeds can demonstrate the delta.
@MainActor
final class ChatMediaEmbedBaselineTests: XCTestCase {

    private var connectionManager: GatewayConnectionManager!
    private var viewModel: ChatViewModel!

    override func setUp() {
        super.setUp()
        connectionManager = GatewayConnectionManager()
        connectionManager.isConnected = true
        viewModel = ChatViewModel(connectionManager: connectionManager, eventStreamClient: connectionManager.eventStreamClient)
    }

    override func tearDown() {
        viewModel = nil
        connectionManager = nil
        super.tearDown()
    }

    // MARK: - User messages with media URLs remain plain text

    func testUserMessageWithYouTubeLinkIsPlainText() {
        viewModel.conversationId = "sess-1"
        viewModel.inputText = "Check this out: https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        viewModel.sendMessage()

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertEqual(msg.role, .user)
        XCTAssertTrue(msg.text.contains("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
                       "YouTube URL should be preserved verbatim in message text")
        XCTAssertTrue(msg.inlineSurfaces.isEmpty,
                       "No inline surface should be created for a YouTube link")
        XCTAssertTrue(msg.toolCalls.isEmpty,
                       "No tool call should be created for a YouTube link")
        XCTAssertTrue(msg.attachments.isEmpty,
                       "No attachment should be synthesized for a YouTube link")
    }

    func testUserMessageWithVimeoLinkIsPlainText() {
        viewModel.conversationId = "sess-1"
        viewModel.inputText = "Watch: https://vimeo.com/123456789"
        viewModel.sendMessage()

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertEqual(msg.role, .user)
        XCTAssertTrue(msg.text.contains("https://vimeo.com/123456789"),
                       "Vimeo URL should be preserved verbatim in message text")
        XCTAssertTrue(msg.inlineSurfaces.isEmpty,
                       "No inline surface should be created for a Vimeo link")
    }

    func testUserMessageWithLoomLinkIsPlainText() {
        viewModel.conversationId = "sess-1"
        viewModel.inputText = "Here's my recording: https://www.loom.com/share/abc123def456"
        viewModel.sendMessage()

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertEqual(msg.role, .user)
        XCTAssertTrue(msg.text.contains("https://www.loom.com/share/abc123def456"),
                       "Loom URL should be preserved verbatim in message text")
        XCTAssertTrue(msg.inlineSurfaces.isEmpty,
                       "No inline surface should be created for a Loom link")
    }

    func testUserMessageWithImageURLIsPlainText() {
        viewModel.conversationId = "sess-1"
        viewModel.inputText = "Look at this: https://example.com/photo.png"
        viewModel.sendMessage()

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertEqual(msg.role, .user)
        XCTAssertTrue(msg.text.contains("https://example.com/photo.png"),
                       "Image URL should be preserved verbatim in message text")
        XCTAssertTrue(msg.inlineSurfaces.isEmpty,
                       "No inline surface should be created for an image link")
        XCTAssertTrue(msg.attachments.isEmpty,
                       "No attachment should be synthesized from a plain image URL")
    }

    // MARK: - Assistant messages with media URLs remain plain text

    func testAssistantMessageWithYouTubeLinkIsPlainText() {
        let url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        viewModel.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: "Here is a video: \(url)")
        ))
        viewModel.flushStreamingBuffer()

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertEqual(msg.role, .assistant)
        XCTAssertTrue(msg.text.contains(url),
                       "YouTube URL should be preserved verbatim in assistant text")
        XCTAssertTrue(msg.inlineSurfaces.isEmpty,
                       "No inline surface should be auto-created for a YouTube link in assistant message")
        XCTAssertTrue(msg.toolCalls.isEmpty,
                       "No tool call should be synthesized for a YouTube link")
        XCTAssertTrue(msg.attachments.isEmpty,
                       "No attachment should be synthesized for a YouTube link")
    }

    func testAssistantMessageWithVimeoLinkIsPlainText() {
        let url = "https://vimeo.com/987654321"
        viewModel.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: "Check this video: \(url)")
        ))
        viewModel.flushStreamingBuffer()

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertEqual(msg.role, .assistant)
        XCTAssertTrue(msg.text.contains(url),
                       "Vimeo URL should be preserved verbatim in assistant text")
        XCTAssertTrue(msg.inlineSurfaces.isEmpty,
                       "No inline surface should be auto-created for a Vimeo link in assistant message")
    }

    func testAssistantMessageWithLoomLinkIsPlainText() {
        let url = "https://www.loom.com/share/xyz789"
        viewModel.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: "Recording: \(url)")
        ))
        viewModel.flushStreamingBuffer()

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertEqual(msg.role, .assistant)
        XCTAssertTrue(msg.text.contains(url),
                       "Loom URL should be preserved verbatim in assistant text")
        XCTAssertTrue(msg.inlineSurfaces.isEmpty,
                       "No inline surface should be auto-created for a Loom link in assistant message")
    }

    func testAssistantMessageWithImageURLIsPlainText() {
        let url = "https://example.com/chart.jpg"
        viewModel.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: "Here's the chart: \(url)")
        ))
        viewModel.flushStreamingBuffer()

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertEqual(msg.role, .assistant)
        XCTAssertTrue(msg.text.contains(url),
                       "Image URL should be preserved verbatim in assistant text")
        XCTAssertTrue(msg.attachments.isEmpty,
                       "No attachment should be auto-synthesized from a plain image URL in assistant text")
    }

    // MARK: - Multiple media URLs in a single message

    func testAssistantMessageWithMultipleMediaURLsHasNoEmbeds() {
        let text = """
        Here are some resources:
        - YouTube: https://www.youtube.com/watch?v=abc123
        - Vimeo: https://vimeo.com/456789
        - Loom: https://www.loom.com/share/def012
        - Image: https://example.com/diagram.png
        """
        viewModel.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: text)
        ))
        viewModel.flushStreamingBuffer()

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertTrue(msg.inlineSurfaces.isEmpty,
                       "No inline surfaces should be auto-created for any media URLs")
        XCTAssertTrue(msg.attachments.isEmpty,
                       "No attachments should be auto-synthesized from media URLs")
        XCTAssertTrue(msg.toolCalls.isEmpty,
                       "No tool calls should be synthesized for media URLs")
    }

    // MARK: - ChatMessage model has no media embed infrastructure

    func testChatMessageHasNoMediaEmbedProperty() {
        let message = ChatMessage(role: .assistant, text: "https://www.youtube.com/watch?v=test")

        // Verify the message stores the URL as plain text with no special handling
        XCTAssertEqual(message.text, "https://www.youtube.com/watch?v=test")
        XCTAssertTrue(message.inlineSurfaces.isEmpty,
                       "ChatMessage should not have pre-populated inline surfaces for URLs")
        XCTAssertTrue(message.attachments.isEmpty,
                       "ChatMessage should not auto-generate attachments from URL text")
        XCTAssertEqual(message.textSegments, ["https://www.youtube.com/watch?v=test"],
                       "URL should be stored as a single plain text segment")
        XCTAssertEqual(message.contentOrder, [.text(0)],
                       "Content order should only contain the text block — no embed blocks")
    }

    // MARK: - History hydration preserves URLs as plain text

    func testPopulateFromHistoryWithMediaURLsHasNoEmbeds() async {
        let historyItems: [HistoryResponseMessage] = [
            HistoryResponseMessage(
                id: nil,
                role: "assistant",
                text: "Check out https://www.youtube.com/watch?v=abc and https://vimeo.com/123",
                timestamp: 1000,
                toolCalls: nil,
                toolCallsBeforeText: nil,
                attachments: nil,
                textSegments: nil,
                contentOrder: nil,
                surfaces: nil,
                subagentNotification: nil
            ),
        ]

        await viewModel.populateFromHistory(historyItems, hasMore: false)

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertTrue(msg.text.contains("https://www.youtube.com/watch?v=abc"),
                       "YouTube URL should be preserved in history-hydrated message")
        XCTAssertTrue(msg.text.contains("https://vimeo.com/123"),
                       "Vimeo URL should be preserved in history-hydrated message")
        XCTAssertTrue(msg.inlineSurfaces.isEmpty,
                       "No inline surfaces should be auto-created during history hydration")
        XCTAssertTrue(msg.attachments.isEmpty,
                       "No attachments should be auto-synthesized during history hydration")
    }

    // MARK: - Streamed media URLs produce no side-effects

    func testStreamingYouTubeURLProducesNoSideEffects() {
        // Simulate the URL arriving across multiple text deltas (realistic streaming)
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Link: https://www.")))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "youtube.com/watch")))
        viewModel.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "?v=dQw4w9WgXcQ")))
        viewModel.handleServerMessage(.messageComplete(MessageCompleteMessage()))

        XCTAssertEqual(viewModel.messages.count, 1)
        let msg = viewModel.messages[0]
        XCTAssertEqual(msg.text, "Link: https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        XCTAssertTrue(msg.inlineSurfaces.isEmpty,
                       "Streaming a YouTube URL should not trigger auto-embed creation")
        XCTAssertTrue(msg.attachments.isEmpty,
                       "Streaming a YouTube URL should not trigger attachment synthesis")
        XCTAssertFalse(msg.isStreaming,
                        "Message should be finalized after messageComplete")
    }
}
