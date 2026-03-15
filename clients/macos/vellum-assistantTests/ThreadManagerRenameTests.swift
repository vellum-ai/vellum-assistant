import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ThreadManagerRenameTests: XCTestCase {

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
        threadManager.createThread()
    }

    override func tearDown() {
        daemonClient?.sendOverride = nil
        threadManager = nil
        capturedMessages = []
        daemonClient = nil
        super.tearDown()
    }

    // MARK: - Rename with sessionId

    func testRenameWithSessionIdSendsMessage() {
        guard let thread = threadManager.threads.first else {
            XCTFail("Expected at least one thread")
            return
        }

        threadManager.threads[0].conversationId = "session-abc"
        capturedMessages = [] // clear setup noise

        threadManager.renameThread(id: thread.id, title: "Renamed Thread")

        XCTAssertEqual(threadManager.threads[0].title, "Renamed Thread")

        let renameMessages = capturedMessages.compactMap { $0 as? ConversationRenameRequest }
        XCTAssertEqual(renameMessages.count, 1)
        XCTAssertEqual(renameMessages.first?.conversationId, "session-abc")
        XCTAssertEqual(renameMessages.first?.title, "Renamed Thread")
    }

    // MARK: - Empty/whitespace rename rejected

    func testEmptyRenameIsRejected() {
        guard let thread = threadManager.threads.first else {
            XCTFail("Expected at least one thread")
            return
        }
        let originalTitle = thread.title
        threadManager.threads[0].conversationId = "session-abc"

        threadManager.renameThread(id: thread.id, title: "")

        XCTAssertEqual(threadManager.threads[0].title, originalTitle)
        let renameMessages = capturedMessages.compactMap { $0 as? ConversationRenameRequest }
        XCTAssertTrue(renameMessages.isEmpty)
    }

    func testWhitespaceOnlyRenameIsRejected() {
        guard let thread = threadManager.threads.first else {
            XCTFail("Expected at least one thread")
            return
        }
        let originalTitle = thread.title
        threadManager.threads[0].conversationId = "session-abc"

        threadManager.renameThread(id: thread.id, title: "   \n  ")

        XCTAssertEqual(threadManager.threads[0].title, originalTitle)
        let renameMessages = capturedMessages.compactMap { $0 as? ConversationRenameRequest }
        XCTAssertTrue(renameMessages.isEmpty)
    }

    // MARK: - Rename trims whitespace

    func testRenameTrimsWhitespace() {
        guard let thread = threadManager.threads.first else {
            XCTFail("Expected at least one thread")
            return
        }
        threadManager.threads[0].conversationId = "session-abc"
        capturedMessages = []

        threadManager.renameThread(id: thread.id, title: "  Trimmed Title  ")

        XCTAssertEqual(threadManager.threads[0].title, "Trimmed Title")
    }
}
