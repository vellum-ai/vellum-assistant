import Foundation
import SwiftUI
import Testing
@testable import VellumAssistantLib
@testable import VellumAssistantShared

// MARK: - UsageTabContent Rendering Logic Tests

/// These tests verify the rendering logic paths for the UsageTabContent
/// by exercising the UsageDashboardStore states that drive each section.
/// The tab renders three sections: totals, daily trend, and grouped breakdown.

@Suite("UsageTabContent — Empty / Idle State")
struct UsageTabContentEmptyTests {

    @Test @MainActor
    func storeStartsInIdleState() {
        let client = MockPanelClient()
        let store = UsageDashboardStore()
        store.updateClient(client)

        #expect(store.totalsState == .idle)
        #expect(store.dailyState == .idle)
        #expect(store.seriesState == .idle)
        #expect(store.breakdownState == .idle)
        #expect(store.selectedRange == .last7Days)
        #expect(store.selectedGroupBy == .callSite)
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

        let store = UsageDashboardStore()
        store.updateClient(client)
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

        if case .loaded(let series) = store.seriesState {
            #expect(series.buckets.isEmpty)
        } else {
            Issue.record("Expected .loaded for series with empty buckets")
        }

        if case .loaded(let breakdown) = store.breakdownState {
            #expect(breakdown.breakdown.isEmpty)
        } else {
            Issue.record("Expected .loaded for breakdown with empty entries")
        }
    }
}

@Suite("UsageTabContent — Loading State")
struct UsageTabContentLoadingTests {

    @Test @MainActor
    func failedFetchesShowErrorMessages() async {
        let client = MockPanelClient()
        // All stubs nil — simulates fetch failure.

        let store = UsageDashboardStore()
        store.updateClient(client)
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

        if case .failed(let msg) = store.seriesState {
            #expect(msg.contains("series"))
        } else {
            Issue.record("Expected .failed for series")
        }

        if case .failed(let msg) = store.breakdownState {
            #expect(msg.contains("breakdown"))
        } else {
            Issue.record("Expected .failed for breakdown")
        }
    }
}

@Suite("UsageTabContent — Populated State")
struct UsageTabContentPopulatedTests {

    @Test @MainActor
    func populatedStoreHasCorrectTotals() async {
        let client = MockPanelClient()
        let breakdownEntries = [
            UsageGroupBreakdownEntry(
                group: "claude-sonnet-4-20250514",
                totalInputTokens: 30_000,
                totalOutputTokens: 15_000,
                totalCacheCreationTokens: 1_200,
                totalCacheReadTokens: 8_000,
                totalEstimatedCostUsd: 0.80,
                eventCount: 25
            ),
            UsageGroupBreakdownEntry(
                group: "claude-haiku-3",
                totalInputTokens: 20_000,
                totalOutputTokens: 10_000,
                totalCacheCreationTokens: 450,
                totalCacheReadTokens: 3_200,
                totalEstimatedCostUsd: 0.43,
                eventCount: 17
            )
        ]
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
        client.stubbedBreakdown = UsageBreakdownResponse(breakdown: breakdownEntries)

        let store = UsageDashboardStore()
        store.updateClient(client)
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
            #expect(breakdown.breakdown[0].totalCacheCreationTokens == 1_200)
            #expect(breakdown.breakdown[0].totalCacheReadTokens == 8_000)
            #expect(breakdown.breakdown[1].group == "claude-haiku-3")
            #expect(breakdown.breakdown[1].totalCacheCreationTokens == 450)
            #expect(breakdown.breakdown[1].totalCacheReadTokens == 3_200)
        } else {
            Issue.record("Expected .loaded for breakdown")
        }
    }

    @Test @MainActor
    func groupByDimensionAffectsBreakdownHeadings() async {
        let client = MockPanelClient()
        client.stubbedBreakdown = UsageBreakdownResponse(breakdown: [
            UsageGroupBreakdownEntry(
                group: "anthropic",
                totalInputTokens: 100,
                totalOutputTokens: 50,
                totalCacheCreationTokens: 0,
                totalCacheReadTokens: 0,
                totalEstimatedCostUsd: 0.01,
                eventCount: 1
            )
        ])

        let store = UsageDashboardStore()
        store.updateClient(client)

        // Default is .callSite (shown as Task)
        #expect(store.selectedGroupBy == .callSite)

        await store.selectGroupBy(.provider)
        #expect(store.selectedGroupBy == .provider)
        #expect(client.lastSeriesGroupBy == "provider")
        #expect(client.lastBreakdownGroupBy == "provider")

        await store.selectGroupBy(.actor)
        #expect(store.selectedGroupBy == .actor)
        #expect(client.lastSeriesGroupBy == "actor")
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

        let store = UsageDashboardStore()
        store.updateClient(client)
        await store.selectRange(.last30Days)

        #expect(store.selectedRange == .last30Days)
        #expect(client.lastTotalsFrom != nil)
        #expect(client.lastDailyFrom != nil)
        #expect(client.lastSeriesFrom != nil)
        #expect(client.lastBreakdownFrom != nil)
    }
}

@Suite("UsageGroupBreakdownEntry — groupId decoding")
struct UsageGroupBreakdownEntryGroupIdDecodingTests {

    @Test
    func decodesGroupIdWhenPresent() throws {
        let json = """
        {
            "breakdown": [
                {
                    "group": "Conversation about SwiftUI",
                    "groupId": "conv_abc",
                    "totalInputTokens": 1000,
                    "totalOutputTokens": 500,
                    "totalCacheCreationTokens": 0,
                    "totalCacheReadTokens": 0,
                    "totalEstimatedCostUsd": 0.05,
                    "eventCount": 3
                }
            ]
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(UsageBreakdownResponse.self, from: json)
        #expect(decoded.breakdown.first?.groupId == "conv_abc")
        #expect(decoded.breakdown.first?.group == "Conversation about SwiftUI")
    }

    @Test
    func decodesLegacyJSONWithoutGroupId() throws {
        let json = """
        {
            "breakdown": [
                {
                    "group": "claude-sonnet-4-20250514",
                    "totalInputTokens": 1000,
                    "totalOutputTokens": 500,
                    "totalCacheCreationTokens": 0,
                    "totalCacheReadTokens": 0,
                    "totalEstimatedCostUsd": 0.05,
                    "eventCount": 3
                }
            ]
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(UsageBreakdownResponse.self, from: json)
        #expect(decoded.breakdown.first?.groupId == nil)
        #expect(decoded.breakdown.first?.group == "claude-sonnet-4-20250514")
    }
}

// MARK: - Conversation Row Interactivity

/// These tests exercise `UsageTabContent.navigationTarget(for:)` — the pure
/// helper that decides whether a breakdown row should navigate to a
/// conversation on tap. The row's `.onTapGesture` calls `onSelectConversation`
/// only when this helper returns a non-nil groupId, so unit-testing the
/// helper directly is equivalent to testing the tap outcome without
/// needing a SwiftUI view hosting harness.

@Suite("UsageTabContent — Conversation row interactivity")
struct UsageTabContentConversationRowInteractivityTests {

    private static let conversationEntry = UsageGroupBreakdownEntry(
        group: "Designing the usage dashboard",
        groupId: "conv_abc",
        totalInputTokens: 1_000,
        totalOutputTokens: 500,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
        totalEstimatedCostUsd: 0.05,
        eventCount: 3
    )

    private static let otherBucketEntry = UsageGroupBreakdownEntry(
        group: "Other",
        groupId: nil,
        totalInputTokens: 200,
        totalOutputTokens: 100,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
        totalEstimatedCostUsd: 0.01,
        eventCount: 1
    )

    private static let modelEntry = UsageGroupBreakdownEntry(
        group: "claude-sonnet-4-20250514",
        totalInputTokens: 1_000,
        totalOutputTokens: 500,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
        totalEstimatedCostUsd: 0.05,
        eventCount: 3
    )

    @Test @MainActor
    func conversationRowWithGroupIdTriggersNavigationAndInvokesClosure() async {
        let client = MockPanelClient()
        client.stubbedBreakdown = UsageBreakdownResponse(breakdown: [Self.conversationEntry])
        let store = UsageDashboardStore()
        store.updateClient(client)
        await store.selectGroupBy(.conversation)

        var captured: [String] = []
        let tab = UsageTabContent(
            store: store,
            onSelectConversation: { captured.append($0) }
        )

        // The pure helper is the single source of truth for whether a tap
        // navigates — the row's .onTapGesture fires onSelectConversation only
        // when this returns non-nil.
        #expect(tab.navigationTarget(for: Self.conversationEntry) == "conv_abc")

        if let target = tab.navigationTarget(for: Self.conversationEntry) {
            tab.onSelectConversation(target)
        }
        #expect(captured == ["conv_abc"])
    }

    @Test @MainActor
    func otherBucketWithNilGroupIdDoesNotNavigate() async {
        let client = MockPanelClient()
        client.stubbedBreakdown = UsageBreakdownResponse(breakdown: [Self.otherBucketEntry])
        let store = UsageDashboardStore()
        store.updateClient(client)
        await store.selectGroupBy(.conversation)

        var captured: [String] = []
        let tab = UsageTabContent(
            store: store,
            onSelectConversation: { captured.append($0) }
        )

        #expect(tab.navigationTarget(for: Self.otherBucketEntry) == nil)

        // A tap on an "Other" row never reaches onSelectConversation because
        // the inert branch of breakdownRow omits .onTapGesture. Mirror that
        // behavior here: invoke the closure only when the helper returns
        // non-nil. captured must remain empty.
        if let target = tab.navigationTarget(for: Self.otherBucketEntry) {
            tab.onSelectConversation(target)
        }
        #expect(captured.isEmpty)
    }

    @Test @MainActor
    func modelGroupByDoesNotNavigateEvenWithPopulatedEntry() async {
        let client = MockPanelClient()
        client.stubbedBreakdown = UsageBreakdownResponse(breakdown: [Self.modelEntry])
        let store = UsageDashboardStore()
        store.updateClient(client)
        await store.selectGroupBy(.model)

        var captured: [String] = []
        let tab = UsageTabContent(
            store: store,
            onSelectConversation: { captured.append($0) }
        )

        #expect(store.selectedGroupBy == .model)
        #expect(tab.navigationTarget(for: Self.modelEntry) == nil)

        if let target = tab.navigationTarget(for: Self.modelEntry) {
            tab.onSelectConversation(target)
        }
        #expect(captured.isEmpty)
    }

    @Test @MainActor
    func conversationEntryWithGroupIdInertWhenGroupedByProvider() async {
        // Even a conversation-shaped entry (groupId non-nil) must not
        // navigate if the store is grouped by something other than
        // .conversation — the helper gates on groupBy first.
        let client = MockPanelClient()
        let store = UsageDashboardStore()
        store.updateClient(client)
        await store.selectGroupBy(.provider)

        var captured: [String] = []
        let tab = UsageTabContent(
            store: store,
            onSelectConversation: { captured.append($0) }
        )

        #expect(tab.navigationTarget(for: Self.conversationEntry) == nil)
        if let target = tab.navigationTarget(for: Self.conversationEntry) {
            tab.onSelectConversation(target)
        }
        #expect(captured.isEmpty)
    }
}

// MARK: - View Content Helper

/// Dumps the tab's section view trees so that all Text content is captured
/// as strings in the dump output. SettingsCard stores its content as
/// @ViewBuilder closures which dump() shows as "(Function)". We evaluate
/// each section's body to expand those closures.
@MainActor
private func collectTabContent(store: UsageDashboardStore) -> String {
    let tab = UsageTabContent(store: store, onSelectConversation: { _ in })
    var output = ""
    dump(tab.totalsSection(store: store).body, to: &output)
    dump(tab.dailySection(store: store).body, to: &output)
    dump(tab.breakdownSection(store: store).body, to: &output)
    return output
}

@MainActor
private func collectBreakdownRow(entry: UsageGroupBreakdownEntry) -> String {
    let helperStore = UsageDashboardStore()
    helperStore.updateClient(MockPanelClient())
    let tab = UsageTabContent(store: helperStore, onSelectConversation: { _ in })
    let row = tab.breakdownRow(entry)
    var output = ""
    dump(row, to: &output)
    return output
}

// MARK: - View Instantiation Tests

/// These tests instantiate the actual UsageTabContent view with stores in
/// different states and evaluate the view body to verify the view tree is
/// well-formed and renders without crashing.

@Suite("UsageTabContent — View Rendering: Idle State")
struct UsageTabContentViewIdleTests {

    @Test @MainActor
    func tabCanBeInstantiatedWithIdleStore() {
        let client = MockPanelClient()
        let store = UsageDashboardStore()
        store.updateClient(client)
        let joined = collectTabContent(store: store)

        // Idle state shows skeleton loading indicators for all sections
        #expect(joined.contains("VSkeletonBone"))
    }
}

@Suite("UsageTabContent — View Rendering: Empty Loaded State")
struct UsageTabContentViewEmptyTests {

    @Test @MainActor
    func tabRendersWithEmptyLoadedData() async {
        let client = MockPanelClient()
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
        await store.refresh()

        let joined = collectTabContent(store: store)

        // Section headers
        #expect(joined.contains("Totals"))
        #expect(joined.contains("Inference Usage"))
        #expect(joined.contains("Breakdown"))
        #expect(joined.contains(UsageFormatting.directInputTokensLabel))
        #expect(joined.contains("Cache Created"))
        #expect(joined.contains("Cache Read"))

        // Zero cost formatting: verify the formatted zero cost appears
        let zeroCost = UsageFormatting.formatCost(0)
        #expect(joined.contains(zeroCost))

        // Empty-state placeholders
        #expect(joined.contains("No daily data"))
        #expect(joined.contains("No breakdown data"))
    }
}

@Suite("UsageTabContent — View Rendering: Populated State")
struct UsageTabContentViewPopulatedTests {

    @Test @MainActor
    func tabRendersWithPopulatedData() async {
        let client = MockPanelClient()
        let breakdownEntries = [
            UsageGroupBreakdownEntry(
                group: "claude-sonnet-4-20250514",
                totalInputTokens: 30_000,
                totalOutputTokens: 15_000,
                totalCacheCreationTokens: 1_200,
                totalCacheReadTokens: 8_000,
                totalEstimatedCostUsd: 0.80,
                eventCount: 25
            ),
            UsageGroupBreakdownEntry(
                group: "claude-haiku-3",
                totalInputTokens: 20_000,
                totalOutputTokens: 10_000,
                totalCacheCreationTokens: 450,
                totalCacheReadTokens: 3_200,
                totalEstimatedCostUsd: 0.43,
                eventCount: 17
            )
        ]
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
        client.stubbedBreakdown = UsageBreakdownResponse(breakdown: breakdownEntries)

        let store = UsageDashboardStore()
        store.updateClient(client)
        await store.refresh()

        let joined = collectTabContent(store: store)

        // Section headers
        #expect(joined.contains("Totals"))
        #expect(joined.contains("Inference Usage"))
        #expect(joined.contains("Breakdown"))

        // Formatted cost: verify the formatted cost appears
        let formattedCost = UsageFormatting.formatCostShort(1.23)
        #expect(joined.contains(formattedCost))

        // Daily dates
        #expect(joined.contains("2026-03-04"))
        #expect(joined.contains("2026-03-05"))

        // Totals wording clarifies direct input vs cache activity
        #expect(joined.contains(UsageFormatting.directInputTokensLabel))
        #expect(joined.contains("Cache Created"))
        #expect(joined.contains("Cache Read"))

        // Breakdown model names
        #expect(joined.contains("claude-sonnet-4-20250514"))
        #expect(joined.contains("claude-haiku-3"))

        // Breakdown table headers
        #expect(joined.contains("Group"))
        #expect(joined.contains("Tokens"))
        #expect(joined.contains("Cost"))

        let firstBreakdownRow = collectBreakdownRow(entry: breakdownEntries[0])
        let secondBreakdownRow = collectBreakdownRow(entry: breakdownEntries[1])
        #expect(firstBreakdownRow.contains(UsageFormatting.formatBreakdownSummary(breakdownEntries[0])))
        #expect(secondBreakdownRow.contains(UsageFormatting.formatBreakdownSummary(breakdownEntries[1])))
    }

    @Test @MainActor
    func tabRendersWithDifferentGroupByDimensions() async {
        let client = MockPanelClient()
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
                totalCacheCreationTokens: 0,
                totalCacheReadTokens: 0,
                totalEstimatedCostUsd: 0.01,
                eventCount: 1
            )
        ])

        let store = UsageDashboardStore()
        store.updateClient(client)
        await store.selectGroupBy(.provider)

        let joined = collectTabContent(store: store)

        #expect(store.selectedGroupBy == .provider)
        #expect(joined.contains("anthropic"))
    }

    @Test @MainActor
    func tabRendersTaskSeriesAndProfileSelection() async {
        let client = MockPanelClient()
        client.stubbedTotals = UsageTotalsResponse(
            totalInputTokens: 100, totalOutputTokens: 50,
            totalCacheCreationTokens: 0, totalCacheReadTokens: 0,
            totalEstimatedCostUsd: 0.03, eventCount: 2,
            pricedEventCount: 2, unpricedEventCount: 0
        )
        client.stubbedDaily = UsageDailyResponse(buckets: [])
        client.stubbedSeries = UsageSeriesResponse(buckets: [
            UsageSeriesBucket(
                date: "2026-03-04",
                displayLabel: "Mar 4",
                totalInputTokens: 100,
                totalOutputTokens: 50,
                totalEstimatedCostUsd: 0.03,
                eventCount: 2,
                groups: [
                    "value:mainAgent": UsageSeriesGroupValue(
                        group: "Main agent",
                        groupKey: "mainAgent",
                        totalInputTokens: 100,
                        totalOutputTokens: 50,
                        totalEstimatedCostUsd: 0.03,
                        eventCount: 2
                    )
                ]
            )
        ])
        client.stubbedBreakdown = UsageBreakdownResponse(breakdown: [
            UsageGroupBreakdownEntry(
                group: "Main agent",
                groupKey: "mainAgent",
                totalInputTokens: 100,
                totalOutputTokens: 50,
                totalEstimatedCostUsd: 0.03,
                eventCount: 2
            )
        ])

        let store = UsageDashboardStore()
        store.updateClient(client)
        await store.refresh()

        let joined = collectTabContent(store: store)
        #expect(client.lastSeriesGroupBy == "call_site")
        #expect(client.lastBreakdownGroupBy == "call_site")
        #expect(joined.contains("Inference Usage"))
        #expect(joined.contains("Daily Trend by Task"))
        #expect(joined.contains("Main agent"))

        await store.selectGroupBy(.inferenceProfile)
        #expect(client.lastSeriesGroupBy == "inference_profile")
        #expect(client.lastBreakdownGroupBy == "inference_profile")
    }
}

@Suite("UsageTabContent — View Rendering: Failed State")
struct UsageTabContentViewFailedTests {

    @Test @MainActor
    func tabRendersWithFailedState() async {
        let client = MockPanelClient()
        // All stubs nil — triggers failure states.

        let store = UsageDashboardStore()
        store.updateClient(client)
        await store.refresh()

        let joined = collectTabContent(store: store)

        // Error messages should contain "Failed to load" for each section
        #expect(joined.contains("Failed to load"))

        // Section headers should still render even in failed state
        #expect(joined.contains("Totals"))
        #expect(joined.contains("Inference Usage"))
        #expect(joined.contains("Breakdown"))
    }
}

// MARK: - Mock Client

@MainActor
private final class MockPanelClient: UsageClientProtocol {
    var stubbedTotals: UsageTotalsResponse?
    var stubbedDaily: UsageDailyResponse?
    var stubbedSeries: UsageSeriesResponse?
    var stubbedBreakdown: UsageBreakdownResponse?

    var lastTotalsFrom: Int?
    var lastDailyFrom: Int?
    var lastSeriesFrom: Int?
    var lastSeriesGroupBy: String?
    var lastBreakdownFrom: Int?
    var lastBreakdownGroupBy: String?

    func fetchUsageTotals(from: Int, to: Int) async -> UsageTotalsResponse? {
        lastTotalsFrom = from
        return stubbedTotals
    }

    func fetchUsageDaily(from: Int, to: Int, granularity: String, tz: String) async -> UsageDailyResponse? {
        lastDailyFrom = from
        return stubbedDaily
    }

    func fetchUsageSeries(from: Int, to: Int, granularity: String, groupBy: String, tz: String) async -> UsageSeriesResponse? {
        lastSeriesFrom = from
        lastSeriesGroupBy = groupBy
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
        lastBreakdownGroupBy = groupBy
        return stubbedBreakdown
    }
}
