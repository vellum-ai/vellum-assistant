import XCTest
@testable import VellumAssistantShared

@MainActor
final class ChatActionHandlerEchoDedupTests: XCTestCase {

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

    /// A channel user message already loaded from history should not be duplicated
    /// when a `user_message_echo` arrives carrying a different `messageId` shape.
    /// The dedup must also suppress the `isThinking` side effect so the orphan
    /// "thinking" indicator does not flash on an already-visible message.
    func testChannelConversationDedupsHistoryLoadedUserMessage() {
        viewModel.isChannelConversation = true

        var historyMessage = ChatMessage(role: .user, text: "hello from slack", status: .sent)
        historyMessage.daemonMessageId = "history-id"
        viewModel.messages = [historyMessage]

        viewModel.handleServerMessage(.userMessageEcho(UserMessageEcho(
            type: "user_message_echo",
            text: "hello from slack",
            conversationId: "sess-1",
            messageId: "echo-id",
            requestId: nil
        )))

        XCTAssertEqual(viewModel.messages.count, 1, "Echo should not append a duplicate user row for a history-loaded channel message")
        XCTAssertFalse(viewModel.isThinking, "isThinking side effect should be suppressed for the dedup-suppressed echo")
    }

    /// Non-channel conversations must keep the pre-existing passive-client
    /// behavior: the echo appends a new row and flips the conversation into
    /// "reply incoming" state. Guards against over-broad dedup.
    func testNonChannelConversationAppendsEchoNormally() {
        viewModel.isChannelConversation = false

        var historyMessage = ChatMessage(role: .user, text: "hello from slack", status: .sent)
        historyMessage.daemonMessageId = "history-id"
        viewModel.messages = [historyMessage]

        viewModel.handleServerMessage(.userMessageEcho(UserMessageEcho(
            type: "user_message_echo",
            text: "hello from slack",
            conversationId: "sess-1",
            messageId: "echo-id",
            requestId: nil
        )))

        XCTAssertEqual(viewModel.messages.count, 2, "Non-channel conversations should still append the echo as a new row")
        XCTAssertTrue(viewModel.isThinking, "Non-channel echo should flip isThinking to signal an incoming reply")
    }

    /// Channel conversations with no matching history row must still accept
    /// a legitimate first-arrival echo. Guards against blocking first arrivals
    /// when the user opens the desktop app after Slack activity and the echo
    /// outpaces the history fetch.
    func testChannelConversationAppendsFirstArrivalEcho() {
        viewModel.isChannelConversation = true
        viewModel.messages = []

        viewModel.handleServerMessage(.userMessageEcho(UserMessageEcho(
            type: "user_message_echo",
            text: "hello from slack",
            conversationId: "sess-1",
            messageId: "echo-id",
            requestId: nil
        )))

        XCTAssertEqual(viewModel.messages.count, 1, "First-arrival echo should append a new user row when no history row matches")
        XCTAssertEqual(viewModel.messages[0].daemonMessageId, "echo-id", "Appended row should carry the echo's messageId")
    }
}
