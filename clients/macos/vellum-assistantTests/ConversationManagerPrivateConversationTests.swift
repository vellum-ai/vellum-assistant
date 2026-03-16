import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ConversationManagerPrivateThreadTests: XCTestCase {

    private var daemonClient: DaemonClient!
    private var conversationManager: ConversationManager!
    private var capturedMessages: [Any] = []

    override func setUp() {
        super.setUp()
        daemonClient = DaemonClient()
        daemonClient.isConnected = true
        capturedMessages = []
        daemonClient.sendOverride = { [weak self] msg in
            guard let self else { return }
            capturedMessages.append(msg)
        }
        conversationManager = ConversationManager(daemonClient: daemonClient)
    }

    override func tearDown() {
        daemonClient?.sendOverride = nil
        conversationManager = nil
        capturedMessages = []
        daemonClient = nil
        super.tearDown()
    }

    // MARK: - createPrivateConversation

    func testCreatePrivateThreadAddsThreadWithPrivateKind() {
        conversationManager.createPrivateConversation()

        // init enters draft mode (conversations empty), createPrivateConversation adds one
        XCTAssertEqual(conversationManager.conversations.count, 1)
        let privateThread = conversationManager.conversations.first!
        XCTAssertEqual(privateThread.kind, .private, "New thread should have kind .private")
    }

    func testCreatePrivateThreadSetsActiveThread() {
        conversationManager.createPrivateConversation()

        let privateThread = conversationManager.conversations.first!
        XCTAssertEqual(conversationManager.activeConversationId, privateThread.id)
    }

    func testCreatePrivateThreadCallsCreateSessionIfNeeded() {
        conversationManager.createPrivateConversation()

        let vm = conversationManager.activeViewModel!
        // Message-less session creates (private thread pre-allocation) don't set isSending.
        XCTAssertFalse(vm.isSending, "Message-less bootstrap should not set isSending")
        XCTAssertTrue(vm.isBootstrapping, "Should be bootstrapping a session")
        XCTAssertEqual(vm.conversationType, "private", "conversationType should be set to private")
    }

    func testCreatePrivateThreadSendsSessionCreate() {
        conversationManager.createPrivateConversation()

        // Allow the async Task in bootstrapConversation to execute
        let expectation = XCTestExpectation(description: "session_create sent")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 1.0)

        let sessionCreates = capturedMessages.compactMap { $0 as? ConversationCreateMessage }
        XCTAssertEqual(sessionCreates.count, 1, "Should send exactly one session_create")
        XCTAssertEqual(sessionCreates.first?.conversationType, "private", "session_create should include private conversationType")
        XCTAssertNotNil(sessionCreates.first?.correlationId, "session_create should include correlationId")
    }

    func testCreatePrivateThreadDoesNotReuseEmptyStandardThread() {
        // init enters draft mode (activeConversationId is nil) — createPrivateConversation
        // should create a new private thread, not reuse the draft.
        let draftId = conversationManager.activeConversationId
        conversationManager.createPrivateConversation()

        XCTAssertNotEqual(conversationManager.activeConversationId, draftId,
                          "Should create a new thread, not reuse the draft")
        XCTAssertEqual(conversationManager.conversations.count, 1)
    }

    // MARK: - Session backfill

    func testPrivateThreadSessionBackfill() {
        conversationManager.createPrivateConversation()
        let privateThread = conversationManager.conversations.first!
        let vm = conversationManager.activeViewModel!
        let correlationId = vm.bootstrapCorrelationId!

        // Simulate daemon responding with session_info
        let info = ConversationInfoMessage(conversationId: "private-session-42", title: "Test", correlationId: correlationId)
        vm.handleServerMessage(.conversationInfo(info))

        // The thread's conversationId should be backfilled via onConversationCreated
        let updatedThread = conversationManager.conversations.first(where: { $0.id == privateThread.id })!
        XCTAssertEqual(updatedThread.conversationId, "private-session-42", "Session ID should be backfilled into the ConversationModel")
        XCTAssertEqual(vm.conversationId, "private-session-42")
        XCTAssertFalse(vm.isSending, "Should reset isSending after session_info for message-less create")
        XCTAssertFalse(vm.isBootstrapping, "Should no longer be bootstrapping after session_info")
    }

    func testPrivateThreadTitleCallbackStillWorks() {
        conversationManager.createPrivateConversation()
        let privateThread = conversationManager.conversations.first!
        let vm = conversationManager.activeViewModel!
        let correlationId = vm.bootstrapCorrelationId!

        // Complete the session bootstrap
        let info = ConversationInfoMessage(conversationId: "private-sess", title: "Test", correlationId: correlationId)
        vm.handleServerMessage(.conversationInfo(info))

        // Simulate the user sending a message — the onFirstUserMessage callback
        // should still fire and set the title to "Untitled" as a placeholder.
        vm.inputText = "Hello private thread"
        vm.sendMessage()

        let updatedThread = conversationManager.conversations.first(where: { $0.id == privateThread.id })!
        XCTAssertEqual(updatedThread.title, "Untitled", "First user message should trigger title update")
    }

    func testCreatePrivateThreadSetsOnSessionCreatedCallback() {
        conversationManager.createPrivateConversation()
        let vm = conversationManager.activeViewModel!
        XCTAssertNotNil(vm.onConversationCreated, "onConversationCreated should be set for session ID backfill")
    }
}
