import Foundation
import Testing
@testable import VellumAssistantShared

// MARK: - Mock Client

@MainActor
private final class MockUsageClient: UsageClientProtocol {
    var stubbedTotals: UsageTotalsResponse?
    var stubbedDaily: UsageDailyResponse?
    var stubbedSeries: UsageSeriesResponse?
    var stubbedBreakdown: UsageBreakdownResponse?
    var simulateMissingSeriesEndpoint = false

    var lastTotalsFrom: Int?
    var lastTotalsTo: Int?
    var lastDailyFrom: Int?
    var lastDailyTo: Int?
    var lastDailyTz: String?
    var lastDailyGranularity: String?
    var lastSeriesFrom: Int?
    var lastSeriesTo: Int?
    var lastSeriesTz: String?
    var lastSeriesGranularity: String?
    var lastSeriesGroupBy: String?
    var lastBreakdownFrom: Int?
    var lastBreakdownTo: Int?
    var lastBreakdownGroupBy: String?

    func fetchUsageTotals(from: Int, to: Int) async -> UsageTotalsResponse? {
        lastTotalsFrom = from
        lastTotalsTo = to
        return stubbedTotals
    }

    func fetchUsageDaily(from: Int, to: Int, granularity: String, tz: String) async -> UsageDailyResponse? {
        lastDailyFrom = from
        lastDailyTo = to
        lastDailyGranularity = granularity
        lastDailyTz = tz
        return stubbedDaily
    }

    func fetchUsageSeries(from: Int, to: Int, granularity: String, groupBy: String, tz: String) async -> UsageSeriesResponse? {
        lastSeriesFrom = from
        lastSeriesTo = to
        lastSeriesGranularity = granularity
        lastSeriesGroupBy = groupBy
        lastSeriesTz = tz
        if simulateMissingSeriesEndpoint {
            return nil
        }
        if let stubbedSeries {
            return stubbedSeries
        }
        guard let daily = stubbedDaily else {
            return nil
        }
        return UsageSeriesResponse(
            buckets: daily.buckets.map { bucket in
                UsageSeriesBucket(
                    bucketId: bucket.bucketId,
                    date: bucket.date,
                    displayLabel: bucket.displayLabel,
                    totalInputTokens: bucket.totalInputTokens,
                    totalOutputTokens: bucket.totalOutputTokens,
                    totalEstimatedCostUsd: bucket.totalEstimatedCostUsd,
                    eventCount: bucket.eventCount,
                    groups: [:]
                )
            }
        )
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
                    "totalCacheCreationTokens": 120,
                    "totalCacheReadTokens": 240,
                    "totalEstimatedCostUsd": 0.04,
                    "eventCount": 5
                },
                {
                    "group": "claude-haiku-3",
                    "totalInputTokens": 200,
                    "totalOutputTokens": 100,
                    "totalCacheCreationTokens": 0,
                    "totalCacheReadTokens": 40,
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
        #expect(decoded.breakdown[0].totalCacheCreationTokens == 120)
        #expect(decoded.breakdown[0].totalCacheReadTokens == 240)
        #expect(decoded.breakdown[1].group == "claude-haiku-3")
        #expect(decoded.breakdown[1].totalCacheReadTokens == 40)
        #expect(decoded.breakdown[1].totalEstimatedCostUsd == 0.01)
    }

    @Test
    func decodeBreakdownResponseWithGroupKey() throws {
        let json = """
        {
            "breakdown": [
                {
                    "group": "Main agent",
                    "groupKey": "mainAgent",
                    "totalInputTokens": 800,
                    "totalOutputTokens": 400,
                    "totalEstimatedCostUsd": 0.04,
                    "eventCount": 5
                }
            ]
        }
        """
        let decoded = try JSONDecoder().decode(UsageBreakdownResponse.self, from: Data(json.utf8))
        #expect(decoded.breakdown[0].group == "Main agent")
        #expect(decoded.breakdown[0].groupKey == "mainAgent")
    }

    @Test
    func decodeSeriesResponseWithGroups() throws {
        let json = """
        {
            "buckets": [
                {
                    "bucketId": "2026-03-01",
                    "date": "2026-03-01",
                    "displayLabel": "Mar 1",
                    "totalInputTokens": 800,
                    "totalOutputTokens": 400,
                    "totalEstimatedCostUsd": 0.04,
                    "eventCount": 5,
                    "groups": {
                        "value:mainAgent": {
                            "group": "Main agent",
                            "groupKey": "mainAgent",
                            "totalInputTokens": 500,
                            "totalOutputTokens": 250,
                            "totalEstimatedCostUsd": 0.03,
                            "eventCount": 3
                        }
                    }
                }
            ]
        }
        """
        let decoded = try JSONDecoder().decode(UsageSeriesResponse.self, from: Data(json.utf8))
        #expect(decoded.buckets.count == 1)
        #expect(decoded.buckets[0].bucketId == "2026-03-01")
        #expect(decoded.buckets[0].displayLabel == "Mar 1")
        #expect(decoded.buckets[0].groups["value:mainAgent"]?.group == "Main agent")
        #expect(decoded.buckets[0].groups["value:mainAgent"]?.groupKey == "mainAgent")
    }

    @Test
    func decodeBreakdownResponseDefaultsMissingCacheFieldsToZero() throws {
        let json = """
        {
            "breakdown": [
                {
                    "group": "legacy-row",
                    "totalInputTokens": 150,
                    "totalOutputTokens": 75,
                    "totalEstimatedCostUsd": 0.02,
                    "eventCount": 2
                }
            ]
        }
        """
        let decoded = try JSONDecoder().decode(UsageBreakdownResponse.self, from: Data(json.utf8))
        #expect(decoded.breakdown.count == 1)
        #expect(decoded.breakdown[0].totalCacheCreationTokens == 0)
        #expect(decoded.breakdown[0].totalCacheReadTokens == 0)
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
            UsageGroupBreakdownEntry(
                group: "model-a",
                totalInputTokens: 100,
                totalOutputTokens: 50,
                totalCacheCreationTokens: 10,
                totalCacheReadTokens: 5,
                totalEstimatedCostUsd: 0.01,
                eventCount: 3
            )
        ])

        let store = UsageDashboardStore()
        store.updateClient(client)
        #expect(store.totalsState == .idle)
        #expect(store.dailyState == .idle)
        #expect(store.seriesState == .idle)
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

        if case .loaded(let series) = store.seriesState {
            #expect(series.buckets.count == 1)
            #expect(series.buckets[0].date == "2026-03-05")
        } else {
            Issue.record("Expected .loaded state for series")
        }

        if case .loaded(let breakdown) = store.breakdownState {
            #expect(breakdown.breakdown.count == 1)
            #expect(breakdown.breakdown[0].group == "model-a")
            #expect(breakdown.breakdown[0].totalCacheCreationTokens == 10)
            #expect(breakdown.breakdown[0].totalCacheReadTokens == 5)
        } else {
            Issue.record("Expected .loaded state for breakdown")
        }
    }

    @Test @MainActor
    func refreshTransitionsToFailedOnNilResponse() async {
        let client = MockUsageClient()
        // All stubs nil by default — simulates network failure.

        let store = UsageDashboardStore()
        store.updateClient(client)
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

        if case .failed(let msg) = store.seriesState {
            #expect(msg.contains("series"))
        } else {
            Issue.record("Expected .failed state for series")
        }

        if case .failed(let msg) = store.breakdownState {
            #expect(msg.contains("breakdown"))
        } else {
            Issue.record("Expected .failed state for breakdown")
        }
    }

    @Test @MainActor
    func needsRefreshTracksVisibleDashboardSectionsOnly() {
        let store = UsageDashboardStore()
        store.totalsState = .loaded(UsageTotalsResponse(
            totalInputTokens: 0, totalOutputTokens: 0,
            totalCacheCreationTokens: 0, totalCacheReadTokens: 0,
            totalEstimatedCostUsd: 0, eventCount: 0,
            pricedEventCount: 0, unpricedEventCount: 0
        ))
        store.dailyState = .failed("Legacy daily endpoint failed")
        store.seriesState = .loaded(UsageSeriesResponse(buckets: []))
        store.breakdownState = .loaded(UsageBreakdownResponse(breakdown: []))

        #expect(store.needsRefresh == false)
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

        let store = UsageDashboardStore()
        store.updateClient(client)
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
            UsageGroupBreakdownEntry(
                group: "anthropic",
                totalInputTokens: 100,
                totalOutputTokens: 50,
                totalCacheCreationTokens: 20,
                totalCacheReadTokens: 30,
                totalEstimatedCostUsd: 0.01,
                eventCount: 1
            )
        ])

        let store = UsageDashboardStore()
        store.updateClient(client)

        // Initial refresh to populate all states
        await store.refresh()
        #expect(client.lastSeriesGroupBy == "call_site")
        #expect(client.lastBreakdownGroupBy == "call_site")

        // Now change group-by — should re-fetch the grouped series and breakdown.
        client.stubbedBreakdown = UsageBreakdownResponse(breakdown: [
            UsageGroupBreakdownEntry(
                group: "provider-x",
                totalInputTokens: 50,
                totalOutputTokens: 25,
                totalCacheCreationTokens: 7,
                totalCacheReadTokens: 11,
                totalEstimatedCostUsd: 0.005,
                eventCount: 1
            )
        ])
        await store.selectGroupBy(.provider)

        #expect(store.selectedGroupBy == .provider)
        #expect(client.lastSeriesGroupBy == "provider")
        #expect(client.lastBreakdownGroupBy == "provider")

        if case .loaded(let breakdown) = store.breakdownState {
            #expect(breakdown.breakdown[0].group == "provider-x")
            #expect(breakdown.breakdown[0].totalCacheCreationTokens == 7)
            #expect(breakdown.breakdown[0].totalCacheReadTokens == 11)
        } else {
            Issue.record("Expected .loaded state for breakdown after selectGroupBy")
        }
    }

    @Test @MainActor
    func breakdownGroupedByActorPassesCorrectParam() async {
        let client = MockUsageClient()
        client.stubbedBreakdown = UsageBreakdownResponse(breakdown: [])

        let store = UsageDashboardStore()
        store.updateClient(client)
        await store.selectGroupBy(.actor)

        #expect(client.lastSeriesGroupBy == "actor")
        #expect(client.lastBreakdownGroupBy == "actor")
    }

    @Test @MainActor
    func taskAndProfileGroupByPassExpectedParamsToSeriesAndBreakdown() async {
        let client = MockUsageClient()
        client.stubbedSeries = UsageSeriesResponse(buckets: [])
        client.stubbedBreakdown = UsageBreakdownResponse(breakdown: [])

        let store = UsageDashboardStore()
        store.updateClient(client)

        await store.selectGroupBy(.callSite)
        #expect(store.selectedGroupBy == .callSite)
        #expect(client.lastSeriesGroupBy == "call_site")
        #expect(client.lastBreakdownGroupBy == "call_site")

        await store.selectGroupBy(.inferenceProfile)
        #expect(store.selectedGroupBy == .inferenceProfile)
        #expect(client.lastSeriesGroupBy == "inference_profile")
        #expect(client.lastBreakdownGroupBy == "inference_profile")
    }

    @Test
    func dashboardPickerOptionsMatchGroupedSeriesSupport() {
        #expect(UsageGroupByDimension.dashboardOptions == [
            .callSite,
            .inferenceProfile,
            .model,
            .provider,
        ])
    }

    @Test @MainActor
    func taskDefaultPreservesSelectionWhenCallSiteRequestsFail() async {
        let client = MockUsageClient()
        client.stubbedTotals = UsageTotalsResponse(
            totalInputTokens: 0, totalOutputTokens: 0,
            totalCacheCreationTokens: 0, totalCacheReadTokens: 0,
            totalEstimatedCostUsd: 0, eventCount: 0,
            pricedEventCount: 0, unpricedEventCount: 0
        )
        client.stubbedDaily = UsageDailyResponse(buckets: [])
        client.simulateMissingSeriesEndpoint = true
        client.stubbedBreakdown = nil

        let store = UsageDashboardStore()
        store.updateClient(client)
        await store.refresh()

        #expect(store.selectedGroupBy == .callSite)
        #expect(client.lastSeriesGroupBy == "call_site")
        #expect(client.lastBreakdownGroupBy == "call_site")
        if case .loaded = store.seriesState {
            // OK: chart can still render unstacked totals from daily buckets.
        } else {
            Issue.record("Expected daily fallback series when grouped series fails")
        }
        if case .failed = store.breakdownState {
            // OK: do not mask the failed call-site breakdown by showing model data.
        } else {
            Issue.record("Expected failed breakdown state when call-site breakdown fails")
        }
    }
}

// MARK: - Delayed Mock Client (for race-condition tests)

/// A mock client where each fetch method blocks on a continuation until the
/// test explicitly resumes it — giving full control over completion order.
@MainActor
private final class DelayedMockUsageClient: UsageClientProtocol {
    /// Each call to a fetch method appends a continuation here.
    /// Tests pop and resume them in whatever order they want.
    var totalsContinuations: [CheckedContinuation<UsageTotalsResponse?, Never>] = []
    var dailyContinuations: [CheckedContinuation<UsageDailyResponse?, Never>] = []
    var seriesContinuations: [CheckedContinuation<UsageSeriesResponse?, Never>] = []
    var breakdownContinuations: [CheckedContinuation<UsageBreakdownResponse?, Never>] = []

    func fetchUsageTotals(from: Int, to: Int) async -> UsageTotalsResponse? {
        await withCheckedContinuation { continuation in
            totalsContinuations.append(continuation)
        }
    }

    func fetchUsageDaily(from: Int, to: Int, granularity: String, tz: String) async -> UsageDailyResponse? {
        await withCheckedContinuation { continuation in
            dailyContinuations.append(continuation)
        }
    }

    func fetchUsageSeries(from: Int, to: Int, granularity: String, groupBy: String, tz: String) async -> UsageSeriesResponse? {
        await withCheckedContinuation { continuation in
            seriesContinuations.append(continuation)
        }
    }

    func fetchUsageBreakdown(from: Int, to: Int, groupBy: String) async -> UsageBreakdownResponse? {
        await withCheckedContinuation { continuation in
            breakdownContinuations.append(continuation)
        }
    }
}

// MARK: - Race Condition Tests

@Suite("UsageDashboardStore — Race Condition Guards")
struct UsageDashboardStoreRaceTests {

    private static func makeTotals(inputTokens: Int) -> UsageTotalsResponse {
        UsageTotalsResponse(
            totalInputTokens: inputTokens, totalOutputTokens: 0,
            totalCacheCreationTokens: 0, totalCacheReadTokens: 0,
            totalEstimatedCostUsd: 0, eventCount: 0,
            pricedEventCount: 0, unpricedEventCount: 0
        )
    }

    private static func makeDaily() -> UsageDailyResponse {
        UsageDailyResponse(buckets: [])
    }

    private static func makeSeries(group: String? = nil) -> UsageSeriesResponse {
        guard let group else {
            return UsageSeriesResponse(buckets: [])
        }

        return UsageSeriesResponse(buckets: [
            UsageSeriesBucket(
                date: "2026-03-01",
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalEstimatedCostUsd: 0,
                eventCount: 0,
                groups: [
                    group: UsageSeriesGroupValue(
                        group: group,
                        totalInputTokens: 0,
                        totalOutputTokens: 0,
                        totalEstimatedCostUsd: 0,
                        eventCount: 0
                    )
                ]
            )
        ])
    }

    private static func makeBreakdown(group: String) -> UsageBreakdownResponse {
        UsageBreakdownResponse(breakdown: [
            UsageGroupBreakdownEntry(
                group: group,
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalCacheCreationTokens: 0,
                totalCacheReadTokens: 0,
                totalEstimatedCostUsd: 0, eventCount: 0
            )
        ])
    }

    /// Yield the main actor repeatedly until `condition` becomes true.
    @MainActor
    private static func yieldUntil(_ condition: () -> Bool) async {
        for _ in 0..<100 {
            if condition() { return }
            await Task.yield()
        }
    }

    @Test @MainActor
    func staleRefreshResultsAreDiscarded() async {
        let client = DelayedMockUsageClient()
        let store = UsageDashboardStore()
        store.updateClient(client)

        // Launch first refresh (simulates selecting "Last 7 Days")
        let firstRefresh = Task { @MainActor in await store.selectRange(.last7Days) }
        // Wait until the first refresh's fetch calls have registered their continuations
        await Self.yieldUntil { client.totalsContinuations.count >= 1 }

        // Launch second refresh before the first completes (simulates rapid re-select)
        let secondRefresh = Task { @MainActor in await store.selectRange(.last30Days) }
        // Wait until the second refresh's continuations are all registered
        await Self.yieldUntil {
            client.totalsContinuations.count >= 2
            && client.dailyContinuations.count >= 2
            && client.seriesContinuations.count >= 2
            && client.breakdownContinuations.count >= 2
        }

        // Complete the SECOND request first (the "latest" one).
        #expect(client.totalsContinuations.count == 2)
        client.totalsContinuations[1].resume(returning: Self.makeTotals(inputTokens: 999))
        client.dailyContinuations[1].resume(returning: Self.makeDaily())
        client.seriesContinuations[1].resume(returning: Self.makeSeries())
        client.breakdownContinuations[1].resume(returning: Self.makeBreakdown(group: "latest"))
        await secondRefresh.value

        // Store should now show the second request's data
        if case .loaded(let totals) = store.totalsState {
            #expect(totals.totalInputTokens == 999)
        } else {
            Issue.record("Expected .loaded state after second refresh")
        }

        // Now complete the FIRST (stale) request — it should NOT overwrite the store
        client.totalsContinuations[0].resume(returning: Self.makeTotals(inputTokens: 111))
        client.dailyContinuations[0].resume(returning: Self.makeDaily())
        client.seriesContinuations[0].resume(returning: Self.makeSeries())
        client.breakdownContinuations[0].resume(returning: Self.makeBreakdown(group: "stale"))
        await firstRefresh.value

        // Verify the store still holds the second request's data, not the stale first
        if case .loaded(let totals) = store.totalsState {
            #expect(totals.totalInputTokens == 999, "Stale refresh should not overwrite newer data")
        } else {
            Issue.record("Store state was overwritten by stale refresh")
        }

        if case .loaded(let breakdown) = store.breakdownState {
            #expect(breakdown.breakdown[0].group == "latest", "Stale breakdown should not overwrite newer data")
        } else {
            Issue.record("Breakdown state was overwritten by stale refresh")
        }
    }

    @Test @MainActor
    func refreshDoesNotOverwriteBreakdownFromConcurrentSelectGroupBy() async {
        let client = DelayedMockUsageClient()
        let store = UsageDashboardStore()
        store.updateClient(client)

        // Launch refresh() — it fetches totals, daily, and breakdown
        let refreshTask = Task { @MainActor in await store.refresh() }
        await Self.yieldUntil {
            client.totalsContinuations.count >= 1
            && client.dailyContinuations.count >= 1
            && client.seriesContinuations.count >= 1
            && client.breakdownContinuations.count >= 1
        }

        // While refresh() is in flight, user changes group-by dimension
        let groupByTask = Task { @MainActor in await store.selectGroupBy(.provider) }
        await Self.yieldUntil {
            client.seriesContinuations.count >= 2
            && client.breakdownContinuations.count >= 2
        }

        // Complete selectGroupBy's breakdown first (the newer request)
        client.seriesContinuations[1].resume(returning: Self.makeSeries(group: "provider-fresh"))
        client.breakdownContinuations[1].resume(returning: Self.makeBreakdown(group: "provider-fresh"))
        await groupByTask.value

        if case .loaded(let series) = store.seriesState {
            #expect(series.buckets[0].groups.keys.contains("provider-fresh"))
        } else {
            Issue.record("Expected series to be loaded after selectGroupBy completes")
        }

        if case .loaded(let breakdown) = store.breakdownState {
            #expect(breakdown.breakdown[0].group == "provider-fresh")
        } else {
            Issue.record("Expected .loaded state after selectGroupBy completes")
        }

        // Now complete refresh()'s fetches — its breakdown should be discarded
        // because selectGroupBy() incremented breakdownGeneration
        client.totalsContinuations[0].resume(returning: Self.makeTotals(inputTokens: 42))
        client.dailyContinuations[0].resume(returning: Self.makeDaily())
        client.seriesContinuations[0].resume(returning: Self.makeSeries(group: "model-stale"))
        client.breakdownContinuations[0].resume(returning: Self.makeBreakdown(group: "model-stale"))
        await refreshTask.value

        // Totals and daily from refresh() should still land (no newer refresh invalidated them)
        if case .loaded(let totals) = store.totalsState {
            #expect(totals.totalInputTokens == 42)
        } else {
            Issue.record("Expected totals to be loaded from refresh()")
        }

        // Breakdown must still be the selectGroupBy result, not overwritten by refresh()
        if case .loaded(let series) = store.seriesState {
            #expect(series.buckets[0].groups.keys.contains("provider-fresh"),
                    "refresh() must not overwrite series set by concurrent selectGroupBy()")
        } else {
            Issue.record("Series was overwritten by stale refresh()")
        }

        if case .loaded(let breakdown) = store.breakdownState {
            #expect(breakdown.breakdown[0].group == "provider-fresh",
                    "refresh() must not overwrite breakdown set by concurrent selectGroupBy()")
        } else {
            Issue.record("Breakdown was overwritten by stale refresh()")
        }
    }

    @Test @MainActor
    func staleSelectGroupByResultsAreDiscarded() async {
        let client = DelayedMockUsageClient()
        let store = UsageDashboardStore()
        store.updateClient(client)

        // Launch first selectGroupBy
        let first = Task { @MainActor in await store.selectGroupBy(.model) }
        await Self.yieldUntil {
            client.seriesContinuations.count >= 1
            && client.breakdownContinuations.count >= 1
        }

        // Launch second selectGroupBy before the first completes
        let second = Task { @MainActor in await store.selectGroupBy(.provider) }
        await Self.yieldUntil {
            client.seriesContinuations.count >= 2
            && client.breakdownContinuations.count >= 2
        }

        // Complete the second (latest) request first
        #expect(client.breakdownContinuations.count == 2)
        client.seriesContinuations[1].resume(returning: Self.makeSeries())
        client.breakdownContinuations[1].resume(returning: Self.makeBreakdown(group: "provider-result"))
        await second.value

        if case .loaded(let breakdown) = store.breakdownState {
            #expect(breakdown.breakdown[0].group == "provider-result")
        } else {
            Issue.record("Expected .loaded state after second selectGroupBy")
        }

        // Complete the first (stale) request — should be discarded
        client.seriesContinuations[0].resume(returning: Self.makeSeries())
        client.breakdownContinuations[0].resume(returning: Self.makeBreakdown(group: "model-stale"))
        await first.value

        if case .loaded(let breakdown) = store.breakdownState {
            #expect(breakdown.breakdown[0].group == "provider-result", "Stale selectGroupBy should not overwrite newer data")
        } else {
            Issue.record("Breakdown state was overwritten by stale selectGroupBy")
        }
    }
}

@Suite("UsageDashboardStore — Presentation Helpers")
struct UsageDashboardStorePresentationTests {

    @Test
    func sharedDirectInputLabelAndBreakdownSummaryStayConsistent() {
        let entry = UsageGroupBreakdownEntry(
            group: "claude-opus-4-6",
            totalInputTokens: 1_234,
            totalOutputTokens: 56,
            totalCacheCreationTokens: 78,
            totalCacheReadTokens: 9_876,
            totalEstimatedCostUsd: 4.15,
            eventCount: 2
        )

        #expect(UsageFormatting.directInputTokensLabel == "Direct Input Tokens")
        #expect(
            UsageFormatting.formatBreakdownSummary(entry)
                == "\(UsageFormatting.formatCount(1_234)) direct / \(UsageFormatting.formatCount(78)) cache created / \(UsageFormatting.formatCount(9_876)) cache read / \(UsageFormatting.formatCount(56)) out"
        )
    }
}

// MARK: - Time Range Bounds

@Suite("UsageTimeRange — Epoch Bounds")
struct UsageTimeRangeTests {

    @Test
    func todayRangeStartsAtMidnightUTC() {
        // Use a mid-day timestamp so UTC midnight differs from most local timezones
        let now = Date(timeIntervalSince1970: 1709733600) // 2024-03-06 14:00:00 UTC
        let range = UsageTimeRange.today.epochMillisRange(now: now, timeZone: TimeZone(identifier: "UTC")!)

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let startOfDay = calendar.startOfDay(for: now)
        let expectedFrom = Int(startOfDay.timeIntervalSince1970 * 1000)

        #expect(range.from == expectedFrom)
        // Verify we get UTC midnight (2024-03-06 00:00:00 UTC = 1709683200)
        #expect(range.from == 1709683200 * 1000)
        #expect(range.to == Int(now.timeIntervalSince1970 * 1000))
    }

    @Test
    func todayRangeStartsAtMidnightInUserTimezone() {
        // 2024-03-06 14:00:00 UTC is 2024-03-06 06:00:00 PST (UTC-8).
        // Midnight PST that day is 2024-03-06 08:00:00 UTC = 1709712000.
        let now = Date(timeIntervalSince1970: 1709733600)
        let pst = TimeZone(identifier: "America/Los_Angeles")!
        let range = UsageTimeRange.today.epochMillisRange(now: now, timeZone: pst)

        #expect(range.from == 1709712000 * 1000)
        #expect(range.to == Int(now.timeIntervalSince1970 * 1000))
    }

    @Test
    func todayRangeHandlesFractionalOffset() {
        // Asia/Kolkata is UTC+5:30. 2024-03-06 14:00:00 UTC is 2024-03-06 19:30:00 IST.
        // Midnight IST that day is 2024-03-05 18:30:00 UTC = 1709663400.
        let now = Date(timeIntervalSince1970: 1709733600)
        let ist = TimeZone(identifier: "Asia/Kolkata")!
        let range = UsageTimeRange.today.epochMillisRange(now: now, timeZone: ist)

        #expect(range.from == 1709663400 * 1000)
    }

    @Test
    func last7DaysSpansSixDaysBack() {
        let now = Date(timeIntervalSince1970: 1709733600) // 2024-03-06 14:00:00 UTC
        let range = UsageTimeRange.last7Days.epochMillisRange(now: now, timeZone: TimeZone(identifier: "UTC")!)

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
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

// MARK: - Timezone Wiring

@Suite("UsageDashboardStore — Timezone Wiring")
@MainActor
struct UsageDashboardStoreTimezoneTests {

    @Test
    func defaultsToCurrentSystemTimezone() {
        let store = UsageDashboardStore()
        #expect(store.resolvedTimezoneIdentifier == TimeZone.current.identifier)
    }

    @Test
    func updateTimezoneAcceptsIanaIdentifier() {
        let store = UsageDashboardStore()
        store.updateTimezone("America/New_York")
        #expect(store.resolvedTimezoneIdentifier == "America/New_York")
        #expect(store.resolvedTimezone.identifier == "America/New_York")
    }

    @Test
    func updateTimezoneWithNilFallsBackToCurrent() {
        let store = UsageDashboardStore()
        store.updateTimezone("Europe/Berlin")
        store.updateTimezone(nil)
        #expect(store.resolvedTimezoneIdentifier == TimeZone.current.identifier)
    }

    @Test
    func updateTimezoneWithInvalidIdentifierFallsBackToCurrent() {
        let store = UsageDashboardStore()
        store.updateTimezone("Not/A/Real/Zone")
        #expect(store.resolvedTimezoneIdentifier == TimeZone.current.identifier)
    }

    @Test
    func refreshPassesTimezoneToFetchUsageDaily() async {
        let client = MockUsageClient()
        client.stubbedTotals = UsageTotalsResponse(
            totalInputTokens: 0, totalOutputTokens: 0,
            totalCacheCreationTokens: 0, totalCacheReadTokens: 0,
            totalEstimatedCostUsd: 0, eventCount: 0,
            pricedEventCount: 0, unpricedEventCount: 0
        )
        client.stubbedDaily = UsageDailyResponse(buckets: [])
        client.stubbedBreakdown = UsageBreakdownResponse(breakdown: [])

        let store = UsageDashboardStore()
        store.updateClient(client)
        store.updateTimezone("Europe/Berlin")
        await store.refresh()

        #expect(client.lastDailyTz == "Europe/Berlin")
    }

    @Test
    func updateTimezoneResetsLoadedData() async {
        let client = MockUsageClient()
        client.stubbedTotals = UsageTotalsResponse(
            totalInputTokens: 100, totalOutputTokens: 50,
            totalCacheCreationTokens: 0, totalCacheReadTokens: 0,
            totalEstimatedCostUsd: 0.01, eventCount: 1,
            pricedEventCount: 1, unpricedEventCount: 0
        )
        client.stubbedDaily = UsageDailyResponse(buckets: [])
        client.stubbedBreakdown = UsageBreakdownResponse(breakdown: [])

        let store = UsageDashboardStore()
        store.updateClient(client)
        await store.refresh()

        // Loaded after refresh.
        if case .loaded = store.totalsState {
            // ok
        } else {
            Issue.record("Expected totals to be loaded")
        }

        store.updateTimezone("Asia/Tokyo")

        // Reset back to idle after tz change.
        #expect(store.totalsState == .idle)
        #expect(store.dailyState == .idle)
        #expect(store.breakdownState == .idle)
    }

    @Test
    func updateTimezoneWithSameIdentifierDoesNotReset() async {
        let client = MockUsageClient()
        client.stubbedTotals = UsageTotalsResponse(
            totalInputTokens: 100, totalOutputTokens: 50,
            totalCacheCreationTokens: 0, totalCacheReadTokens: 0,
            totalEstimatedCostUsd: 0.01, eventCount: 1,
            pricedEventCount: 1, unpricedEventCount: 0
        )
        client.stubbedDaily = UsageDailyResponse(buckets: [])
        client.stubbedBreakdown = UsageBreakdownResponse(breakdown: [])

        let store = UsageDashboardStore()
        store.updateClient(client)
        store.updateTimezone("America/Chicago")
        await store.refresh()

        store.updateTimezone("America/Chicago") // same value — should be a no-op

        // Remains loaded.
        if case .loaded = store.totalsState {
            // ok
        } else {
            Issue.record("Expected totals to remain loaded after no-op timezone update")
        }
    }
}
