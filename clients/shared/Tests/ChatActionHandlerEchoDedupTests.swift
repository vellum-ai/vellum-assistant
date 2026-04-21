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

    /// Echo carrying a matching `clientMessageId` should bind the optimistic
    /// row's `daemonMessageId` and NOT append a duplicate. This is the
    /// happy-path race-free dedup on the originating client.
    func testEchoWithMatchingClientMessageIdTagsOptimisticRow() {
        let nonce = "client-nonce-1"
        var optimistic = ChatMessage(role: .user, text: "hello", status: .sent)
        optimistic.clientMessageId = nonce
        optimistic.daemonMessageId = "daemon-1"
        viewModel.messages = [optimistic]

        viewModel.handleServerMessage(.userMessageEcho(UserMessageEcho(
            type: "user_message_echo",
            text: "hello",
            conversationId: "sess-1",
            messageId: "daemon-1",
            requestId: nil,
            clientMessageId: nonce
        )))

        XCTAssertEqual(viewModel.messages.count, 1, "Echo with matching clientMessageId must not append a duplicate row")
        XCTAssertEqual(viewModel.messages[0].daemonMessageId, "daemon-1")
        XCTAssertEqual(viewModel.messages[0].clientMessageId, nonce)
    }

    /// Echo may arrive before the HTTP 202 response binds `daemonMessageId`.
    /// The optimistic row carries only the client-generated nonce; the echo
    /// must still bind it via `clientMessageId` and stamp the daemon id.
    func testEchoBefore202TagsOptimisticRowByClientMessageId() {
        let nonce = "client-nonce-2"
        var optimistic = ChatMessage(role: .user, text: "hi", status: .sent)
        optimistic.clientMessageId = nonce
        // daemonMessageId intentionally nil: 202 has not landed yet.
        viewModel.messages = [optimistic]

        viewModel.handleServerMessage(.userMessageEcho(UserMessageEcho(
            type: "user_message_echo",
            text: "hi",
            conversationId: "sess-1",
            messageId: "daemon-2",
            requestId: nil,
            clientMessageId: nonce
        )))

        XCTAssertEqual(viewModel.messages.count, 1, "Pre-202 echo must not duplicate the optimistic row")
        XCTAssertEqual(viewModel.messages[0].daemonMessageId, "daemon-2", "Echo should stamp the daemonMessageId on the matched optimistic row")
        XCTAssertEqual(viewModel.messages[0].clientMessageId, nonce)
    }

    /// Two sends of the same text with different client-generated nonces must
    /// dedup independently. The text-matching fallback would collapse these;
    /// clientMessageId keys each optimistic row uniquely.
    func testDuplicateTextWithDistinctNoncesDedupesIndependently() {
        let nonceA = "client-nonce-A"
        let nonceB = "client-nonce-B"
        var first = ChatMessage(role: .user, text: "ping", status: .sent)
        first.clientMessageId = nonceA
        var second = ChatMessage(role: .user, text: "ping", status: .sent)
        second.clientMessageId = nonceB
        viewModel.messages = [first, second]

        viewModel.handleServerMessage(.userMessageEcho(UserMessageEcho(
            type: "user_message_echo",
            text: "ping",
            conversationId: "sess-1",
            messageId: "daemon-A",
            requestId: nil,
            clientMessageId: nonceA
        )))
        viewModel.handleServerMessage(.userMessageEcho(UserMessageEcho(
            type: "user_message_echo",
            text: "ping",
            conversationId: "sess-1",
            messageId: "daemon-B",
            requestId: nil,
            clientMessageId: nonceB
        )))

        XCTAssertEqual(viewModel.messages.count, 2, "Distinct-nonce echoes must not collapse into each other")
        XCTAssertEqual(viewModel.messages[0].daemonMessageId, "daemon-A")
        XCTAssertEqual(viewModel.messages[1].daemonMessageId, "daemon-B")
    }

    /// A passive client (did not originate the send) has no optimistic row to
    /// match against. The echo must append a new row and flip "reply incoming"
    /// state so the assistant turn can render.
    func testPassiveClientAppendsEcho() {
        viewModel.messages = []

        viewModel.handleServerMessage(.userMessageEcho(UserMessageEcho(
            type: "user_message_echo",
            text: "from another device",
            conversationId: "sess-1",
            messageId: "daemon-3",
            requestId: nil,
            clientMessageId: "some-other-clients-nonce"
        )))

        XCTAssertEqual(viewModel.messages.count, 1, "Passive client with no matching nonce must append a new user row")
        XCTAssertEqual(viewModel.messages[0].text, "from another device")
        XCTAssertEqual(viewModel.messages[0].daemonMessageId, "daemon-3")
        XCTAssertTrue(viewModel.isSending)
        XCTAssertTrue(viewModel.isThinking)
    }

    /// Back-compat: an old server that does not echo `clientMessageId` still
    /// produces a correct result. When the optimistic row is already tagged
    /// with the echoed `daemonMessageId` (202 landed first), the secondary
    /// dedup suppresses the append. When nothing matches, the echo appends
    /// like a passive client.
    func testBackCompatEchoWithoutClientMessageId() {
        var optimistic = ChatMessage(role: .user, text: "legacy", status: .sent)
        optimistic.clientMessageId = "client-nonce-C"
        optimistic.daemonMessageId = "daemon-4"
        viewModel.messages = [optimistic]

        viewModel.handleServerMessage(.userMessageEcho(UserMessageEcho(
            type: "user_message_echo",
            text: "legacy",
            conversationId: "sess-1",
            messageId: "daemon-4",
            requestId: nil,
            clientMessageId: nil
        )))

        XCTAssertEqual(viewModel.messages.count, 1, "Back-compat echo whose daemonMessageId matches should fall through to secondary dedup and not duplicate")

        viewModel.handleServerMessage(.userMessageEcho(UserMessageEcho(
            type: "user_message_echo",
            text: "unrelated",
            conversationId: "sess-1",
            messageId: "daemon-5",
            requestId: nil,
            clientMessageId: nil
        )))

        XCTAssertEqual(viewModel.messages.count, 2, "Back-compat echo with no matching optimistic row should append a new row")
        XCTAssertEqual(viewModel.messages[1].text, "unrelated")
        XCTAssertEqual(viewModel.messages[1].daemonMessageId, "daemon-5")
        XCTAssertTrue(viewModel.isThinking)
    }
}
