import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ConversationManagerRenameTests: XCTestCase {

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
        conversationManager.createConversation()
    }

    override func tearDown() {
        daemonClient?.sendOverride = nil
        conversationManager = nil
        capturedMessages = []
        daemonClient = nil
        super.tearDown()
    }

    // MARK: - Rename with conversationId

    func testRenameWithSessionIdSendsMessage() {
        guard let thread = conversationManager.conversations.first else {
            XCTFail("Expected at least one thread")
            return
        }

        conversationManager.conversations[0].conversationId = "session-abc"
        capturedMessages = [] // clear setup noise

        conversationManager.renameConversation(id: thread.id, title: "Renamed Thread")

        XCTAssertEqual(conversationManager.conversations[0].title, "Renamed Thread")

        let renameMessages = capturedMessages.compactMap { $0 as? ConversationRenameRequest }
        XCTAssertEqual(renameMessages.count, 1)
        XCTAssertEqual(renameMessages.first?.conversationId, "session-abc")
        XCTAssertEqual(renameMessages.first?.title, "Renamed Thread")
    }

    // MARK: - Empty/whitespace rename rejected

    func testEmptyRenameIsRejected() {
        guard let thread = conversationManager.conversations.first else {
            XCTFail("Expected at least one thread")
            return
        }
        let originalTitle = thread.title
        conversationManager.conversations[0].conversationId = "session-abc"

        conversationManager.renameConversation(id: thread.id, title: "")

        XCTAssertEqual(conversationManager.conversations[0].title, originalTitle)
        let renameMessages = capturedMessages.compactMap { $0 as? ConversationRenameRequest }
        XCTAssertTrue(renameMessages.isEmpty)
    }

    func testWhitespaceOnlyRenameIsRejected() {
        guard let thread = conversationManager.conversations.first else {
            XCTFail("Expected at least one thread")
            return
        }
        let originalTitle = thread.title
        conversationManager.conversations[0].conversationId = "session-abc"

        conversationManager.renameConversation(id: thread.id, title: "   \n  ")

        XCTAssertEqual(conversationManager.conversations[0].title, originalTitle)
        let renameMessages = capturedMessages.compactMap { $0 as? ConversationRenameRequest }
        XCTAssertTrue(renameMessages.isEmpty)
    }

    // MARK: - Rename trims whitespace

    func testRenameTrimsWhitespace() {
        guard let thread = conversationManager.conversations.first else {
            XCTFail("Expected at least one thread")
            return
        }
        conversationManager.conversations[0].conversationId = "session-abc"
        capturedMessages = []

        conversationManager.renameConversation(id: thread.id, title: "  Trimmed Title  ")

        XCTAssertEqual(conversationManager.conversations[0].title, "Trimmed Title")
    }
}
