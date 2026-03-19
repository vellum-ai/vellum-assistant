import XCTest
@testable import VellumAssistantLib

@MainActor
final class ScrollWheelDetectorRegistryTests: XCTestCase {

    private var registry: ScrollWheelDetectorRegistry!

    override func setUp() {
        super.setUp()
        registry = ScrollWheelDetectorRegistry()
    }

    override func tearDown() {
        registry = nil
        super.tearDown()
    }

    // MARK: - Register / Unregister

    func testRegisterIncrementsActiveCount() {
        XCTAssertEqual(registry.activeCount, 0)

        registry.register(
            detectorId: "det-1",
            conversationId: "conv-a",
            windowId: "win-1",
            timestamp: 1000.0
        )

        XCTAssertEqual(registry.activeCount, 1)
    }

    func testUnregisterDecrementsActiveCount() {
        registry.register(
            detectorId: "det-1",
            conversationId: "conv-a",
            windowId: "win-1",
            timestamp: 1000.0
        )
        registry.unregister(detectorId: "det-1")

        XCTAssertEqual(registry.activeCount, 0)
    }

    func testUnregisterUnknownIdIsNoOp() {
        registry.register(
            detectorId: "det-1",
            conversationId: "conv-a",
            windowId: "win-1",
            timestamp: 1000.0
        )
        registry.unregister(detectorId: "det-nonexistent")

        XCTAssertEqual(registry.activeCount, 1, "Unregistering an unknown ID should not affect existing entries")
    }

    func testReRegisterSameIdReplacesEntry() {
        registry.register(
            detectorId: "det-1",
            conversationId: "conv-a",
            windowId: "win-1",
            timestamp: 1000.0
        )
        registry.register(
            detectorId: "det-1",
            conversationId: "conv-b",
            windowId: "win-2",
            timestamp: 2000.0
        )

        XCTAssertEqual(registry.activeCount, 1, "Re-registering should replace, not add")

        let entries = registry.snapshot()
        XCTAssertEqual(entries.first?.conversationId, "conv-b")
        XCTAssertEqual(entries.first?.windowId, "win-2")
    }

    func testMultipleRegistrations() {
        registry.register(detectorId: "det-1", conversationId: "conv-a", windowId: "win-1", timestamp: 1000.0)
        registry.register(detectorId: "det-2", conversationId: "conv-a", windowId: "win-1", timestamp: 1001.0)
        registry.register(detectorId: "det-3", conversationId: "conv-b", windowId: "win-2", timestamp: 1002.0)

        XCTAssertEqual(registry.activeCount, 3)
    }

    // MARK: - Update

    func testUpdateChangesLastUpdatedAt() {
        registry.register(
            detectorId: "det-1",
            conversationId: "conv-a",
            windowId: "win-1",
            timestamp: 1000.0
        )

        registry.update(detectorId: "det-1", timestamp: 2000.0)

        let entry = registry.snapshot().first
        XCTAssertEqual(entry?.lastUpdatedAt, 2000.0)
        XCTAssertEqual(entry?.installedAt, 1000.0, "installedAt should not change on update")
    }

    func testUpdateChangesConversationId() {
        registry.register(
            detectorId: "det-1",
            conversationId: "conv-a",
            windowId: "win-1",
            timestamp: 1000.0
        )

        registry.update(detectorId: "det-1", timestamp: 2000.0, conversationId: "conv-b")

        let entry = registry.snapshot().first
        XCTAssertEqual(entry?.conversationId, "conv-b")
        XCTAssertEqual(entry?.windowId, "win-1", "windowId should not change when only conversationId is passed")
        XCTAssertEqual(entry?.lastUpdatedAt, 2000.0)
    }

    func testUpdateChangesWindowId() {
        registry.register(
            detectorId: "det-1",
            conversationId: "conv-a",
            windowId: "win-1",
            timestamp: 1000.0
        )

        registry.update(detectorId: "det-1", timestamp: 2000.0, windowId: "win-2")

        let entry = registry.snapshot().first
        XCTAssertEqual(entry?.conversationId, "conv-a", "conversationId should not change when only windowId is passed")
        XCTAssertEqual(entry?.windowId, "win-2")
    }

    func testUpdateChangesConversationAndWindowTogether() {
        registry.register(
            detectorId: "det-1",
            conversationId: "conv-a",
            windowId: "win-1",
            timestamp: 1000.0
        )

        registry.update(detectorId: "det-1", timestamp: 2000.0, conversationId: "conv-b", windowId: "win-2")

        let entry = registry.snapshot().first
        XCTAssertEqual(entry?.conversationId, "conv-b")
        XCTAssertEqual(entry?.windowId, "win-2")
        XCTAssertEqual(entry?.lastUpdatedAt, 2000.0)
        XCTAssertEqual(entry?.installedAt, 1000.0, "installedAt should not change on update")
    }

    func testUpdateConversationFixesStaleDuplicateDetection() {
        // Simulate two detectors both initially on conv-a/win-1 (a duplicate).
        registry.register(detectorId: "det-1", conversationId: "conv-a", windowId: "win-1", timestamp: 1000.0)
        registry.register(detectorId: "det-2", conversationId: "conv-a", windowId: "win-1", timestamp: 1001.0)

        XCTAssertTrue(registry.hasDuplicates(conversationId: "conv-a", windowId: "win-1"),
                       "Should detect duplicates before conversation switch")

        // Conversation switch: det-1 moves to conv-b.
        registry.update(detectorId: "det-1", timestamp: 2000.0, conversationId: "conv-b", windowId: "win-1")

        XCTAssertFalse(registry.hasDuplicates(conversationId: "conv-a", windowId: "win-1"),
                        "After det-1 moves to conv-b, conv-a/win-1 should have no duplicates")
        XCTAssertFalse(registry.hasDuplicates(conversationId: "conv-b", windowId: "win-1"),
                        "conv-b/win-1 should have only one detector")
    }

    func testUpdateWithNilConversationAndWindowPreservesExisting() {
        registry.register(
            detectorId: "det-1",
            conversationId: "conv-a",
            windowId: "win-1",
            timestamp: 1000.0
        )

        // Update with neither conversationId nor windowId — should only update timestamp.
        registry.update(detectorId: "det-1", timestamp: 2000.0)

        let entry = registry.snapshot().first
        XCTAssertEqual(entry?.conversationId, "conv-a")
        XCTAssertEqual(entry?.windowId, "win-1")
        XCTAssertEqual(entry?.lastUpdatedAt, 2000.0)
    }

    func testUpdateUnknownIdIsNoOp() {
        registry.register(
            detectorId: "det-1",
            conversationId: "conv-a",
            windowId: "win-1",
            timestamp: 1000.0
        )

        // Should not crash or create a new entry.
        registry.update(detectorId: "det-nonexistent", timestamp: 2000.0)

        XCTAssertEqual(registry.activeCount, 1)
    }

    // MARK: - Snapshot

    func testSnapshotReturnsAllEntries() {
        registry.register(detectorId: "det-1", conversationId: "conv-a", windowId: "win-1", timestamp: 1000.0)
        registry.register(detectorId: "det-2", conversationId: "conv-b", windowId: "win-2", timestamp: 1001.0)

        let snapshot = registry.snapshot()
        let ids = Set(snapshot.map(\.detectorId))
        XCTAssertEqual(ids, ["det-1", "det-2"])
    }

    func testSnapshotIsValueCopy() {
        registry.register(detectorId: "det-1", conversationId: "conv-a", windowId: "win-1", timestamp: 1000.0)

        let before = registry.snapshot()
        registry.register(detectorId: "det-2", conversationId: "conv-a", windowId: "win-1", timestamp: 1001.0)
        let after = registry.snapshot()

        XCTAssertEqual(before.count, 1, "Snapshot taken before second registration should have 1 entry")
        XCTAssertEqual(after.count, 2, "Snapshot taken after second registration should have 2 entries")
    }

    // MARK: - Entries by Conversation/Window

    func testEntriesFiltersByConversationAndWindow() {
        registry.register(detectorId: "det-1", conversationId: "conv-a", windowId: "win-1", timestamp: 1000.0)
        registry.register(detectorId: "det-2", conversationId: "conv-a", windowId: "win-1", timestamp: 1001.0)
        registry.register(detectorId: "det-3", conversationId: "conv-a", windowId: "win-2", timestamp: 1002.0)
        registry.register(detectorId: "det-4", conversationId: "conv-b", windowId: "win-1", timestamp: 1003.0)

        let matched = registry.entries(conversationId: "conv-a", windowId: "win-1")
        let matchedIds = Set(matched.map(\.detectorId))
        XCTAssertEqual(matchedIds, ["det-1", "det-2"])
    }

    // MARK: - Duplicate Detection

    func testNoDuplicatesWhenSingleDetectorPerPair() {
        registry.register(detectorId: "det-1", conversationId: "conv-a", windowId: "win-1", timestamp: 1000.0)
        registry.register(detectorId: "det-2", conversationId: "conv-b", windowId: "win-2", timestamp: 1001.0)

        let dups = registry.duplicates()
        XCTAssertTrue(dups.isEmpty, "No duplicates when each conversation/window pair has one detector")
    }

    func testDuplicatesDetectedForSameConversationAndWindow() {
        registry.register(detectorId: "det-1", conversationId: "conv-a", windowId: "win-1", timestamp: 1000.0)
        registry.register(detectorId: "det-2", conversationId: "conv-a", windowId: "win-1", timestamp: 1001.0)

        let dups = registry.duplicates()
        XCTAssertEqual(dups.count, 1)

        let report = dups[0]
        XCTAssertEqual(report.conversationId, "conv-a")
        XCTAssertEqual(report.windowId, "win-1")
        XCTAssertEqual(report.count, 2)
        XCTAssertEqual(report.detectorIds, ["det-1", "det-2"])
    }

    func testHasDuplicatesReturnsTrueWhenMultipleDetectors() {
        registry.register(detectorId: "det-1", conversationId: "conv-a", windowId: "win-1", timestamp: 1000.0)
        registry.register(detectorId: "det-2", conversationId: "conv-a", windowId: "win-1", timestamp: 1001.0)

        XCTAssertTrue(registry.hasDuplicates(conversationId: "conv-a", windowId: "win-1"))
        XCTAssertFalse(registry.hasDuplicates(conversationId: "conv-a", windowId: "win-2"))
    }

    func testDuplicateReportContainsSortedDetectorIds() {
        registry.register(detectorId: "det-z", conversationId: "conv-a", windowId: "win-1", timestamp: 1000.0)
        registry.register(detectorId: "det-a", conversationId: "conv-a", windowId: "win-1", timestamp: 1001.0)
        registry.register(detectorId: "det-m", conversationId: "conv-a", windowId: "win-1", timestamp: 1002.0)

        let report = registry.duplicates().first
        XCTAssertEqual(report?.detectorIds, ["det-a", "det-m", "det-z"], "Detector IDs should be sorted")
        XCTAssertEqual(report?.count, 3)
    }

    func testDuplicatesAcrossMultipleConversationWindowPairs() {
        // Two duplicates for conv-a/win-1.
        registry.register(detectorId: "det-1", conversationId: "conv-a", windowId: "win-1", timestamp: 1000.0)
        registry.register(detectorId: "det-2", conversationId: "conv-a", windowId: "win-1", timestamp: 1001.0)

        // Three duplicates for conv-b/win-2.
        registry.register(detectorId: "det-3", conversationId: "conv-b", windowId: "win-2", timestamp: 1002.0)
        registry.register(detectorId: "det-4", conversationId: "conv-b", windowId: "win-2", timestamp: 1003.0)
        registry.register(detectorId: "det-5", conversationId: "conv-b", windowId: "win-2", timestamp: 1004.0)

        // One singleton (no duplicate).
        registry.register(detectorId: "det-6", conversationId: "conv-c", windowId: "win-3", timestamp: 1005.0)

        let dups = registry.duplicates()
        XCTAssertEqual(dups.count, 2, "Should report two pairs with duplicates")

        let convAReport = dups.first { $0.conversationId == "conv-a" }
        XCTAssertEqual(convAReport?.count, 2)

        let convBReport = dups.first { $0.conversationId == "conv-b" }
        XCTAssertEqual(convBReport?.count, 3)
    }

    func testUnregisterClearsDuplicateCondition() {
        registry.register(detectorId: "det-1", conversationId: "conv-a", windowId: "win-1", timestamp: 1000.0)
        registry.register(detectorId: "det-2", conversationId: "conv-a", windowId: "win-1", timestamp: 1001.0)

        XCTAssertTrue(registry.hasDuplicates(conversationId: "conv-a", windowId: "win-1"))

        registry.unregister(detectorId: "det-2")

        XCTAssertFalse(registry.hasDuplicates(conversationId: "conv-a", windowId: "win-1"))
    }

    // MARK: - Stale Detection and Cleanup

    func testStaleEntriesReturnsOldEntries() {
        registry.register(detectorId: "det-1", conversationId: "conv-a", windowId: "win-1", timestamp: 1000.0)
        registry.register(detectorId: "det-2", conversationId: "conv-b", windowId: "win-2", timestamp: 1050.0)

        // At time 1070, with a 30-second threshold, det-1 (lastUpdated 1000) is stale
        // but det-2 (lastUpdated 1050) is not.
        let stale = registry.staleEntries(threshold: 30.0, now: 1070.0)
        XCTAssertEqual(stale.count, 1)
        XCTAssertEqual(stale.first?.detectorId, "det-1")
    }

    func testStaleEntriesRespectsUpdateTimestamp() {
        registry.register(detectorId: "det-1", conversationId: "conv-a", windowId: "win-1", timestamp: 1000.0)

        // Update det-1 to a recent timestamp.
        registry.update(detectorId: "det-1", timestamp: 1060.0)

        // At time 1070 with a 30-second threshold, det-1 is fresh (updated at 1060).
        let stale = registry.staleEntries(threshold: 30.0, now: 1070.0)
        XCTAssertTrue(stale.isEmpty, "Updated entry should not be stale")
    }

    func testPurgeStaleRemovesAndReturnsEntries() {
        registry.register(detectorId: "det-1", conversationId: "conv-a", windowId: "win-1", timestamp: 1000.0)
        registry.register(detectorId: "det-2", conversationId: "conv-b", windowId: "win-2", timestamp: 1050.0)

        let purged = registry.purgeStale(threshold: 30.0, now: 1070.0)
        XCTAssertEqual(purged.count, 1)
        XCTAssertEqual(purged.first?.detectorId, "det-1")
        XCTAssertEqual(registry.activeCount, 1, "Only the fresh entry should remain")
    }

    func testPurgeStaleIsIdempotent() {
        registry.register(detectorId: "det-1", conversationId: "conv-a", windowId: "win-1", timestamp: 1000.0)

        let first = registry.purgeStale(threshold: 30.0, now: 1070.0)
        XCTAssertEqual(first.count, 1)

        let second = registry.purgeStale(threshold: 30.0, now: 1070.0)
        XCTAssertTrue(second.isEmpty, "Second purge should find nothing to remove")
    }

    func testPurgeStaleWithNothingStale() {
        registry.register(detectorId: "det-1", conversationId: "conv-a", windowId: "win-1", timestamp: 1060.0)

        let purged = registry.purgeStale(threshold: 30.0, now: 1070.0)
        XCTAssertTrue(purged.isEmpty)
        XCTAssertEqual(registry.activeCount, 1)
    }

    // MARK: - RemoveAll

    func testRemoveAllClearsEverything() {
        registry.register(detectorId: "det-1", conversationId: "conv-a", windowId: "win-1", timestamp: 1000.0)
        registry.register(detectorId: "det-2", conversationId: "conv-b", windowId: "win-2", timestamp: 1001.0)

        registry.removeAll()

        XCTAssertEqual(registry.activeCount, 0)
        XCTAssertTrue(registry.snapshot().isEmpty)
        XCTAssertTrue(registry.duplicates().isEmpty)
    }

    // MARK: - Entry Equatable

    func testEntryEquatable() {
        let a = ScrollWheelDetectorRegistry.Entry(
            detectorId: "det-1",
            conversationId: "conv-a",
            windowId: "win-1",
            installedAt: 1000.0,
            lastUpdatedAt: 1000.0
        )
        let b = ScrollWheelDetectorRegistry.Entry(
            detectorId: "det-1",
            conversationId: "conv-a",
            windowId: "win-1",
            installedAt: 1000.0,
            lastUpdatedAt: 1000.0
        )
        var c = a
        c.lastUpdatedAt = 2000.0

        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, c)
    }
}
