import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ConversationManagerPrivateConversationTests: XCTestCase {

    private var daemonClient: DaemonClient!
    private var conversationManager: ConversationManager!
    private var capturedMessages: [Any] = []

    override func setUp() {
        super.setUp()
        daemonClient = DaemonClient()
        daemonClient.isConnected = true
        capturedMessages = []
        conversationManager = ConversationManager(daemonClient: daemonClient)
    }

    override func tearDown() {
        conversationManager = nil
        capturedMessages = []
        daemonClient = nil
        super.tearDown()
    }

    // MARK: - createPrivateConversation

    func testCreatePrivateConversationAddsConversationWithPrivateKind() {
        conversationManager.createPrivateConversation()

        // init enters draft mode (conversations empty), createPrivateConversation adds one
        XCTAssertEqual(conversationManager.conversations.count, 1)
        let privateConversation = conversationManager.conversations.first!
        XCTAssertEqual(privateConversation.kind, .private, "New conversation should have kind .private")
    }

    func testCreatePrivateConversationSetsActiveConversation() {
        conversationManager.createPrivateConversation()

        let privateConversation = conversationManager.conversations.first!
        XCTAssertEqual(conversationManager.activeConversationId, privateConversation.id)
    }

    func testCreatePrivateConversationCallsCreateConversationIfNeeded() {
        conversationManager.createPrivateConversation()

        let vm = conversationManager.activeViewModel!
        // Message-less conversation creates (private conversation pre-allocation) don't set isSending.
        XCTAssertFalse(vm.isSending, "Message-less bootstrap should not set isSending")
        XCTAssertTrue(vm.isBootstrapping, "Should be bootstrapping a conversation")
        XCTAssertEqual(vm.conversationType, "private", "conversationType should be set to private")
    }

    func testCreatePrivateConversationSendsConversationCreate() {
        conversationManager.createPrivateConversation()

        // Allow the async Task in bootstrapConversation to execute
        let expectation = XCTestExpectation(description: "conversation_create sent")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 1.0)

        let conversationCreates = capturedMessages.compactMap { $0 as? ConversationCreateMessage }
        XCTAssertEqual(conversationCreates.count, 1, "Should send exactly one conversation_create")
        XCTAssertEqual(conversationCreates.first?.conversationType, "private", "conversation_create should include private conversationType")
        XCTAssertNotNil(conversationCreates.first?.correlationId, "conversation_create should include correlationId")
    }

    func testCreatePrivateConversationDoesNotReuseEmptyStandardConversation() {
        // init enters draft mode (activeConversationId is nil) — createPrivateConversation
        // should create a new private conversation, not reuse the draft.
        let draftId = conversationManager.activeConversationId
        conversationManager.createPrivateConversation()

        XCTAssertNotEqual(conversationManager.activeConversationId, draftId,
                          "Should create a new conversation, not reuse the draft")
        XCTAssertEqual(conversationManager.conversations.count, 1)
    }

    // MARK: - Conversation ID backfill

    func testPrivateConversationIdBackfill() {
        conversationManager.createPrivateConversation()
        let privateConversation = conversationManager.conversations.first!
        let vm = conversationManager.activeViewModel!
        let correlationId = vm.bootstrapCorrelationId!

        // Simulate daemon responding with conversation_info
        let info = ConversationInfoMessage(conversationId: "private-session-42", title: "Test", correlationId: correlationId)
        vm.handleServerMessage(.conversationInfo(info))

        // The conversation's conversationId should be backfilled via onConversationCreated
        let updatedConversation = conversationManager.conversations.first(where: { $0.id == privateConversation.id })!
        XCTAssertEqual(updatedConversation.conversationId, "private-session-42", "Conversation ID should be backfilled into the ConversationModel")
        XCTAssertEqual(vm.conversationId, "private-session-42")
        XCTAssertFalse(vm.isSending, "Should reset isSending after conversation_info for message-less create")
        XCTAssertFalse(vm.isBootstrapping, "Should no longer be bootstrapping after conversation_info")
    }

    func testPrivateConversationTitleCallbackStillWorks() {
        conversationManager.createPrivateConversation()
        let privateConversation = conversationManager.conversations.first!
        let vm = conversationManager.activeViewModel!
        let correlationId = vm.bootstrapCorrelationId!

        // Complete the conversation bootstrap
        let info = ConversationInfoMessage(conversationId: "private-sess", title: "Test", correlationId: correlationId)
        vm.handleServerMessage(.conversationInfo(info))

        // Simulate the user sending a message — the onFirstUserMessage callback
        // should still fire and set the title to "Untitled" as a placeholder.
        vm.inputText = "Hello private conversation"
        vm.sendMessage()

        let updatedConversation = conversationManager.conversations.first(where: { $0.id == privateConversation.id })!
        XCTAssertEqual(updatedConversation.title, "Untitled", "First user message should trigger title update")
    }

    func testCreatePrivateConversationSetsOnConversationCreatedCallback() {
        conversationManager.createPrivateConversation()
        let vm = conversationManager.activeViewModel!
        XCTAssertNotNil(vm.onConversationCreated, "onConversationCreated should be set for conversation ID backfill")
    }
}
