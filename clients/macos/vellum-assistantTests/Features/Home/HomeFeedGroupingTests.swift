import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Unit tests for ``HomeFeedGrouping/group(_:)``.
final class HomeFeedGroupingTests: XCTestCase {

    // MARK: - Fixtures

    private func makeItem(
        id: String,
        type: FeedItemType = .notification,
        priority: Int
    ) -> FeedItem {
        let now = Date()
        return FeedItem(
            id: id,
            type: type,
            priority: priority,
            title: "t-\(id)",
            summary: "s-\(id)",
            timestamp: now,
            status: .new,
            expiresAt: nil,
            actions: nil,
            urgency: nil,
            createdAt: now
        )
    }

    // MARK: - Tests

    func test_emptyInput_returnsEmpty() {
        XCTAssertTrue(HomeFeedGrouping.group([]).isEmpty)
    }

    func test_allHighPriority_allSingle() {
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

    func test_fourLowPriority_producesOneGroup() {
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

    /// Pre-v2 the grouping eligibility check required `type == .digest`,
    /// so non-digest items would always interrupt a low-priority run.
    /// With v2 collapsing types to a single `.notification`, only the
    /// priority threshold breaks runs — so a high-priority item between
    /// two low-priority runs still acts as a divider here.
    func test_mixedPriorities_groupsBrokenByHighPriorityItems() {
        let items = [
            makeItem(id: "high1", priority: 50),
            makeItem(id: "low10", priority: 10),
            makeItem(id: "low9",  priority: 9),
            makeItem(id: "low8",  priority: 8),
            makeItem(id: "high2", priority: 50),
            makeItem(id: "low7",  priority: 7),
        ]

        let rows = HomeFeedGrouping.group(items)

        XCTAssertEqual(rows.count, 4)

        guard case .single(let first) = rows[0] else {
            XCTFail("Expected .single at index 0, got \(rows[0])")
            return
        }
        XCTAssertEqual(first.id, "high1")

        guard case .group(let parent, let children) = rows[1] else {
            XCTFail("Expected .group at index 1, got \(rows[1])")
            return
        }
        XCTAssertEqual(parent.id, "low10")
        XCTAssertEqual(children.map(\.id), ["low9", "low8"])

        guard case .single(let third) = rows[2] else {
            XCTFail("Expected .single at index 2, got \(rows[2])")
            return
        }
        XCTAssertEqual(third.id, "high2")

        guard case .single(let fourth) = rows[3] else {
            XCTFail("Expected .single at index 3, got \(rows[3])")
            return
        }
        XCTAssertEqual(fourth.id, "low7")
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
            makeItem(id: "h1", priority: 80),
            makeItem(id: "l1", priority: 20),
            makeItem(id: "l2", priority: 19),
            makeItem(id: "l3", priority: 18),
            makeItem(id: "l4", priority: 17),
            makeItem(id: "h2", priority: 60),
            makeItem(id: "h3", priority: 40),
        ]

        let rows = HomeFeedGrouping.group(items)

        // Expected emission order: h1 single, group(l1 -> [l2, l3, l4]), h2 single, h3 single
        let emittedIDs = rows.map(\.id)
        XCTAssertEqual(emittedIDs, ["h1", "l1", "h2", "h3"])

        guard case .group(let parent, let children) = rows[1] else {
            XCTFail("Expected .group at index 1, got \(rows[1])")
            return
        }
        XCTAssertEqual(parent.id, "l1")
        XCTAssertEqual(children.map(\.id), ["l2", "l3", "l4"])
    }
}
