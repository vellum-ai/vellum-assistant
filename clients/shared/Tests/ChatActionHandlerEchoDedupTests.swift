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
    /// when a surface-action `user_message_echo` (nil messageId) arrives referring
    /// to an already-visible message. The dedup must also suppress the `isThinking`
    /// side effect so the orphan "thinking" indicator does not flash on an
    /// already-visible message.
    ///
    /// Channel-inbound echoes always carry a `messageId` — those are deduped by
    /// the exact-id match earlier in the handler, so this branch is scoped to
    /// nil-messageId surface-action echoes.
    func testChannelConversationDedupsHistoryLoadedUserMessage() {
        viewModel.isChannelConversation = true

        var historyMessage = ChatMessage(role: .user, text: "hello from slack", status: .sent)
        historyMessage.daemonMessageId = "history-id"
        viewModel.messages = [historyMessage]

        viewModel.handleServerMessage(.userMessageEcho(UserMessageEcho(
            type: "user_message_echo",
            text: "hello from slack",
            conversationId: "sess-1",
            messageId: nil,
            requestId: nil
        )))

        XCTAssertEqual(viewModel.messages.count, 1, "Surface-action echo should not append a duplicate user row for a history-loaded channel message")
        XCTAssertFalse(viewModel.isThinking, "isThinking side effect should be suppressed for the dedup-suppressed echo")
    }

    /// Regression test for the duplicate-send case: when a Slack user sends the
    /// same text twice ("hello" then "hello"), both messages arrive as
    /// channel-inbound echoes with different `messageId`s. BOTH must render —
    /// the text-based dedup must not suppress the second arrival just because
    /// the first is now in `vm.messages` with a tagged daemonMessageId.
    ///
    /// Before the fix, the second echo (id-2) would match the first row (id-1,
    /// text="hello", daemonMessageId != nil) on the channel-history-dedup branch
    /// and be suppressed — producing an orphan assistant reply with no visible
    /// user turn.
    func testChannelConversationRendersBothIdenticalTextMessages() {
        viewModel.isChannelConversation = true

        var firstMessage = ChatMessage(role: .user, text: "hello", status: .sent)
        firstMessage.daemonMessageId = "id-1"
        viewModel.messages = [firstMessage]

        viewModel.handleServerMessage(.userMessageEcho(UserMessageEcho(
            type: "user_message_echo",
            text: "hello",
            conversationId: "sess-1",
            messageId: "id-2",
            requestId: nil
        )))

        XCTAssertEqual(viewModel.messages.count, 2, "Second identical-text Slack message must render as its own row")
        XCTAssertEqual(viewModel.messages[0].daemonMessageId, "id-1", "Existing row should retain its original daemonMessageId")
        XCTAssertEqual(viewModel.messages[1].daemonMessageId, "id-2", "New row should be tagged with the echo's messageId")
        XCTAssertTrue(viewModel.isThinking, "Channel-inbound echo should flip isThinking to signal an incoming reply")
    }

    /// Non-channel conversations must keep the pre-existing passive-client
    /// behavior: a nil-messageId surface-action echo appends a new row and flips
    /// the conversation into "reply incoming" state. Guards against over-broad
    /// dedup for the non-channel code path.
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
