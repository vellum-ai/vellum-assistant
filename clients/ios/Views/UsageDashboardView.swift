#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// iOS sheet presenting aggregated usage and cost data.
///
/// Reuses the shared `UsageDashboardStore` to show totals, daily trend buckets,
/// and grouped breakdowns in an iOS-friendly layout.
struct UsageDashboardView: View {
    @State var store: UsageDashboardStore

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Usage & Cost")
                .navigationBarTitleDisplayMode(.inline)
                .task {
                    await store.refresh()
                }
                .onChange(of: store.needsRefresh) {
                    if store.needsRefresh {
                        Task { await store.refresh() }
                    }
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        List {
            timeRangeSection
            totalsSection
            dailyTrendSection
            breakdownSection
        }
    }

    // MARK: - Time Range

    private var timeRangeSection: some View {
        Section {
            Picker("Time Range", selection: Binding(
                get: { store.selectedRange },
                set: { newRange in
                    Task { await store.selectRange(newRange) }
                }
            )) {
                ForEach(UsageTimeRange.allCases, id: \.self) { range in
                    Text(range.rawValue).tag(range)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    // MARK: - Totals

    @ViewBuilder
    private var totalsSection: some View {
        Section("Totals") {
            switch store.totalsState {
            case .idle, .loading:
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
            case .loaded(let totals):
                LabeledContent("Estimated Cost", value: UsageFormatting.formatCost(totals.totalEstimatedCostUsd))
                LabeledContent(UsageFormatting.directInputTokensLabel, value: UsageFormatting.formatCount(totals.totalInputTokens))
                LabeledContent("Output Tokens", value: UsageFormatting.formatCount(totals.totalOutputTokens))
                LabeledContent("Cache Created", value: UsageFormatting.formatCount(totals.totalCacheCreationTokens))
                LabeledContent("Cache Read", value: UsageFormatting.formatCount(totals.totalCacheReadTokens))
                LabeledContent("Events", value: "\(totals.eventCount)")
            case .failed(let message):
                Text(message)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Daily Trend

    @ViewBuilder
    private var dailyTrendSection: some View {
        Section("Daily Trend") {
            switch store.dailyState {
            case .idle, .loading:
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
            case .loaded(let daily):
                if daily.buckets.isEmpty {
                    Text("No data for selected range")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(daily.buckets, id: \.date) { bucket in
                        HStack {
                            Text(bucket.date)
                                .font(.footnote.monospaced())
                            Spacer()
                            Text(UsageFormatting.formatCost(bucket.totalEstimatedCostUsd))
                                .font(.footnote)
                            Text("\(bucket.eventCount) events")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            case .failed(let message):
                Text(message)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Breakdown

    @ViewBuilder
    private var breakdownSection: some View {
        Section {
            Picker("Group By", selection: Binding(
                get: { store.selectedGroupBy },
                set: { dimension in
                    Task { await store.selectGroupBy(dimension) }
                }
            )) {
                ForEach(UsageGroupByDimension.allCases, id: \.self) { dim in
                    Text(dim.rawValue.capitalized).tag(dim)
                }
            }
            .pickerStyle(.segmented)

            switch store.breakdownState {
            case .idle, .loading:
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
            case .loaded(let breakdown):
                if breakdown.breakdown.isEmpty {
                    Text("No data for selected range")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(breakdown.breakdown, id: \.group) { entry in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(entry.group)
                                .font(.subheadline.weight(.medium))
                            Text(UsageFormatting.formatBreakdownSummary(entry))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            HStack {
                                Text(UsageFormatting.formatCost(entry.totalEstimatedCostUsd))
                                    .font(.footnote)
                                Text("\(entry.eventCount) events")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            case .failed(let message):
                Text(message)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Breakdown")
        }
    }

}

#if DEBUG
#Preview {
    UsageDashboardView(
        store: UsageDashboardStore()
    )
}
#endif
#endif
