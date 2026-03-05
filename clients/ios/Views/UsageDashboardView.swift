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
                    if store.needsRefresh {
                        await store.refresh()
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
                LabeledContent("Estimated Cost", value: Self.formatCost(totals.totalEstimatedCostUsd))
                LabeledContent("Input Tokens", value: Self.formatCount(totals.totalInputTokens))
                LabeledContent("Output Tokens", value: Self.formatCount(totals.totalOutputTokens))
                LabeledContent("Cache Creation", value: Self.formatCount(totals.totalCacheCreationTokens))
                LabeledContent("Cache Read", value: Self.formatCount(totals.totalCacheReadTokens))
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
                            Text(Self.formatCost(bucket.totalEstimatedCostUsd))
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
                            HStack {
                                Text(Self.formatCost(entry.totalEstimatedCostUsd))
                                    .font(.footnote)
                                Text("\(entry.eventCount) events")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Text("\(Self.formatCount(entry.totalInputTokens)) in / \(Self.formatCount(entry.totalOutputTokens)) out")
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

    // MARK: - Formatting Helpers

    static func formatCost(_ usd: Double) -> String {
        String(format: "$%.4f", usd)
    }

    static func formatCount(_ n: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        return formatter.string(from: NSNumber(value: n)) ?? "\(n)"
    }
}

#Preview {
    UsageDashboardView(
        store: UsageDashboardStore(client: MockDaemonClient())
    )
}
#endif
