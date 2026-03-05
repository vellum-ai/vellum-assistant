import Foundation
import Testing
@testable import VellumAssistantShared

// MARK: - UsageDashboardPanel Rendering Logic Tests

/// These tests verify the rendering logic paths for the UsageDashboardPanel
/// by exercising the UsageDashboardStore states that drive each section.
/// The panel renders three sections: totals, daily trend, and grouped breakdown.

@Suite("UsageDashboardPanel — Empty / Idle State")
struct UsageDashboardPanelEmptyTests {

    @Test @MainActor
    func storeStartsInIdleState() {
        let client = MockPanelClient()
        let store = UsageDashboardStore(client: client)

        #expect(store.totalsState == .idle)
        #expect(store.dailyState == .idle)
        #expect(store.breakdownState == .idle)
        #expect(store.selectedRange == .last7Days)
        #expect(store.selectedGroupBy == .model)
    }

    @Test @MainActor
    func emptyResponsesProduceLoadedWithEmptyData() async {
        let client = MockPanelClient()
        client.stubbedTotals = UsageTotalsResponse(
            totalInputTokens: 0, totalOutputTokens: 0,
            totalCacheCreationTokens: 0, totalCacheReadTokens: 0,
            totalEstimatedCostUsd: 0, eventCount: 0,
            pricedEventCount: 0, unpricedEventCount: 0
        )
        client.stubbedDaily = UsageDailyResponse(buckets: [])
        client.stubbedBreakdown = UsageBreakdownResponse(breakdown: [])

        let store = UsageDashboardStore(client: client)
        await store.refresh()

        if case .loaded(let totals) = store.totalsState {
            #expect(totals.eventCount == 0)
            #expect(totals.totalEstimatedCostUsd == 0)
        } else {
            Issue.record("Expected .loaded for totals with zero values")
        }

        if case .loaded(let daily) = store.dailyState {
            #expect(daily.buckets.isEmpty)
        } else {
            Issue.record("Expected .loaded for daily with empty buckets")
        }

        if case .loaded(let breakdown) = store.breakdownState {
            #expect(breakdown.breakdown.isEmpty)
        } else {
            Issue.record("Expected .loaded for breakdown with empty entries")
        }
    }
}

@Suite("UsageDashboardPanel — Loading State")
struct UsageDashboardPanelLoadingTests {

    @Test @MainActor
    func failedFetchesShowErrorMessages() async {
        let client = MockPanelClient()
        // All stubs nil — simulates fetch failure.

        let store = UsageDashboardStore(client: client)
        await store.refresh()

        if case .failed(let msg) = store.totalsState {
            #expect(msg.contains("totals"))
        } else {
            Issue.record("Expected .failed for totals")
        }

        if case .failed(let msg) = store.dailyState {
            #expect(msg.contains("daily"))
        } else {
            Issue.record("Expected .failed for daily")
        }

        if case .failed(let msg) = store.breakdownState {
            #expect(msg.contains("breakdown"))
        } else {
            Issue.record("Expected .failed for breakdown")
        }
    }
}

@Suite("UsageDashboardPanel — Populated State")
struct UsageDashboardPanelPopulatedTests {

    @Test @MainActor
    func populatedStoreHasCorrectTotals() async {
        let client = MockPanelClient()
        client.stubbedTotals = UsageTotalsResponse(
            totalInputTokens: 50_000, totalOutputTokens: 25_000,
            totalCacheCreationTokens: 5_000, totalCacheReadTokens: 2_000,
            totalEstimatedCostUsd: 1.23, eventCount: 42,
            pricedEventCount: 40, unpricedEventCount: 2
        )
        client.stubbedDaily = UsageDailyResponse(buckets: [
            UsageDayBucket(date: "2026-03-04", totalInputTokens: 20_000, totalOutputTokens: 10_000, totalEstimatedCostUsd: 0.50, eventCount: 15),
            UsageDayBucket(date: "2026-03-05", totalInputTokens: 30_000, totalOutputTokens: 15_000, totalEstimatedCostUsd: 0.73, eventCount: 27)
        ])
        client.stubbedBreakdown = UsageBreakdownResponse(breakdown: [
            UsageGroupBreakdownEntry(group: "claude-sonnet-4-20250514", totalInputTokens: 30_000, totalOutputTokens: 15_000, totalEstimatedCostUsd: 0.80, eventCount: 25),
            UsageGroupBreakdownEntry(group: "claude-haiku-3", totalInputTokens: 20_000, totalOutputTokens: 10_000, totalEstimatedCostUsd: 0.43, eventCount: 17)
        ])

        let store = UsageDashboardStore(client: client)
        await store.refresh()

        if case .loaded(let totals) = store.totalsState {
            #expect(totals.totalInputTokens == 50_000)
            #expect(totals.totalOutputTokens == 25_000)
            #expect(totals.totalEstimatedCostUsd == 1.23)
            #expect(totals.eventCount == 42)
        } else {
            Issue.record("Expected .loaded for totals")
        }

        if case .loaded(let daily) = store.dailyState {
            #expect(daily.buckets.count == 2)
            #expect(daily.buckets[0].date == "2026-03-04")
            #expect(daily.buckets[1].date == "2026-03-05")
        } else {
            Issue.record("Expected .loaded for daily")
        }

        if case .loaded(let breakdown) = store.breakdownState {
            #expect(breakdown.breakdown.count == 2)
            #expect(breakdown.breakdown[0].group == "claude-sonnet-4-20250514")
            #expect(breakdown.breakdown[1].group == "claude-haiku-3")
        } else {
            Issue.record("Expected .loaded for breakdown")
        }
    }

    @Test @MainActor
    func groupByDimensionAffectsBreakdownHeadings() async {
        let client = MockPanelClient()
        client.stubbedBreakdown = UsageBreakdownResponse(breakdown: [
            UsageGroupBreakdownEntry(group: "anthropic", totalInputTokens: 100, totalOutputTokens: 50, totalEstimatedCostUsd: 0.01, eventCount: 1)
        ])

        let store = UsageDashboardStore(client: client)

        // Default is .model
        #expect(store.selectedGroupBy == .model)

        await store.selectGroupBy(.provider)
        #expect(store.selectedGroupBy == .provider)
        #expect(client.lastBreakdownGroupBy == "provider")

        await store.selectGroupBy(.actor)
        #expect(store.selectedGroupBy == .actor)
        #expect(client.lastBreakdownGroupBy == "actor")
    }

    @Test @MainActor
    func timeRangeSelectionRefreshesAllData() async {
        let client = MockPanelClient()
        client.stubbedTotals = UsageTotalsResponse(
            totalInputTokens: 0, totalOutputTokens: 0,
            totalCacheCreationTokens: 0, totalCacheReadTokens: 0,
            totalEstimatedCostUsd: 0, eventCount: 0,
            pricedEventCount: 0, unpricedEventCount: 0
        )
        client.stubbedDaily = UsageDailyResponse(buckets: [])
        client.stubbedBreakdown = UsageBreakdownResponse(breakdown: [])

        let store = UsageDashboardStore(client: client)
        await store.selectRange(.last30Days)

        #expect(store.selectedRange == .last30Days)
        #expect(client.lastTotalsFrom != nil)
        #expect(client.lastDailyFrom != nil)
        #expect(client.lastBreakdownFrom != nil)
    }
}

// MARK: - Mock Client

@MainActor
private final class MockPanelClient: DaemonClientProtocol {
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
    var lastDailyFrom: Int?
    var lastBreakdownFrom: Int?
    var lastBreakdownGroupBy: String?

    func fetchUsageTotals(from: Int, to: Int) async -> UsageTotalsResponse? {
        lastTotalsFrom = from
        return stubbedTotals
    }

    func fetchUsageDaily(from: Int, to: Int) async -> UsageDailyResponse? {
        lastDailyFrom = from
        return stubbedDaily
    }

    func fetchUsageBreakdown(from: Int, to: Int, groupBy: String) async -> UsageBreakdownResponse? {
        lastBreakdownFrom = from
        lastBreakdownGroupBy = groupBy
        return stubbedBreakdown
    }
}
