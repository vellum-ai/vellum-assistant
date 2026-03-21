import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
private final class MockConversationForkClient: ConversationForkClientProtocol {
    var result: ConversationListResponseItem?
    var capturedConversationIds: [String] = []
    var capturedMessageIds: [String?] = []
    var onFork: (() -> Void)?

    func forkConversation(conversationId: String, throughMessageId: String?) async -> ConversationListResponseItem? {
        capturedConversationIds.append(conversationId)
        capturedMessageIds.append(throughMessageId)
        onFork?()
        return result
    }
}

@MainActor
private final class MockConversationDetailClient: ConversationDetailClientProtocol {
    var result: ConversationListResponseItem?
    var fetchedConversationIds: [String] = []

    func fetchConversation(conversationId: String) async -> ConversationListResponseItem? {
        fetchedConversationIds.append(conversationId)
        return result
    }
}

@MainActor
final class ConversationManagerForkTests: XCTestCase {

    private var daemonClient: GatewayConnectionManager!
    private var conversationManager: ConversationManager!
    private var forkClient: MockConversationForkClient!
    private var detailClient: MockConversationDetailClient!

    override func setUp() {
        super.setUp()
        daemonClient = GatewayConnectionManager()
        daemonClient.isConnected = true
        forkClient = MockConversationForkClient()
        detailClient = MockConversationDetailClient()
        conversationManager = ConversationManager(
            daemonClient: daemonClient,
            eventStreamClient: daemonClient.eventStreamClient,
            conversationForkClient: forkClient,
            conversationDetailClient: detailClient
        )
    }

    override func tearDown() {
        conversationManager = nil
        detailClient = nil
        forkClient = nil
        daemonClient = nil
        super.tearDown()
    }

    func testForkConversationThroughDaemonMessageIdInsertsAndSelectsReturnedFork() async {
        let sourceConversation = makePersistedConversation(
            title: "Root",
            conversationId: "conv-root"
        )
        let forkParent = ConversationForkParent(
            conversationId: "conv-root",
            messageId: "msg-root",
            title: "Root"
        )
        let forkedConversation = ConversationListResponseItem(
            id: "conv-fork",
            title: "Forked Root",
            createdAt: 1_710_000_000_000,
            updatedAt: 1_710_000_000_500,
            conversationType: "standard",
            source: nil,
            scheduleJobId: nil,
            channelBinding: nil,
            conversationOriginChannel: nil,
            conversationOriginInterface: nil,
            assistantAttention: nil,
            displayOrder: nil,
            isPinned: false,
            forkParent: forkParent
        )
        forkClient.result = forkedConversation
        detailClient.result = forkedConversation

        await conversationManager.forkConversation(throughDaemonMessageId: "msg-root")

        XCTAssertEqual(forkClient.capturedConversationIds, ["conv-root"])
        XCTAssertEqual(forkClient.capturedMessageIds, ["msg-root"])
        XCTAssertEqual(detailClient.fetchedConversationIds, ["conv-fork"])
        XCTAssertEqual(conversationManager.conversations.count, 2)

        guard let activeConversation = conversationManager.activeConversation else {
            XCTFail("Expected an active forked conversation")
            return
        }

        XCTAssertEqual(activeConversation.conversationId, "conv-fork")
        XCTAssertEqual(activeConversation.title, "Forked Root")
        XCTAssertEqual(activeConversation.forkParent?.conversationId, "conv-root")
        XCTAssertEqual(activeConversation.forkParent?.messageId, "msg-root")
        XCTAssertEqual(activeConversation.forkParent?.title, "Root")
    }

    func testExactForkCommandUsesManagerForkPath() async {
        _ = makePersistedConversation(title: "Root", conversationId: "conv-root")
        let forkedConversation = ConversationListResponseItem(
            id: "conv-fork",
            title: "Forked Root",
            createdAt: 1_710_000_000_000,
            updatedAt: 1_710_000_000_500,
            conversationType: "standard",
            source: nil,
            scheduleJobId: nil,
            channelBinding: nil,
            conversationOriginChannel: nil,
            conversationOriginInterface: nil,
            assistantAttention: nil,
            displayOrder: nil,
            isPinned: false,
            forkParent: ConversationForkParent(
                conversationId: "conv-root",
                messageId: "msg-root",
                title: "Root"
            )
        )
        forkClient.result = forkedConversation
        detailClient.result = forkedConversation

        guard let sourceViewModel = conversationManager.activeViewModel else {
            XCTFail("Expected an active source view model")
            return
        }
        sourceViewModel.messages = [makeMessage(daemonMessageId: "msg-root")]

        let forkTriggered = expectation(description: "fork routed through manager")
        forkClient.onFork = {
            forkTriggered.fulfill()
        }

        sourceViewModel.inputText = "/fork"
        sourceViewModel.sendMessage()

        await fulfillment(of: [forkTriggered], timeout: 1.0)

        XCTAssertEqual(forkClient.capturedConversationIds, ["conv-root"])
        XCTAssertEqual(forkClient.capturedMessageIds, ["msg-root"])
        XCTAssertEqual(sourceViewModel.messages.count, 1)
        XCTAssertEqual(sourceViewModel.messages.first?.daemonMessageId, "msg-root")
        XCTAssertEqual(sourceViewModel.inputText, "")
        XCTAssertEqual(conversationManager.activeConversation?.conversationId, "conv-fork")
    }

    func testExactForkCommandOnPrivateConversationShowsLocalErrorWithoutRouting() async {
        conversationManager.createPrivateConversation()

        guard let privateViewModel = conversationManager.activeViewModel else {
            XCTFail("Expected an active private view model")
            return
        }

        privateViewModel.inputText = "/fork"
        privateViewModel.sendMessage()

        XCTAssertTrue(forkClient.capturedConversationIds.isEmpty)
        XCTAssertTrue(privateViewModel.messages.isEmpty)
        XCTAssertEqual(privateViewModel.inputText, "")
        XCTAssertEqual(
            privateViewModel.errorText,
            "Forking is unavailable in private conversations."
        )
    }

    func testExactForkCommandOnUnsavedDraftShowsLocalErrorWithoutAppendingBubble() {
        guard let draftViewModel = conversationManager.activeViewModel else {
            XCTFail("Expected a draft view model")
            return
        }

        draftViewModel.inputText = "/fork"
        draftViewModel.sendMessage()

        XCTAssertTrue(forkClient.capturedConversationIds.isEmpty)
        XCTAssertTrue(draftViewModel.messages.isEmpty)
        XCTAssertEqual(draftViewModel.inputText, "")
        XCTAssertEqual(draftViewModel.errorText, "Send a message before forking this conversation.")
        XCTAssertTrue(conversationManager.conversations.isEmpty)
    }

    func testOpenForkParentConversationRefusesPrivateParents() async {
        let privateConversation = ConversationModel(
            title: "Private",
            conversationId: "conv-private",
            kind: .private,
            forkParent: ConversationForkParent(
                conversationId: "conv-parent",
                messageId: "msg-parent",
                title: "Parent"
            )
        )
        conversationManager.conversations = [privateConversation]

        let opened = await conversationManager.openForkParentConversation(
            conversationId: "conv-private",
            sourceMessageId: "msg-parent"
        )

        XCTAssertFalse(opened)
        XCTAssertNil(conversationManager.activeConversationId)
        XCTAssertTrue(detailClient.fetchedConversationIds.isEmpty)
    }

    @discardableResult
    private func makePersistedConversation(title: String, conversationId: String) -> ConversationModel {
        let conversation = ConversationModel(title: title, conversationId: conversationId)
        let viewModel = conversationManager.makeViewModel()
        viewModel.conversationId = conversationId
        conversationManager.conversations = [conversation]
        conversationManager.setChatViewModel(viewModel, for: conversation.id)
        conversationManager.selectConversation(id: conversation.id)
        return conversation
    }

    private func makeMessage(daemonMessageId: String) -> ChatMessage {
        var message = ChatMessage(role: .assistant, text: "Persisted assistant reply")
        message.daemonMessageId = daemonMessageId
        return message
    }
}
