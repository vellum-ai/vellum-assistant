import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ThreadManagerSyncConflictTests: XCTestCase {

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
        daemonClient?.moveChannelSyncOverride = nil
        threadManager = nil
        capturedMessages = []
        daemonClient = nil
        super.tearDown()
    }

    // MARK: - Helper: create a synced thread with a session

    /// Creates a thread with a given sourceChannel/externalChatId binding
    /// and bootstraps a session for it so it has a valid sessionId.
    private func createSyncedThread(
        sourceChannel: String = "telegram",
        externalChatId: String = "chat-123",
        title: String = "Synced Thread",
        displayName: String? = nil,
        username: String? = nil
    ) -> (thread: ThreadModel, viewModel: ChatViewModel) {
        let thread = ThreadModel(
            title: title,
            sessionId: "session-\(UUID().uuidString.prefix(8))",
            sourceChannel: sourceChannel,
            displayName: displayName,
            username: username,
            externalChatId: externalChatId
        )
        let vm = threadManager.makeViewModel()
        vm.sessionId = thread.sessionId
        vm.isHistoryLoaded = true
        threadManager.threads.insert(thread, at: 0)
        threadManager.setChatViewModel(vm, for: thread.id)
        return (thread, vm)
    }

    // MARK: - continueInSyncedThread: Draft Carryover

    func testContinueInSyncedThreadCarriesDraftText() {
        let (ownerThread, ownerVM) = createSyncedThread(title: "Owner Thread")
        let (nonOwnerThread, nonOwnerVM) = createSyncedThread(
            externalChatId: "chat-456",
            title: "Non-Owner"
        )

        // Activate the non-owner thread and type a draft
        threadManager.activeThreadId = nonOwnerThread.id
        nonOwnerVM.inputText = "Hello from non-owner"

        // Continue in the synced (owner) thread
        threadManager.continueInSyncedThread(
            targetThreadId: ownerThread.id,
            sourceThreadId: nonOwnerThread.id
        )

        // Verify: active thread switched to owner
        XCTAssertEqual(threadManager.activeThreadId, ownerThread.id)
        // Verify: draft text carried to target composer
        XCTAssertEqual(ownerVM.inputText, "Hello from non-owner")
        // Verify: source composer cleared
        XCTAssertEqual(nonOwnerVM.inputText, "")
    }

    func testContinueInSyncedThreadCarriesAttachments() {
        let (ownerThread, ownerVM) = createSyncedThread(title: "Owner Thread")
        let (nonOwnerThread, nonOwnerVM) = createSyncedThread(
            externalChatId: "chat-456",
            title: "Non-Owner"
        )

        threadManager.activeThreadId = nonOwnerThread.id
        nonOwnerVM.inputText = "Check this file"
        let attachment = ChatAttachment(
            id: "att-1",
            filename: "test.png",
            mimeType: "image/png",
            data: "base64data",
            thumbnailData: nil,
            dataLength: 10,
            thumbnailImage: nil
        )
        nonOwnerVM.pendingAttachments = [attachment]

        threadManager.continueInSyncedThread(
            targetThreadId: ownerThread.id,
            sourceThreadId: nonOwnerThread.id
        )

        // Verify: attachments carried to target
        XCTAssertEqual(ownerVM.pendingAttachments.count, 1)
        XCTAssertEqual(ownerVM.pendingAttachments.first?.id, "att-1")
        // Verify: source attachments cleared
        XCTAssertTrue(nonOwnerVM.pendingAttachments.isEmpty)
    }

    func testContinueInSyncedThreadWithEmptyDraft() {
        let (ownerThread, ownerVM) = createSyncedThread(title: "Owner Thread")
        let (nonOwnerThread, _) = createSyncedThread(
            externalChatId: "chat-456",
            title: "Non-Owner"
        )

        threadManager.activeThreadId = nonOwnerThread.id
        // No draft text or attachments

        threadManager.continueInSyncedThread(
            targetThreadId: ownerThread.id,
            sourceThreadId: nonOwnerThread.id
        )

        // Verify: active thread still switched
        XCTAssertEqual(threadManager.activeThreadId, ownerThread.id)
        // Verify: target composer unchanged (empty)
        XCTAssertEqual(ownerVM.inputText, "")
        XCTAssertTrue(ownerVM.pendingAttachments.isEmpty)
    }

    func testContinueInSyncedThreadPreservesTargetExistingDraft() {
        let (ownerThread, ownerVM) = createSyncedThread(title: "Owner Thread")
        let (nonOwnerThread, nonOwnerVM) = createSyncedThread(
            externalChatId: "chat-456",
            title: "Non-Owner"
        )

        // Target already has a draft
        ownerVM.inputText = "Existing draft in owner"
        threadManager.activeThreadId = nonOwnerThread.id
        nonOwnerVM.inputText = "New text from non-owner"

        threadManager.continueInSyncedThread(
            targetThreadId: ownerThread.id,
            sourceThreadId: nonOwnerThread.id
        )

        // Source draft replaces target draft (the user's intent is to continue
        // their current work in the synced thread)
        XCTAssertEqual(ownerVM.inputText, "New text from non-owner")
    }

    func testContinueInSyncedThreadFallsBackOnMissingViewModel() {
        let (ownerThread, _) = createSyncedThread(title: "Owner Thread")
        let bogusId = UUID()

        threadManager.activeThreadId = ownerThread.id

        // Call with a bogus source thread ID — should still switch threads
        threadManager.continueInSyncedThread(
            targetThreadId: ownerThread.id,
            sourceThreadId: bogusId
        )

        XCTAssertEqual(threadManager.activeThreadId, ownerThread.id)
    }

    // MARK: - moveSyncHereAndResend: Move + Auto-Resend

    func testMoveSyncHereAndResendSendsMessageOnSuccess() {
        // Owner thread currently owns "telegram:chat-123"
        let (ownerThread, _) = createSyncedThread(title: "Owner Thread")
        // Non-owner is a plain thread (no sync binding) that wants to take over
        let nonOwnerThread = ThreadModel(
            title: "Non-Owner",
            sessionId: "session-nonowner"
        )
        let nonOwnerVM = threadManager.makeViewModel()
        nonOwnerVM.sessionId = nonOwnerThread.sessionId
        nonOwnerVM.isHistoryLoaded = true
        threadManager.threads.insert(nonOwnerThread, at: 0)
        threadManager.setChatViewModel(nonOwnerVM, for: nonOwnerThread.id)

        threadManager.activeThreadId = nonOwnerThread.id
        nonOwnerVM.inputText = "Please send this"

        // Mock moveChannelSync to succeed
        daemonClient.moveChannelSyncOverride = { _, _, _ in true }

        threadManager.moveSyncHereAndResend(
            threadId: nonOwnerThread.id,
            sourceChannel: "telegram",
            externalChatId: "chat-123"
        )

        // Wait for the async Task to complete
        let expectation = XCTestExpectation(description: "move-sync completes")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 1.0)

        // Verify: non-owner thread now has sync binding
        let updatedNonOwner = threadManager.threads.first(where: { $0.id == nonOwnerThread.id })!
        XCTAssertEqual(updatedNonOwner.sourceChannel, "telegram")
        XCTAssertEqual(updatedNonOwner.externalChatId, "chat-123")

        // Verify: old owner lost sync binding
        let updatedOwner = threadManager.threads.first(where: { $0.id == ownerThread.id })!
        XCTAssertNil(updatedOwner.sourceChannel)
        XCTAssertNil(updatedOwner.externalChatId)

        // Verify: the user message was appended (auto-sent)
        XCTAssertTrue(nonOwnerVM.messages.contains(where: {
            $0.role == .user && $0.text == "Please send this"
        }), "Draft should have been auto-sent after move-sync success")

        // Verify: composer was cleared by sendMessage
        XCTAssertEqual(nonOwnerVM.inputText, "")
    }

    func testMoveSyncHereAndResendDoesNotSendOnFailure() {
        let (_, _) = createSyncedThread(title: "Owner Thread")
        let (nonOwnerThread, nonOwnerVM) = createSyncedThread(
            externalChatId: "chat-456",
            title: "Non-Owner"
        )

        threadManager.activeThreadId = nonOwnerThread.id
        nonOwnerVM.inputText = "Should not be sent"

        // Mock moveChannelSync to fail
        daemonClient.moveChannelSyncOverride = { _, _, _ in false }

        threadManager.moveSyncHereAndResend(
            threadId: nonOwnerThread.id,
            sourceChannel: "telegram",
            externalChatId: "chat-456"
        )

        let expectation = XCTestExpectation(description: "move-sync fails")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 1.0)

        // Verify: no user messages were sent
        XCTAssertFalse(nonOwnerVM.messages.contains(where: { $0.role == .user }),
                       "Draft should NOT be sent when move-sync fails")
    }

    func testMoveSyncHereAndResendWithEmptyDraftSkipsSend() {
        let (_, _) = createSyncedThread(title: "Owner Thread")
        let (nonOwnerThread, nonOwnerVM) = createSyncedThread(
            externalChatId: "chat-456",
            title: "Non-Owner"
        )

        threadManager.activeThreadId = nonOwnerThread.id
        // Empty composer — no draft to resend

        daemonClient.moveChannelSyncOverride = { _, _, _ in true }

        threadManager.moveSyncHereAndResend(
            threadId: nonOwnerThread.id,
            sourceChannel: "telegram",
            externalChatId: "chat-456"
        )

        let expectation = XCTestExpectation(description: "move-sync completes")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 1.0)

        // Verify: sync moved successfully
        let updatedNonOwner = threadManager.threads.first(where: { $0.id == nonOwnerThread.id })!
        XCTAssertEqual(updatedNonOwner.sourceChannel, "telegram")

        // Verify: no messages sent (empty draft)
        XCTAssertFalse(nonOwnerVM.messages.contains(where: { $0.role == .user }))
    }

    func testMoveSyncHereAndResendPreservesDisplayMetadata() {
        let (ownerThread, _) = createSyncedThread(
            title: "Owner Thread",
            displayName: "Alice",
            username: "alice_tg"
        )
        let (nonOwnerThread, _) = createSyncedThread(
            externalChatId: "chat-456",
            title: "Non-Owner"
        )

        threadManager.activeThreadId = nonOwnerThread.id

        daemonClient.moveChannelSyncOverride = { _, _, _ in true }

        threadManager.moveSyncHereAndResend(
            threadId: nonOwnerThread.id,
            sourceChannel: "telegram",
            externalChatId: "chat-123"
        )

        let expectation = XCTestExpectation(description: "move-sync completes")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 1.0)

        // Verify: display metadata carried from old owner to new owner
        let updatedNonOwner = threadManager.threads.first(where: { $0.id == nonOwnerThread.id })!
        XCTAssertEqual(updatedNonOwner.displayName, "Alice")
        XCTAssertEqual(updatedNonOwner.username, "alice_tg")

        // Verify: old owner metadata cleared
        let updatedOwner = threadManager.threads.first(where: { $0.id == ownerThread.id })!
        XCTAssertNil(updatedOwner.displayName)
        XCTAssertNil(updatedOwner.username)
    }

    // MARK: - No Data Loss

    func testDraftNotLostOnContinue() {
        // Ensures the draft text is faithfully preserved across thread switch
        let (ownerThread, ownerVM) = createSyncedThread(title: "Owner")
        let (nonOwnerThread, nonOwnerVM) = createSyncedThread(
            externalChatId: "chat-456",
            title: "Non-Owner"
        )

        let longDraft = String(repeating: "test message content ", count: 50)
        threadManager.activeThreadId = nonOwnerThread.id
        nonOwnerVM.inputText = longDraft

        threadManager.continueInSyncedThread(
            targetThreadId: ownerThread.id,
            sourceThreadId: nonOwnerThread.id
        )

        XCTAssertEqual(ownerVM.inputText, longDraft,
                       "Long draft text must be preserved exactly across thread switch")
        XCTAssertEqual(ownerVM.inputText.count, longDraft.count)
    }

    func testDraftNotLostOnMoveFailure() {
        // When move-sync fails, the draft should remain in the composer
        let (_, _) = createSyncedThread(title: "Owner")
        let (nonOwnerThread, nonOwnerVM) = createSyncedThread(
            externalChatId: "chat-456",
            title: "Non-Owner"
        )

        threadManager.activeThreadId = nonOwnerThread.id
        nonOwnerVM.inputText = "Important message"

        daemonClient.moveChannelSyncOverride = { _, _, _ in false }

        threadManager.moveSyncHereAndResend(
            threadId: nonOwnerThread.id,
            sourceChannel: "telegram",
            externalChatId: "chat-456"
        )

        let expectation = XCTestExpectation(description: "move-sync fails")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 1.0)

        // The draft is still in inputText since sendMessage was never called
        // (move failed, so we skip the auto-send)
        XCTAssertFalse(nonOwnerVM.messages.contains(where: { $0.role == .user }),
                       "No user message should be sent on failure")
    }

    // MARK: - findCanonicalThread

    func testFindCanonicalThreadReturnsCorrectThread() {
        let (ownerThread, _) = createSyncedThread(title: "Owner")
        let (nonOwnerThread, _) = createSyncedThread(
            externalChatId: "chat-456",
            title: "Non-Owner"
        )

        let canonical = threadManager.findCanonicalThread(
            sourceChannel: "telegram",
            externalChatId: "chat-123",
            excludingThread: nonOwnerThread.id
        )

        XCTAssertEqual(canonical?.id, ownerThread.id)
    }

    func testFindCanonicalThreadExcludesArchived() {
        let (ownerThread, _) = createSyncedThread(title: "Owner")

        // Archive the owner thread
        if let idx = threadManager.threads.firstIndex(where: { $0.id == ownerThread.id }) {
            threadManager.threads[idx].isArchived = true
        }

        let canonical = threadManager.findCanonicalThread(
            sourceChannel: "telegram",
            externalChatId: "chat-123",
            excludingThread: UUID()
        )

        XCTAssertNil(canonical, "Archived threads should not be returned as canonical")
    }
}
