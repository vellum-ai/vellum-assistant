import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Unit tests for ``HomeFeedGrouping/group(_:)``.
final class HomeFeedGroupingTests: XCTestCase {

    // MARK: - Fixtures

    private func makeItem(
        id: String,
        type: FeedItemType = .digest,
        priority: Int
    ) -> FeedItem {
        let now = Date()
        return FeedItem(
            id: id,
            type: type,
            priority: priority,
            title: "t-\(id)",
            summary: "s-\(id)",
            source: nil,
            timestamp: now,
            status: .new,
            expiresAt: nil,
            minTimeAway: nil,
            actions: nil,
            urgency: nil,
            author: .assistant,
            createdAt: now
        )
    }

    // MARK: - Tests

    func test_emptyInput_returnsEmpty() {
        XCTAssertTrue(HomeFeedGrouping.group([]).isEmpty)
    }

    func test_allHighPriorityDigests_allSingle() {
        let items = [
            makeItem(id: "a", priority: 90),
            makeItem(id: "b", priority: 80),
            makeItem(id: "c", priority: 70),
            makeItem(id: "d", priority: 60),
        ]

        let rows = HomeFeedGrouping.group(items)

        XCTAssertEqual(rows.count, 4)
        for (index, row) in rows.enumerated() {
            guard case .single(let item) = row else {
                XCTFail("Expected .single at index \(index), got \(row)")
                return
            }
            XCTAssertEqual(item.id, items[index].id)
        }
    }

    func test_fourLowPriorityDigests_producesOneGroup() {
        let items = [
            makeItem(id: "a", priority: 20),
            makeItem(id: "b", priority: 15),
            makeItem(id: "c", priority: 10),
            makeItem(id: "d", priority: 5),
        ]

        let rows = HomeFeedGrouping.group(items)

        XCTAssertEqual(rows.count, 1)
        guard case .group(let parent, let children) = rows[0] else {
            XCTFail("Expected .group, got \(rows[0])")
            return
        }
        XCTAssertEqual(parent.id, "a")
        XCTAssertEqual(children.map(\.id), ["b", "c", "d"])
    }

    func test_mixedTypes_digestsGroupedOthersSingle() {
        let items = [
            makeItem(id: "nudge1", type: .nudge, priority: 50),
            makeItem(id: "d10", type: .digest, priority: 10),
            makeItem(id: "d9", type: .digest, priority: 9),
            makeItem(id: "d8", type: .digest, priority: 8),
            makeItem(id: "action1", type: .action, priority: 50),
            makeItem(id: "d7", type: .digest, priority: 7),
        ]

        let rows = HomeFeedGrouping.group(items)

        XCTAssertEqual(rows.count, 4)

        guard case .single(let first) = rows[0] else {
            XCTFail("Expected .single at index 0, got \(rows[0])")
            return
        }
        XCTAssertEqual(first.id, "nudge1")

        guard case .group(let parent, let children) = rows[1] else {
            XCTFail("Expected .group at index 1, got \(rows[1])")
            return
        }
        XCTAssertEqual(parent.id, "d10")
        XCTAssertEqual(children.map(\.id), ["d9", "d8"])

        guard case .single(let third) = rows[2] else {
            XCTFail("Expected .single at index 2, got \(rows[2])")
            return
        }
        XCTAssertEqual(third.id, "action1")

        guard case .single(let fourth) = rows[3] else {
            XCTFail("Expected .single at index 3, got \(rows[3])")
            return
        }
        XCTAssertEqual(fourth.id, "d7")
    }

    func test_runOfTwo_notGrouped() {
        let items = [
            makeItem(id: "a", priority: 10),
            makeItem(id: "b", priority: 5),
        ]

        let rows = HomeFeedGrouping.group(items)

        XCTAssertEqual(rows.count, 2)
        guard case .single(let first) = rows[0], case .single(let second) = rows[1] else {
            XCTFail("Expected two .single rows, got \(rows)")
            return
        }
        XCTAssertEqual(first.id, "a")
        XCTAssertEqual(second.id, "b")
    }

    func test_ordersPreserved() {
        let items = [
            makeItem(id: "n1", type: .nudge, priority: 80),
            makeItem(id: "d1", type: .digest, priority: 20),
            makeItem(id: "d2", type: .digest, priority: 19),
            makeItem(id: "d3", type: .digest, priority: 18),
            makeItem(id: "d4", type: .digest, priority: 17),
            makeItem(id: "a1", type: .action, priority: 60),
            makeItem(id: "n2", type: .nudge, priority: 40),
        ]

        let rows = HomeFeedGrouping.group(items)

        // Expected emission order: n1 single, group(d1 -> [d2, d3, d4]), a1 single, n2 single
        let emittedIDs = rows.map(\.id)
        XCTAssertEqual(emittedIDs, ["n1", "d1", "a1", "n2"])

        guard case .group(let parent, let children) = rows[1] else {
            XCTFail("Expected .group at index 1, got \(rows[1])")
            return
        }
        XCTAssertEqual(parent.id, "d1")
        XCTAssertEqual(children.map(\.id), ["d2", "d3", "d4"])
    }
}
