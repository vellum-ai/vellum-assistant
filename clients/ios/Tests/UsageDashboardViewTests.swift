import XCTest
@testable import VellumAssistantShared

#if canImport(UIKit)
import SwiftUI
import UIKit
@testable import vellum_assistant_ios
#endif

/// Tests for the UsageDashboardStore states used by the iOS UsageDashboardView.
/// Covers idle/empty, loading, and populated summary states.
@MainActor
final class UsageDashboardViewTests: XCTestCase {

    private var mockClient: MockDaemonClient!
    private var store: UsageDashboardStore!

    override func setUp() {
        super.setUp()
        mockClient = MockDaemonClient()
        store = UsageDashboardStore(client: mockClient)
    }

    override func tearDown() {
        store = nil
        mockClient = nil
        super.tearDown()
    }

    // MARK: - Initial / Empty State

    func testInitialStateIsIdle() {
        XCTAssertEqual(store.totalsState, .idle)
        XCTAssertEqual(store.dailyState, .idle)
        XCTAssertEqual(store.breakdownState, .idle)
    }

    func testDefaultTimeRangeIsLast7Days() {
        XCTAssertEqual(store.selectedRange, .last7Days)
    }

    func testDefaultGroupByIsModel() {
        XCTAssertEqual(store.selectedGroupBy, .model)
    }

    // MARK: - Loading → Failed (mock returns nil)

    func testRefreshTransitionsToFailedWhenClientReturnsNil() async {
        // MockDaemonClient's default protocol extensions return nil for all
        // usage fetches, so refresh should transition to .failed.
        await store.refresh()

        if case .failed(let msg) = store.totalsState {
            XCTAssertFalse(msg.isEmpty, "Expected a non-empty failure message for totals")
        } else {
            XCTFail("Expected totalsState to be .failed, got \(store.totalsState)")
        }

        if case .failed(let msg) = store.dailyState {
            XCTAssertFalse(msg.isEmpty, "Expected a non-empty failure message for daily")
        } else {
            XCTFail("Expected dailyState to be .failed, got \(store.dailyState)")
        }

        if case .failed(let msg) = store.breakdownState {
            XCTAssertFalse(msg.isEmpty, "Expected a non-empty failure message for breakdown")
        } else {
            XCTFail("Expected breakdownState to be .failed, got \(store.breakdownState)")
        }
    }

    // MARK: - Populated State

    func testRefreshPopulatesLoadedStateWithStubClient() async {
        let stubClient = StubUsageDaemonClient()
        let populatedStore = UsageDashboardStore(client: stubClient)

        await populatedStore.refresh()

        if case .loaded(let totals) = populatedStore.totalsState {
            XCTAssertEqual(totals.totalInputTokens, 1000)
            XCTAssertEqual(totals.totalOutputTokens, 500)
            XCTAssertEqual(totals.totalCacheCreationTokens, 450)
            XCTAssertEqual(totals.totalCacheReadTokens, 12_300)
            XCTAssertEqual(totals.totalEstimatedCostUsd, 0.0042, accuracy: 0.0001)
            XCTAssertEqual(totals.eventCount, 3)
        } else {
            XCTFail("Expected totalsState to be .loaded, got \(populatedStore.totalsState)")
        }

        if case .loaded(let daily) = populatedStore.dailyState {
            XCTAssertEqual(daily.buckets.count, 2)
            XCTAssertEqual(daily.buckets[0].date, "2026-03-04")
            XCTAssertEqual(daily.buckets[1].date, "2026-03-05")
        } else {
            XCTFail("Expected dailyState to be .loaded, got \(populatedStore.dailyState)")
        }

        if case .loaded(let breakdown) = populatedStore.breakdownState {
            XCTAssertEqual(breakdown.breakdown.count, 2)
            XCTAssertEqual(breakdown.breakdown[0].group, "claude-sonnet-4-20250514")
            XCTAssertEqual(breakdown.breakdown[0].totalCacheCreationTokens, 120)
            XCTAssertEqual(breakdown.breakdown[0].totalCacheReadTokens, 9_876)
            let entry = breakdown.breakdown[0]
            let expectedSummary = "\(UsageFormatting.formatCount(700)) direct / \(UsageFormatting.formatCount(120)) cache created / \(UsageFormatting.formatCount(9_876)) cache read / \(UsageFormatting.formatCount(350)) out"
            XCTAssertEqual(UsageFormatting.formatBreakdownSummary(entry), expectedSummary)
        } else {
            XCTFail("Expected breakdownState to be .loaded, got \(populatedStore.breakdownState)")
        }
    }

    // MARK: - Range Selection

    func testSelectRangeUpdatesSelectedRange() async {
        await store.selectRange(.last30Days)
        XCTAssertEqual(store.selectedRange, .last30Days)
    }

    // MARK: - Group By Selection

    func testSelectGroupByUpdatesSelectedGroupBy() async {
        await store.selectGroupBy(.provider)
        XCTAssertEqual(store.selectedGroupBy, .provider)
    }

    func testTimeRangeEpochMillisRangeProducesValidBounds() {
        let referenceDate = Date(timeIntervalSince1970: 1_709_600_000)
        let range = UsageTimeRange.today.epochMillisRange(now: referenceDate)
        XCTAssertGreaterThan(range.to, range.from, "to should be after from")
        XCTAssertEqual(range.to, Int(referenceDate.timeIntervalSince1970 * 1000))
    }


    // MARK: - View Rendering Tests

    #if canImport(UIKit)

    func testViewRendersInIdleState() {
        let store = UsageDashboardStore(client: MockDaemonClient())
        let view = UsageDashboardView(store: store)
        let _ = view.body
    }

    func testViewRendersInFailedState() async {
        let client = MockDaemonClient()
        let store = UsageDashboardStore(client: client)
        await store.refresh()

        XCTAssertNotNil(store.totalsState)
        if case .failed = store.totalsState {} else {
            XCTFail("Expected totalsState to be .failed after nil fetch")
        }

        let view = UsageDashboardView(store: store)
        let _ = view.body
    }

    func testViewRendersInLoadedState() async {
        let client = StubUsageDaemonClient()
        let store = UsageDashboardStore(client: client)
        await store.refresh()

        if case .loaded = store.totalsState {} else {
            XCTFail("Expected totalsState to be .loaded")
        }

        // Data correctness is verified by testRefreshPopulatesLoadedStateWithStubClient.
        // Here we only confirm the view hierarchy builds without crashing in the
        // loaded state — extracting rendered text from SwiftUI's UIKit backing
        // views is unreliable in CI (10+ prior fix attempts).
        let view = UsageDashboardView(store: store)
        let _ = view.body
    }

    #endif

    // MARK: - Formatting Helpers (platform-independent)

    func testFormatCostProducesCurrencyString() {
        let result = UsageFormatting.formatCost(1.2345)
        // Verify it contains the expected digits regardless of locale-specific
        // currency symbol placement and decimal separator.
        XCTAssertTrue(result.contains("1"), "Formatted cost should contain the integer part")
        XCTAssertTrue(result.contains("2345"), "Formatted cost should contain 4 fraction digits")
    }

    func testFormatCostZero() {
        let result = UsageFormatting.formatCost(0)
        XCTAssertTrue(result.contains("0"), "Formatted zero cost should contain '0'")
        XCTAssertTrue(result.contains("0000"), "Formatted zero cost should show 4 fraction digits")
    }

    func testFormatCountUsesDecimalGrouping() {
        let result = UsageFormatting.formatCount(1_000_000)
        // The raw digit string without grouping would be "1000000".
        // Verify the formatter actually inserts grouping separators.
        XCTAssertNotEqual(result, "1000000", "formatCount should insert grouping separators, not return raw digits")
        let groupingSeparator = Locale.current.groupingSeparator ?? ","
        XCTAssertTrue(result.contains(groupingSeparator), "Formatted count should contain the locale grouping separator (\(groupingSeparator))")
    }
}

// MARK: - Stub Client

/// A stub that returns canned usage data for populated-state tests.
/// Implements `DaemonClientProtocol` directly since `MockDaemonClient` is final.
@MainActor
private final class StubUsageDaemonClient: DaemonClientProtocol {
    var isConnected: Bool = false

    func subscribe() -> AsyncStream<ServerMessage> {
        AsyncStream { $0.finish() }
    }

    func send<T: Encodable>(_ message: T) throws {}
    func connect() async throws {}
    func disconnect() {}
    func startSSE() {}
    func stopSSE() {}

    func fetchUsageTotals(from: Int, to: Int) async -> UsageTotalsResponse? {
        UsageTotalsResponse(
            totalInputTokens: 1000,
            totalOutputTokens: 500,
            totalCacheCreationTokens: 450,
            totalCacheReadTokens: 12_300,
            totalEstimatedCostUsd: 0.0042,
            eventCount: 3,
            pricedEventCount: 2,
            unpricedEventCount: 1
        )
    }

    func fetchUsageDaily(from: Int, to: Int) async -> UsageDailyResponse? {
        UsageDailyResponse(buckets: [
            UsageDayBucket(date: "2026-03-04", totalInputTokens: 600, totalOutputTokens: 300, totalEstimatedCostUsd: 0.0025, eventCount: 2),
            UsageDayBucket(date: "2026-03-05", totalInputTokens: 400, totalOutputTokens: 200, totalEstimatedCostUsd: 0.0017, eventCount: 1),
        ])
    }

    func fetchUsageBreakdown(from: Int, to: Int, groupBy: String) async -> UsageBreakdownResponse? {
        UsageBreakdownResponse(breakdown: [
            UsageGroupBreakdownEntry(
                group: "claude-sonnet-4-20250514",
                totalInputTokens: 700,
                totalOutputTokens: 350,
                totalCacheCreationTokens: 120,
                totalCacheReadTokens: 9_876,
                totalEstimatedCostUsd: 0.003,
                eventCount: 2
            ),
            UsageGroupBreakdownEntry(
                group: "claude-haiku-3-20240307",
                totalInputTokens: 300,
                totalOutputTokens: 150,
                totalCacheCreationTokens: 330,
                totalCacheReadTokens: 2_424,
                totalEstimatedCostUsd: 0.0012,
                eventCount: 1
            ),
        ])
    }
}
