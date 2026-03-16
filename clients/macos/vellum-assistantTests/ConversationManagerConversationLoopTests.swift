import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ThreadManagerSessionLoopTests: XCTestCase {
    private var daemonClient: DaemonClient!
    private var threadManager: ThreadManager!

    override func setUp() {
        super.setUp()
        daemonClient = DaemonClient()
        daemonClient.isConnected = true
        daemonClient.sendOverride = { _ in }
        threadManager = ThreadManager(daemonClient: daemonClient)
    }

    override func tearDown() {
        daemonClient?.sendOverride = nil
        threadManager = nil
        daemonClient = nil
        super.tearDown()
    }

    func testSelectingSessionBackedThreadStartsMessageLoop() {
        guard let threadId = threadManager.activeThreadId,
              let vm = threadManager.chatViewModel(for: threadId),
              let index = threadManager.threads.firstIndex(where: { $0.id == threadId }) else {
            XCTFail("Expected active thread and view model")
            return
        }

        threadManager.threads[index].conversationId = "session-active"
        vm.conversationId = "session-active"

        XCTAssertEqual(daemonClient.subscribers.count, 0)
        threadManager.selectThread(id: threadId)
        XCTAssertEqual(daemonClient.subscribers.count, 1)
    }

    func testSelectingSameSessionBackedThreadDoesNotDuplicateMessageLoop() {
        guard let threadId = threadManager.activeThreadId,
              let vm = threadManager.chatViewModel(for: threadId),
              let index = threadManager.threads.firstIndex(where: { $0.id == threadId }) else {
            XCTFail("Expected active thread and view model")
            return
        }

        threadManager.threads[index].conversationId = "session-active"
        vm.conversationId = "session-active"

        threadManager.selectThread(id: threadId)
        threadManager.selectThread(id: threadId)

        XCTAssertEqual(daemonClient.subscribers.count, 1)
    }
}
