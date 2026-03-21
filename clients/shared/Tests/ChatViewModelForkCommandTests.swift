import XCTest
@testable import VellumAssistantShared

@MainActor
final class ChatViewModelForkCommandTests: XCTestCase {

    private var daemonClient: GatewayConnectionManager!
    private var viewModel: ChatViewModel!

    override func setUp() {
        super.setUp()
        daemonClient = GatewayConnectionManager()
        daemonClient.isConnected = true
        viewModel = ChatViewModel(daemonClient: daemonClient, eventStreamClient: daemonClient.eventStreamClient)
        viewModel.conversationId = "sess-1"
    }

    override func tearDown() {
        viewModel = nil
        daemonClient = nil
        super.tearDown()
    }

    func testExactForkUsesLocalHandlerWithoutTranscriptArtifact() {
        var forkCount = 0
        var sentCount = 0
        viewModel.onFork = { forkCount += 1 }
        viewModel.onUserMessageSent = { sentCount += 1 }
        viewModel.inputText = "/fork"

        viewModel.sendMessage()

        XCTAssertEqual(forkCount, 1)
        XCTAssertEqual(sentCount, 0)
        XCTAssertEqual(viewModel.inputText, "")
        XCTAssertTrue(viewModel.messages.isEmpty)
    }

    func testExactForkWithoutHandlerShowsLocalErrorAndNeverSendsUpstream() {
        viewModel.inputText = "/fork"

        viewModel.sendMessage()

        XCTAssertEqual(viewModel.inputText, "")
        XCTAssertEqual(viewModel.errorText, "Send a message before forking this conversation.")
        XCTAssertTrue(viewModel.messages.isEmpty)
    }

    func testForkWithArgumentsStaysOnNormalSendPath() {
        var forkCount = 0
        viewModel.onFork = { forkCount += 1 }
        viewModel.inputText = "/fork this branch"

        viewModel.sendMessage()

        XCTAssertEqual(forkCount, 0)
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].text, "/fork this branch")
        // Note: verifying the message was sent upstream requires a mock EventStreamClient
    }

    func testForkWithAttachmentStaysOnNormalSendPath() {
        var forkCount = 0
        viewModel.onFork = { forkCount += 1 }
        viewModel.pendingAttachments = [makeAttachment()]
        viewModel.inputText = "/fork"

        viewModel.sendMessage()

        XCTAssertEqual(forkCount, 0)
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].text, "/fork")
        XCTAssertEqual(viewModel.messages[0].attachments.count, 1)
        // Note: verifying the message was sent upstream requires a mock EventStreamClient
    }

    func testForkWithPendingSkillInvocationStaysOnNormalSendPath() {
        var forkCount = 0
        viewModel.onFork = { forkCount += 1 }
        viewModel.pendingSkillInvocation = SkillInvocationData(
            name: "planner",
            emoji: nil,
            description: "Plan the next step"
        )
        viewModel.inputText = "/fork"

        viewModel.sendMessage()

        XCTAssertEqual(forkCount, 0)
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].text, "/fork")
        XCTAssertEqual(viewModel.messages[0].skillInvocation?.name, "planner")
        // Note: verifying the message was sent upstream requires a mock EventStreamClient
    }

    func testBtwStillUsesExistingLocalSidechainPath() {
        viewModel.onFork = {}
        viewModel.inputText = "/btw what changed?"

        viewModel.sendMessage()

        XCTAssertEqual(viewModel.inputText, "")
        XCTAssertTrue(viewModel.messages.isEmpty)
        XCTAssertTrue(viewModel.btwLoading)
        XCTAssertEqual(viewModel.btwResponse, "")
    }

    func testGenericSlashCommandStillSendsNormallyWithForkHandler() {
        viewModel.onFork = {}
        viewModel.inputText = "/foo"

        viewModel.sendMessage()

        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].text, "/foo")
        // Note: verifying the message was sent upstream requires a mock EventStreamClient
    }

    func testMessageBubbleForkActionRequiresPersistedNonStreamingMessage() {
        let persistedMessage = makeMessage(daemonMessageId: "msg-1", isStreaming: false)
        let localOnlyMessage = makeMessage(daemonMessageId: nil, isStreaming: false)
        let streamingMessage = makeMessage(daemonMessageId: "msg-2", isStreaming: true)

        let persistedView = MessageBubbleView(
            message: persistedMessage,
            onConfirmationResponse: nil,
            onSurfaceAction: nil,
            onRegenerate: nil,
            onForkFromMessage: { _ in }
        )
        let localOnlyView = MessageBubbleView(
            message: localOnlyMessage,
            onConfirmationResponse: nil,
            onSurfaceAction: nil,
            onRegenerate: nil,
            onForkFromMessage: { _ in }
        )
        let streamingView = MessageBubbleView(
            message: streamingMessage,
            onConfirmationResponse: nil,
            onSurfaceAction: nil,
            onRegenerate: nil,
            onForkFromMessage: { _ in }
        )
        let missingCallbackView = MessageBubbleView(
            message: persistedMessage,
            onConfirmationResponse: nil,
            onSurfaceAction: nil,
            onRegenerate: nil
        )

        XCTAssertTrue(persistedView.canForkFromMessage)
        XCTAssertFalse(localOnlyView.canForkFromMessage)
        XCTAssertFalse(streamingView.canForkFromMessage)
        XCTAssertFalse(missingCallbackView.canForkFromMessage)
    }

    private func makeMessage(daemonMessageId: String?, isStreaming: Bool) -> ChatMessage {
        var message = ChatMessage(role: .assistant, text: "Persisted reply", isStreaming: isStreaming)
        message.daemonMessageId = daemonMessageId
        return message
    }

    private func makeAttachment() -> ChatAttachment {
        #if os(macOS)
        ChatAttachment(
            id: "attachment-1",
            filename: "note.txt",
            mimeType: "text/plain",
            data: "ZGF0YQ==",
            thumbnailData: nil,
            dataLength: 8,
            thumbnailImage: nil
        )
        #elseif os(iOS)
        ChatAttachment(
            id: "attachment-1",
            filename: "note.txt",
            mimeType: "text/plain",
            data: "ZGF0YQ==",
            thumbnailData: nil,
            dataLength: 8,
            thumbnailImage: nil
        )
        #else
        fatalError("Unsupported platform")
        #endif
    }
}
