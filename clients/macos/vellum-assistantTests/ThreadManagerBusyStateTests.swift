import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ThreadManagerBusyStateTests: XCTestCase {

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

    // MARK: - Busy state derivation

    func testBusyFalseByDefault() {
        // init creates a default thread
        let threadId = threadManager.activeThreadId!
        XCTAssertFalse(threadManager.isThreadBusy(threadId), "Thread should not be busy by default")
        XCTAssertTrue(threadManager.busyThreadIds.isEmpty)
    }

    func testBusyTrueWhenIsSending() {
        let threadId = threadManager.activeThreadId!
        let vm = threadManager.activeViewModel!
        vm.isSending = true

        // Allow Combine pipeline to deliver
        let exp = expectation(description: "busy state propagates")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { exp.fulfill() }
        wait(for: [exp], timeout: 1.0)

        XCTAssertTrue(threadManager.isThreadBusy(threadId), "Thread should be busy when isSending is true")
    }

    func testBusyTrueWhenIsThinking() {
        let threadId = threadManager.activeThreadId!
        let vm = threadManager.activeViewModel!
        vm.isThinking = true

        let exp = expectation(description: "busy state propagates")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { exp.fulfill() }
        wait(for: [exp], timeout: 1.0)

        XCTAssertTrue(threadManager.isThreadBusy(threadId), "Thread should be busy when isThinking is true")
    }

    func testBusyTrueWhenPendingQueuedCountPositive() {
        let threadId = threadManager.activeThreadId!
        let vm = threadManager.activeViewModel!
        vm.pendingQueuedCount = 3

        let exp = expectation(description: "busy state propagates")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { exp.fulfill() }
        wait(for: [exp], timeout: 1.0)

        XCTAssertTrue(threadManager.isThreadBusy(threadId), "Thread should be busy when pendingQueuedCount > 0")
    }

    func testBusyFalseAfterAllReturnToIdle() {
        let threadId = threadManager.activeThreadId!
        let vm = threadManager.activeViewModel!

        // Set busy
        vm.isSending = true
        vm.isThinking = true
        vm.pendingQueuedCount = 1

        let expBusy = expectation(description: "busy state set")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { expBusy.fulfill() }
        wait(for: [expBusy], timeout: 1.0)
        XCTAssertTrue(threadManager.isThreadBusy(threadId))

        // Return to idle
        vm.isSending = false
        vm.isThinking = false
        vm.pendingQueuedCount = 0

        let expIdle = expectation(description: "idle state propagates")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { expIdle.fulfill() }
        wait(for: [expIdle], timeout: 1.0)

        XCTAssertFalse(threadManager.isThreadBusy(threadId), "Thread should not be busy after all states return to idle")
        XCTAssertTrue(threadManager.busyThreadIds.isEmpty)
    }
}
