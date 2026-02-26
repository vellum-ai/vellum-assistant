import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ThreadManagerUnseenStateTests: XCTestCase {

    private var daemonClient: DaemonClient!
    private var threadManager: ThreadManager!
    private var sentMessages: [Any] = []

    override func setUp() {
        super.setUp()
        daemonClient = DaemonClient()
        daemonClient.isConnected = true
        daemonClient.sendOverride = { [weak self] message in
            self?.sentMessages.append(message)
        }
        threadManager = ThreadManager(daemonClient: daemonClient)
    }

    override func tearDown() {
        daemonClient?.sendOverride = nil
        threadManager = nil
        daemonClient = nil
        sentMessages = []
        super.tearDown()
    }

    func testInactiveStandardThreadMarkedUnseenWhenAssistantReplies() {
        guard let initialThreadId = threadManager.activeThreadId else {
            XCTFail("Expected an initial active thread")
            return
        }
        threadManager.chatViewModel(for: initialThreadId)?.messages.append(ChatMessage(role: .user, text: "Seed"))

        threadManager.createThread()
        let activeThreadId = threadManager.activeThreadId
        XCTAssertNotEqual(initialThreadId, activeThreadId)

        guard let vm = threadManager.chatViewModel(for: initialThreadId) else {
            XCTFail("Expected ChatViewModel for inactive thread")
            return
        }

        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Background reply")))
        vm.handleServerMessage(.messageComplete(MessageCompleteMessage()))

        waitForPropagation()

        guard let updated = threadManager.threads.first(where: { $0.id == initialThreadId }) else {
            XCTFail("Expected thread to exist")
            return
        }

        XCTAssertNil(updated.source, "Regression guard: should work for normal (non-notification) threads")
        XCTAssertTrue(updated.hasUnseenLatestAssistantMessage)
    }

    func testInactiveThreadMarkedUnseenWhenAssistantContinuesSameMessageAfterSwitch() {
        guard let initialThreadId = threadManager.activeThreadId,
              let initialVm = threadManager.chatViewModel(for: initialThreadId),
              let initialIndex = threadManager.threads.firstIndex(where: { $0.id == initialThreadId }) else {
            XCTFail("Expected an initial active thread and VM")
            return
        }

        threadManager.threads[initialIndex].sessionId = "session-initial"
        initialVm.sessionId = "session-initial"
        initialVm.messages.append(ChatMessage(role: .user, text: "Seed"))

        initialVm.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: "First chunk", sessionId: "session-initial")
        ))
        waitForPropagation()
        XCTAssertFalse(threadManager.threads[initialIndex].hasUnseenLatestAssistantMessage)

        threadManager.createThread()
        guard let secondaryThreadId = threadManager.activeThreadId,
              let secondaryIndex = threadManager.threads.firstIndex(where: { $0.id == secondaryThreadId }),
              let secondaryVm = threadManager.chatViewModel(for: secondaryThreadId) else {
            XCTFail("Expected a secondary active thread and VM")
            return
        }

        threadManager.threads[secondaryIndex].sessionId = "session-secondary"
        secondaryVm.sessionId = "session-secondary"
        threadManager.selectThread(id: secondaryThreadId)

        initialVm.handleServerMessage(.assistantTextDelta(
            AssistantTextDeltaMessage(text: " + second chunk", sessionId: "session-initial")
        ))
        initialVm.handleServerMessage(.messageComplete(
            MessageCompleteMessage(sessionId: "session-initial")
        ))

        waitForPropagation()

        guard let updated = threadManager.threads.first(where: { $0.id == initialThreadId }) else {
            XCTFail("Expected thread to exist")
            return
        }
        XCTAssertTrue(updated.hasUnseenLatestAssistantMessage)
    }

    func testActiveThreadEmitsSeenSignalEvenWhenAlreadySeen() {
        guard let threadId = threadManager.activeThreadId,
              let index = threadManager.threads.firstIndex(where: { $0.id == threadId }),
              let vm = threadManager.chatViewModel(for: threadId) else {
            XCTFail("Expected active thread and view model")
            return
        }

        threadManager.threads[index].sessionId = "session-realtime"
        threadManager.threads[index].hasUnseenLatestAssistantMessage = false
        vm.sessionId = "session-realtime"

        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Streaming reply", sessionId: "session-realtime")))
        vm.handleServerMessage(.messageComplete(MessageCompleteMessage(sessionId: "session-realtime")))

        waitForPropagation()

        XCTAssertFalse(threadManager.threads[index].hasUnseenLatestAssistantMessage)

        let seenSignals = sentMessages.compactMap { $0 as? IPCConversationSeenSignal }
        XCTAssertFalse(seenSignals.isEmpty, "Seen signal should be emitted even when thread was already marked as seen")
        XCTAssertEqual(seenSignals.last?.conversationId, "session-realtime")
    }

    func testActiveThreadAssistantReplyClearsUnseenAndEmitsSeenSignal() {
        guard let threadId = threadManager.activeThreadId,
              let index = threadManager.threads.firstIndex(where: { $0.id == threadId }),
              let vm = threadManager.chatViewModel(for: threadId) else {
            XCTFail("Expected active thread and view model")
            return
        }

        threadManager.threads[index].sessionId = "session-active"
        threadManager.threads[index].hasUnseenLatestAssistantMessage = true
        vm.sessionId = "session-active"

        vm.handleServerMessage(.assistantTextDelta(AssistantTextDeltaMessage(text: "Visible reply", sessionId: "session-active")))
        vm.handleServerMessage(.messageComplete(MessageCompleteMessage(sessionId: "session-active")))

        waitForPropagation()

        XCTAssertFalse(threadManager.threads[index].hasUnseenLatestAssistantMessage)

        let seenSignals = sentMessages.compactMap { $0 as? IPCConversationSeenSignal }
        XCTAssertEqual(seenSignals.last?.conversationId, "session-active")
    }

    private func waitForPropagation() {
        let exp = expectation(description: "combine propagation")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1.0)
    }
}
