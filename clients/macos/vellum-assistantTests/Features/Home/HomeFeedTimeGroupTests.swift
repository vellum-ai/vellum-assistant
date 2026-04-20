import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Unit tests for ``HomeFeedTimeGroup/bucket(_:now:calendar:)``.
///
/// All tests that care about day boundaries drive the helper with a
/// fixed `now` and a calendar pinned to a single time zone so they are
/// deterministic regardless of the runner's locale or the real clock.
final class HomeFeedTimeGroupTests: XCTestCase {

    // MARK: - Fixtures

    /// Canonical "reference now" used throughout the day-boundary tests:
    /// 2025-06-15 12:00:00 UTC.
    private let referenceNow = Date(timeIntervalSince1970: 1_749_988_800)

    private func utcCalendar() -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private func makeItem(
        id: String,
        createdAt: Date
    ) -> FeedItem {
        FeedItem(
            id: id,
            type: .nudge,
            priority: 50,
            title: "t-\(id)",
            summary: "s-\(id)",
            source: nil,
            timestamp: createdAt,
            status: .new,
            expiresAt: nil,
            minTimeAway: nil,
            actions: nil,
            urgency: nil,
            author: .assistant,
            createdAt: createdAt
        )
    }

    // MARK: - Tests

    func testEmptyInputReturnsEmptyArray() {
        let groups = HomeFeedTimeGroup.bucket([], now: referenceNow, calendar: utcCalendar())
        XCTAssertTrue(groups.isEmpty)
    }

    func testThreeBucketsReturnedInCanonicalOrder() {
        let calendar = utcCalendar()

        let todayItem = makeItem(
            id: "today",
            createdAt: referenceNow  // same day as reference now (UTC)
        )
        let yesterdayItem = makeItem(
            id: "yesterday",
            createdAt: referenceNow.addingTimeInterval(-86_400)
        )
        let olderItem = makeItem(
            id: "older",
            createdAt: referenceNow.addingTimeInterval(-10 * 86_400)
        )

        // Deliberately pass in non-canonical order.
        let groups = HomeFeedTimeGroup.bucket(
            [olderItem, todayItem, yesterdayItem],
            now: referenceNow,
            calendar: calendar
        )

        XCTAssertEqual(groups.count, 3)
        XCTAssertEqual(groups[0].group, .today)
        XCTAssertEqual(groups[0].items.map(\.id), ["today"])
        XCTAssertEqual(groups[1].group, .yesterday)
        XCTAssertEqual(groups[1].items.map(\.id), ["yesterday"])
        XCTAssertEqual(groups[2].group, .older)
        XCTAssertEqual(groups[2].items.map(\.id), ["older"])
    }

    func testOnlyOlderReturnsSingleGroup() {
        let calendar = utcCalendar()
        let items = [
            makeItem(id: "a", createdAt: referenceNow.addingTimeInterval(-7 * 86_400)),
            makeItem(id: "b", createdAt: referenceNow.addingTimeInterval(-30 * 86_400)),
        ]

        let groups = HomeFeedTimeGroup.bucket(items, now: referenceNow, calendar: calendar)

        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].group, .older)
        XCTAssertEqual(groups[0].items.map(\.id), ["a", "b"])
    }

    func testInputOrderPreservedWithinBucket() {
        let calendar = utcCalendar()
        let first = makeItem(
            id: "first",
            createdAt: referenceNow.addingTimeInterval(-3_600)
        )
        let second = makeItem(
            id: "second",
            createdAt: referenceNow.addingTimeInterval(-7_200)
        )

        let groups = HomeFeedTimeGroup.bucket([first, second], now: referenceNow, calendar: calendar)

        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].group, .today)
        // The helper must NOT re-sort — input order owns.
        XCTAssertEqual(groups[0].items.map(\.id), ["first", "second"])
    }

    func testMidnightBoundary() {
        let calendar = utcCalendar()

        // Start of "today" in UTC for the reference `now`.
        let startOfToday = calendar.startOfDay(for: referenceNow)
        let oneSecondBefore = startOfToday.addingTimeInterval(-1)

        let atMidnight = makeItem(id: "midnight", createdAt: startOfToday)
        let justBefore = makeItem(id: "before", createdAt: oneSecondBefore)

        let groups = HomeFeedTimeGroup.bucket(
            [atMidnight, justBefore],
            now: referenceNow,
            calendar: calendar
        )

        // Exactly midnight → today bucket.
        // One second earlier → yesterday bucket.
        XCTAssertEqual(groups.count, 2)
        XCTAssertEqual(groups[0].group, .today)
        XCTAssertEqual(groups[0].items.map(\.id), ["midnight"])
        XCTAssertEqual(groups[1].group, .yesterday)
        XCTAssertEqual(groups[1].items.map(\.id), ["before"])
    }
}
