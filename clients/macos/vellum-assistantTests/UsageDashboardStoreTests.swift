import Foundation
import Testing
@testable import VellumAssistantShared

// MARK: - Mock Client

@MainActor
private final class MockUsageClient: DaemonClientProtocol {
    var isConnected: Bool = true
    var isBlobTransportAvailable: Bool = false

    func subscribe() -> AsyncStream<ServerMessage> { AsyncStream { $0.finish() } }
    func send<T: Encodable>(_ message: T) throws {}
    func connect() async throws {}
    func disconnect() {}
    func startSSE() {}
    func stopSSE() {}

    var stubbedTotals: UsageTotalsResponse?
    var stubbedDaily: UsageDailyResponse?
    var stubbedBreakdown: UsageBreakdownResponse?

    var lastTotalsFrom: Int?
    var lastTotalsTo: Int?
    var lastDailyFrom: Int?
    var lastDailyTo: Int?
    var lastBreakdownFrom: Int?
    var lastBreakdownTo: Int?
    var lastBreakdownGroupBy: String?

    func fetchUsageTotals(from: Int, to: Int) async -> UsageTotalsResponse? {
        lastTotalsFrom = from
        lastTotalsTo = to
        return stubbedTotals
    }

    func fetchUsageDaily(from: Int, to: Int) async -> UsageDailyResponse? {
        lastDailyFrom = from
        lastDailyTo = to
        return stubbedDaily
    }

    func fetchUsageBreakdown(from: Int, to: Int, groupBy: String) async -> UsageBreakdownResponse? {
        lastBreakdownFrom = from
        lastBreakdownTo = to
        lastBreakdownGroupBy = groupBy
        return stubbedBreakdown
    }
}

// MARK: - JSON Decoding Tests

@Suite("UsageDashboardStore — JSON Decoding")
struct UsageDashboardStoreDecodingTests {

    @Test
    func decodeTotalsResponse() throws {
        let json = """
        {
            "totalInputTokens": 1000,
            "totalOutputTokens": 500,
            "totalCacheCreationTokens": 200,
            "totalCacheReadTokens": 100,
            "totalEstimatedCostUsd": 0.05,
            "eventCount": 10,
            "pricedEventCount": 8,
            "unpricedEventCount": 2
        }
        """
        let decoded = try JSONDecoder().decode(UsageTotalsResponse.self, from: Data(json.utf8))
        #expect(decoded.totalInputTokens == 1000)
        #expect(decoded.totalOutputTokens == 500)
        #expect(decoded.totalCacheCreationTokens == 200)
        #expect(decoded.totalCacheReadTokens == 100)
        #expect(decoded.totalEstimatedCostUsd == 0.05)
        #expect(decoded.eventCount == 10)
        #expect(decoded.pricedEventCount == 8)
        #expect(decoded.unpricedEventCount == 2)
    }

    @Test
    func decodeDailyResponse() throws {
        let json = """
        {
            "buckets": [
                {
                    "date": "2026-03-01",
                    "totalInputTokens": 400,
                    "totalOutputTokens": 200,
                    "totalEstimatedCostUsd": 0.02,
                    "eventCount": 3
                },
                {
                    "date": "2026-03-02",
                    "totalInputTokens": 600,
                    "totalOutputTokens": 300,
                    "totalEstimatedCostUsd": 0.03,
                    "eventCount": 7
                }
            ]
        }
        """
        let decoded = try JSONDecoder().decode(UsageDailyResponse.self, from: Data(json.utf8))
        #expect(decoded.buckets.count == 2)
        #expect(decoded.buckets[0].date == "2026-03-01")
        #expect(decoded.buckets[0].totalInputTokens == 400)
        #expect(decoded.buckets[1].date == "2026-03-02")
        #expect(decoded.buckets[1].eventCount == 7)
    }

    @Test
    func decodeBreakdownResponse() throws {
        let json = """
        {
            "breakdown": [
                {
                    "group": "claude-sonnet-4-20250514",
                    "totalInputTokens": 800,
                    "totalOutputTokens": 400,
                    "totalEstimatedCostUsd": 0.04,
                    "eventCount": 5
                },
                {
                    "group": "claude-haiku-3",
                    "totalInputTokens": 200,
                    "totalOutputTokens": 100,
                    "totalEstimatedCostUsd": 0.01,
                    "eventCount": 5
                }
            ]
        }
        """
        let decoded = try JSONDecoder().decode(UsageBreakdownResponse.self, from: Data(json.utf8))
        #expect(decoded.breakdown.count == 2)
        #expect(decoded.breakdown[0].group == "claude-sonnet-4-20250514")
        #expect(decoded.breakdown[0].totalInputTokens == 800)
        #expect(decoded.breakdown[1].group == "claude-haiku-3")
        #expect(decoded.breakdown[1].totalEstimatedCostUsd == 0.01)
    }
}

// MARK: - Loading State Tests

@Suite("UsageDashboardStore — Loading States")
struct UsageDashboardStoreLoadingTests {

    @Test @MainActor
    func refreshTransitionsToLoadedOnSuccess() async {
        let client = MockUsageClient()
        client.stubbedTotals = UsageTotalsResponse(
            totalInputTokens: 100, totalOutputTokens: 50,
            totalCacheCreationTokens: 10, totalCacheReadTokens: 5,
            totalEstimatedCostUsd: 0.01, eventCount: 3,
            pricedEventCount: 2, unpricedEventCount: 1
        )
        client.stubbedDaily = UsageDailyResponse(buckets: [
            UsageDayBucket(date: "2026-03-05", totalInputTokens: 100, totalOutputTokens: 50, totalEstimatedCostUsd: 0.01, eventCount: 3)
        ])
        client.stubbedBreakdown = UsageBreakdownResponse(breakdown: [
            UsageGroupBreakdownEntry(group: "model-a", totalInputTokens: 100, totalOutputTokens: 50, totalEstimatedCostUsd: 0.01, eventCount: 3)
        ])

        let store = UsageDashboardStore(client: client)
        #expect(store.totalsState == .idle)
        #expect(store.dailyState == .idle)
        #expect(store.breakdownState == .idle)

        await store.refresh()

        if case .loaded(let totals) = store.totalsState {
            #expect(totals.totalInputTokens == 100)
            #expect(totals.eventCount == 3)
        } else {
            Issue.record("Expected .loaded state for totals")
        }

        if case .loaded(let daily) = store.dailyState {
            #expect(daily.buckets.count == 1)
            #expect(daily.buckets[0].date == "2026-03-05")
        } else {
            Issue.record("Expected .loaded state for daily")
        }

        if case .loaded(let breakdown) = store.breakdownState {
            #expect(breakdown.breakdown.count == 1)
            #expect(breakdown.breakdown[0].group == "model-a")
        } else {
            Issue.record("Expected .loaded state for breakdown")
        }
    }

    @Test @MainActor
    func refreshTransitionsToFailedOnNilResponse() async {
        let client = MockUsageClient()
        // All stubs nil by default — simulates network failure.

        let store = UsageDashboardStore(client: client)
        await store.refresh()

        if case .failed(let msg) = store.totalsState {
            #expect(msg.contains("totals"))
        } else {
            Issue.record("Expected .failed state for totals")
        }

        if case .failed(let msg) = store.dailyState {
            #expect(msg.contains("daily"))
        } else {
            Issue.record("Expected .failed state for daily")
        }

        if case .failed(let msg) = store.breakdownState {
            #expect(msg.contains("breakdown"))
        } else {
            Issue.record("Expected .failed state for breakdown")
        }
    }

    @Test @MainActor
    func selectRangeChangesRangeAndRefreshes() async {
        let client = MockUsageClient()
        client.stubbedTotals = UsageTotalsResponse(
            totalInputTokens: 0, totalOutputTokens: 0,
            totalCacheCreationTokens: 0, totalCacheReadTokens: 0,
            totalEstimatedCostUsd: 0, eventCount: 0,
            pricedEventCount: 0, unpricedEventCount: 0
        )
        client.stubbedDaily = UsageDailyResponse(buckets: [])
        client.stubbedBreakdown = UsageBreakdownResponse(breakdown: [])

        let store = UsageDashboardStore(client: client)
        #expect(store.selectedRange == .last7Days)

        await store.selectRange(.last30Days)
        #expect(store.selectedRange == .last30Days)

        // Verify the client was called with non-nil range params
        #expect(client.lastTotalsFrom != nil)
        #expect(client.lastTotalsTo != nil)
    }
}

// MARK: - Grouped Summary Derivation

@Suite("UsageDashboardStore — Grouped Summaries")
struct UsageDashboardStoreGroupTests {

    @Test @MainActor
    func selectGroupByRefreshesBreakdownOnly() async {
        let client = MockUsageClient()
        client.stubbedTotals = UsageTotalsResponse(
            totalInputTokens: 100, totalOutputTokens: 50,
            totalCacheCreationTokens: 0, totalCacheReadTokens: 0,
            totalEstimatedCostUsd: 0.01, eventCount: 1,
            pricedEventCount: 1, unpricedEventCount: 0
        )
        client.stubbedDaily = UsageDailyResponse(buckets: [])
        client.stubbedBreakdown = UsageBreakdownResponse(breakdown: [
            UsageGroupBreakdownEntry(group: "anthropic", totalInputTokens: 100, totalOutputTokens: 50, totalEstimatedCostUsd: 0.01, eventCount: 1)
        ])

        let store = UsageDashboardStore(client: client)

        // Initial refresh to populate all states
        await store.refresh()
        #expect(client.lastBreakdownGroupBy == "model")

        // Now change group-by — should only re-fetch breakdown
        client.stubbedBreakdown = UsageBreakdownResponse(breakdown: [
            UsageGroupBreakdownEntry(group: "provider-x", totalInputTokens: 50, totalOutputTokens: 25, totalEstimatedCostUsd: 0.005, eventCount: 1)
        ])
        await store.selectGroupBy(.provider)

        #expect(store.selectedGroupBy == .provider)
        #expect(client.lastBreakdownGroupBy == "provider")

        if case .loaded(let breakdown) = store.breakdownState {
            #expect(breakdown.breakdown[0].group == "provider-x")
        } else {
            Issue.record("Expected .loaded state for breakdown after selectGroupBy")
        }
    }

    @Test @MainActor
    func breakdownGroupedByActorPassesCorrectParam() async {
        let client = MockUsageClient()
        client.stubbedBreakdown = UsageBreakdownResponse(breakdown: [])

        let store = UsageDashboardStore(client: client)
        await store.selectGroupBy(.actor)

        #expect(client.lastBreakdownGroupBy == "actor")
    }
}

// MARK: - Time Range Bounds

@Suite("UsageTimeRange — Epoch Bounds")
struct UsageTimeRangeTests {

    @Test
    func todayRangeStartsAtMidnight() {
        let now = Date(timeIntervalSince1970: 1709683200) // 2024-03-06 00:00:00 UTC
        let range = UsageTimeRange.today.epochMillisRange(now: now)

        let calendar = Calendar(identifier: .gregorian)
        let startOfDay = calendar.startOfDay(for: now)
        let expectedFrom = Int(startOfDay.timeIntervalSince1970 * 1000)

        #expect(range.from == expectedFrom)
        #expect(range.to == Int(now.timeIntervalSince1970 * 1000))
    }

    @Test
    func last7DaysSpansSixDaysBack() {
        let now = Date(timeIntervalSince1970: 1709683200) // 2024-03-06 00:00:00 UTC
        let range = UsageTimeRange.last7Days.epochMillisRange(now: now)

        let calendar = Calendar(identifier: .gregorian)
        let startOfToday = calendar.startOfDay(for: now)
        let sixDaysAgo = calendar.date(byAdding: .day, value: -6, to: startOfToday)!
        let expectedFrom = Int(sixDaysAgo.timeIntervalSince1970 * 1000)

        #expect(range.from == expectedFrom)
        #expect(range.to == Int(now.timeIntervalSince1970 * 1000))
    }

    @Test
    func fromIsAlwaysLessThanOrEqualToTo() {
        for timeRange in UsageTimeRange.allCases {
            let range = timeRange.epochMillisRange()
            #expect(range.from <= range.to, "from should be <= to for \(timeRange.rawValue)")
        }
    }
}
