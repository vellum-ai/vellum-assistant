import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ThreadManagerPrivateThreadTests: XCTestCase {

    private var daemonClient: DaemonClient!
    private var threadManager: ThreadManager!
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
        threadManager = ThreadManager(daemonClient: daemonClient)
    }

    override func tearDown() {
        daemonClient?.sendOverride = nil
        threadManager = nil
        capturedMessages = []
        daemonClient = nil
        super.tearDown()
    }

    // MARK: - createPrivateThread

    func testCreatePrivateThreadAddsThreadWithPrivateKind() {
        threadManager.createPrivateThread()

        // init creates a default standard thread, so we expect 2 threads total
        XCTAssertEqual(threadManager.threads.count, 2)
        let privateThread = threadManager.threads.first!
        XCTAssertEqual(privateThread.kind, .private, "New thread should have kind .private")
    }

    func testCreatePrivateThreadSetsActiveThread() {
        threadManager.createPrivateThread()

        let privateThread = threadManager.threads.first!
        XCTAssertEqual(threadManager.activeThreadId, privateThread.id)
    }

    func testCreatePrivateThreadCallsCreateSessionIfNeeded() {
        threadManager.createPrivateThread()

        let vm = threadManager.activeViewModel!
        XCTAssertTrue(vm.isSending, "Should be in sending state from createSessionIfNeeded bootstrap")
        XCTAssertTrue(vm.isBootstrapping, "Should be bootstrapping a session")
        XCTAssertEqual(vm.conversationType, "private", "conversationType should be set to private")
    }

    func testCreatePrivateThreadSendsSessionCreate() {
        threadManager.createPrivateThread()

        // Allow the async Task in bootstrapSession to execute
        let expectation = XCTestExpectation(description: "session_create sent")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 1.0)

        let sessionCreates = capturedMessages.compactMap { $0 as? SessionCreateMessage }
        XCTAssertEqual(sessionCreates.count, 1, "Should send exactly one session_create")
        XCTAssertEqual(sessionCreates.first?.conversationType, "private", "session_create should include private conversationType")
        XCTAssertNotNil(sessionCreates.first?.correlationId, "session_create should include correlationId")
    }

    func testCreatePrivateThreadDoesNotReuseEmptyStandardThread() {
        // init already creates an empty standard thread — createPrivateThread
        // should NOT reuse it (unlike createThread which skips if active is empty).
        let standardThreadId = threadManager.activeThreadId
        threadManager.createPrivateThread()

        XCTAssertNotEqual(threadManager.activeThreadId, standardThreadId,
                          "Should create a new thread, not reuse the empty standard one")
        XCTAssertEqual(threadManager.threads.count, 2)
    }

    // MARK: - Session backfill

    func testPrivateThreadSessionBackfill() {
        threadManager.createPrivateThread()
        let privateThread = threadManager.threads.first!
        let vm = threadManager.activeViewModel!
        let correlationId = vm.bootstrapCorrelationId!

        // Simulate daemon responding with session_info
        let info = SessionInfoMessage(sessionId: "private-session-42", title: "Test", correlationId: correlationId)
        vm.handleServerMessage(.sessionInfo(info))

        // The thread's sessionId should be backfilled via onSessionCreated
        let updatedThread = threadManager.threads.first(where: { $0.id == privateThread.id })!
        XCTAssertEqual(updatedThread.sessionId, "private-session-42", "Session ID should be backfilled into the ThreadModel")
        XCTAssertEqual(vm.sessionId, "private-session-42")
        XCTAssertFalse(vm.isSending, "Should reset isSending after session_info for message-less create")
        XCTAssertFalse(vm.isBootstrapping, "Should no longer be bootstrapping after session_info")
    }

    func testPrivateThreadTitleCallbackStillWorks() {
        threadManager.createPrivateThread()
        let privateThread = threadManager.threads.first!
        let vm = threadManager.activeViewModel!
        let correlationId = vm.bootstrapCorrelationId!

        // Complete the session bootstrap
        let info = SessionInfoMessage(sessionId: "private-sess", title: "Test", correlationId: correlationId)
        vm.handleServerMessage(.sessionInfo(info))

        // Simulate the user sending a message — the onFirstUserMessage callback
        // should still fire and set the title to "Untitled" as a placeholder.
        vm.inputText = "Hello private thread"
        vm.sendMessage()

        let updatedThread = threadManager.threads.first(where: { $0.id == privateThread.id })!
        XCTAssertEqual(updatedThread.title, "Untitled", "First user message should trigger title update")
    }

    func testCreatePrivateThreadSetsOnSessionCreatedCallback() {
        threadManager.createPrivateThread()
        let vm = threadManager.activeViewModel!
        XCTAssertNotNil(vm.onSessionCreated, "onSessionCreated should be set for session ID backfill")
    }
}
