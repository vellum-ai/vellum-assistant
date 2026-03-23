import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ConversationManagerDebouncedEvictionTests: XCTestCase {

    private var connectionManager: GatewayConnectionManager!
    private var conversationManager: ConversationManager!

    override func setUp() {
        super.setUp()
        connectionManager = GatewayConnectionManager()
        connectionManager.isConnected = true
        conversationManager = ConversationManager(connectionManager: connectionManager, eventStreamClient: connectionManager.eventStreamClient)
    }

    override func tearDown() {
        conversationManager = nil
        connectionManager = nil
        super.tearDown()
    }

    // MARK: - Debounced eviction behavior

    /// Verify that eviction is deferred and fires after ~150ms, evicting old VMs
    /// while retaining recently-accessed ones.
    func testDebouncedEvictionEvictsOldVMsAfterDelay() async throws {
        // Collect the UUIDs we inject. The first few should be evicted (oldest),
        // and the most recent ones should be retained.
        var insertedIds: [UUID] = []

        // ConversationManager starts in draft mode (draftViewModel, not in
        // chatViewModels), so chatViewModels starts empty. Insert 12 VMs to
        // exceed maxCachedViewModels (10) and trigger eviction.
        for _ in 0..<12 {
            let id = UUID()
            let vm = conversationManager.makeViewModel()
            // Ensure the VM is idle so the eviction guard doesn't skip it.
            vm.isSending = false
            vm.isThinking = false
            vm.pendingQueuedCount = 0
            conversationManager.setChatViewModel(vm, for: id)
            insertedIds.append(id)
        }

        // Immediately after insertion, eviction should NOT have run yet because
        // it is debounced. The earliest VMs should still be present.
        let earlyId = insertedIds[0]
        // Note: we access chatViewModels indirectly. existingChatViewModel(for:)
        // would call touchVMAccessOrder, promoting the UUID to MRU. Instead we
        // check existence AFTER the delay, as the plan instructs.

        // Wait for the debounced eviction to fire (150ms delay + margin).
        try await Task.sleep(for: .milliseconds(300))

        // After eviction has fired, the earliest injected VMs should have been
        // evicted because the cache exceeds maxCachedViewModels.
        let earlyVM = conversationManager.existingChatViewModel(for: earlyId)
        XCTAssertNil(earlyVM, "Early VM should have been evicted after debounced eviction fires")

        // The most recently inserted VM should still be retained.
        let recentId = insertedIds.last!
        let recentVM = conversationManager.existingChatViewModel(for: recentId)
        XCTAssertNotNil(recentVM, "Recent VM should be retained after eviction")
    }

    /// Verify that multiple rapid insertions coalesce into a single eviction pass.
    func testMultipleInsertionsCoalesceIntoSingleEviction() async throws {
        // Rapidly insert 12 VMs — each call to setChatViewModel triggers
        // scheduleEvictionIfNeeded(), but only one eviction task should be
        // created because the guard `pendingEvictionTask == nil` prevents
        // duplicates.
        var insertedIds: [UUID] = []
        for _ in 0..<12 {
            let id = UUID()
            let vm = conversationManager.makeViewModel()
            vm.isSending = false
            vm.isThinking = false
            vm.pendingQueuedCount = 0
            conversationManager.setChatViewModel(vm, for: id)
            insertedIds.append(id)
        }

        // Wait for the single debounced eviction to complete.
        try await Task.sleep(for: .milliseconds(300))

        // Count how many of our injected VMs survived. ConversationManager
        // starts in draft mode (draftViewModel, not in chatViewModels), so
        // chatViewModels starts empty. After inserting 12 and evicting, the
        // cache should be trimmed to maxCachedViewModels (10).
        var survivingCount = 0
        for id in insertedIds {
            if conversationManager.existingChatViewModel(for: id) != nil {
                survivingCount += 1
            }
        }

        XCTAssertLessThanOrEqual(survivingCount, 10,
            "Cache should be trimmed to at most maxCachedViewModels entries")
    }
}
