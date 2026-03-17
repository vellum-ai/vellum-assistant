import SwiftUI
import VellumAssistantShared

struct UsageDashboardPanel: View {
    let store: UsageDashboardStore
    var onClose: () -> Void

    @State private var refreshTask: Task<Void, Never>?
    @State private var breakdownTask: Task<Void, Never>?

    var body: some View {
        VSidePanel(title: "Usage", onClose: onClose, pinnedContent: {
            timeRangeStrip(store: store)
        }) {
            contentView(store: store)
        }
        .onAppear {
            refreshTask = Task {
                if store.needsRefresh {
                    await store.refresh()
                }
            }
        }
        .onDisappear {
            refreshTask?.cancel()
            refreshTask = nil
            breakdownTask?.cancel()
            breakdownTask = nil
        }
    }

    // MARK: - Time Range Strip

    @ViewBuilder
    private func timeRangeStrip(store: UsageDashboardStore) -> some View {
        HStack {
            VDropdown(
                placeholder: "Time range",
                selection: Binding(
                    get: { store.selectedRange },
                    set: { newRange in
                        refreshTask?.cancel()
                        breakdownTask?.cancel()
                        refreshTask = Task { await store.selectRange(newRange) }
                    }
                ),
                options: UsageTimeRange.allCases.map { ($0.rawValue, $0) }
            )
            .frame(width: 160)
            Spacer()
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
    }

    // MARK: - Content

    @ViewBuilder
    func contentView(store: UsageDashboardStore) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            totalsSection(store: store)
            dailySection(store: store)
            breakdownSection(store: store)
        }
    }

    // MARK: - Totals Section

    @ViewBuilder
    private func totalsSection(store: UsageDashboardStore) -> some View {
        SettingsCard(title: "Totals") {
            switch store.totalsState {
            case .idle, .loading:
                loadingRow()
            case .loaded(let totals):
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: VSpacing.md) {
                    statCard(label: "Estimated Cost", value: formatCost(totals.totalEstimatedCostUsd))
                    statCard(label: "LLM Calls", value: formatCount(totals.eventCount))
                    statCard(label: UsageFormatting.directInputTokensLabel, value: formatTokenCount(totals.totalInputTokens))
                    statCard(label: "Output Tokens", value: formatTokenCount(totals.totalOutputTokens))
                    statCard(label: "Cache Created", value: formatTokenCount(totals.totalCacheCreationTokens))
                    statCard(label: "Cache Read", value: formatTokenCount(totals.totalCacheReadTokens))
                }
            case .failed(let message):
                errorRow(message)
            }
        }
    }

    // MARK: - Daily Trend Section

    @ViewBuilder
    private func dailySection(store: UsageDashboardStore) -> some View {
        SettingsCard(title: "Daily Trend") {
            switch store.dailyState {
            case .idle, .loading:
                loadingRow()
            case .loaded(let daily):
                if daily.buckets.isEmpty {
                    VEmptyState(
                        title: "No daily data",
                        subtitle: "No usage recorded in this time range",
                        icon: "calendar"
                    )
                } else {
                    dailyBarChart(daily.buckets)
                }
            case .failed(let message):
                errorRow(message)
            }
        }
    }

    private let barChartHeight: CGFloat = 140
    private let maxBarWidth: CGFloat = 32

    @ViewBuilder
    private func dailyBarChart(_ buckets: [UsageDayBucket]) -> some View {
        let maxCost = buckets.map(\.totalEstimatedCostUsd).max() ?? 1.0

        VStack(alignment: .leading, spacing: VSpacing.xs) {
            // Bar chart — left-aligned
            HStack(alignment: .bottom, spacing: VSpacing.xs) {
                ForEach(buckets, id: \.date) { bucket in
                    let fraction = maxCost > 0 ? bucket.totalEstimatedCostUsd / maxCost : 0
                    VStack(spacing: VSpacing.xxs) {
                        Spacer(minLength: 0)
                        RoundedRectangle(cornerRadius: VRadius.xs)
                            .fill(VColor.systemPositiveStrong)
                            .frame(width: maxBarWidth, height: max(2, barChartHeight * fraction))
                    }
                }
            }
            .frame(height: barChartHeight)

            // Cost + date labels — left-aligned
            HStack(alignment: .top, spacing: VSpacing.xs) {
                ForEach(buckets, id: \.date) { bucket in
                    VStack(spacing: VSpacing.xxs) {
                        Text(formatCost(bucket.totalEstimatedCostUsd))
                            .font(VFont.small)
                            .foregroundColor(VColor.contentSecondary)
                        Text(formatShortDate(bucket.date))
                            .font(VFont.small)
                            .foregroundColor(VColor.contentTertiary)
                    }
                    .frame(width: maxBarWidth)
                    .lineLimit(1)
                }
            }
        }
    }

    /// Formats a date string (e.g. "2026-03-15") to a short label (e.g. "15").
    private func formatShortDate(_ dateString: String) -> String {
        let parts = dateString.split(separator: "-")
        guard parts.count == 3 else { return dateString }
        return String(parts[2]).replacingOccurrences(of: "^0", with: "", options: .regularExpression)
    }

    // MARK: - Breakdown Section

    @ViewBuilder
    private func breakdownSection(store: UsageDashboardStore) -> some View {
        SettingsCard(title: "Breakdown") {
            groupByPicker(store: store)

            switch store.breakdownState {
            case .idle, .loading:
                loadingRow()
            case .loaded(let breakdown):
                if breakdown.breakdown.isEmpty {
                    VEmptyState(
                        title: "No breakdown data",
                        subtitle: "No usage recorded for this grouping",
                        icon: "rectangle.3.group"
                    )
                } else {
                    breakdownTable(breakdown.breakdown)
                }
            case .failed(let message):
                errorRow(message)
            }
        }
    }

    @ViewBuilder
    private func groupByPicker(store: UsageDashboardStore) -> some View {
        VDropdown(
            placeholder: "Group by",
            selection: Binding(
                get: { store.selectedGroupBy },
                set: { newDimension in
                    breakdownTask?.cancel()
                    breakdownTask = Task { await store.selectGroupBy(newDimension) }
                }
            ),
            options: UsageGroupByDimension.allCases.map { ($0.rawValue.capitalized, $0) }
        )
        .frame(width: 140)
    }

    private let breakdownTableWidth: CGFloat = 500

    @ViewBuilder
    private func breakdownTable(_ entries: [UsageGroupBreakdownEntry]) -> some View {
        VStack(spacing: VSpacing.sm) {
            // Header row
            HStack(alignment: .top, spacing: VSpacing.sm) {
                Text("Group")
                    .font(VFont.small)
                    .foregroundColor(VColor.contentTertiary)
                    .frame(width: 130, alignment: .leading)
                Text("Tokens")
                    .font(VFont.small)
                    .foregroundColor(VColor.contentTertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("Cost")
                    .font(VFont.small)
                    .foregroundColor(VColor.contentTertiary)
                    .frame(width: 60, alignment: .trailing)
            }
            .padding(.bottom, VSpacing.xxs)

            ForEach(entries, id: \.group) { entry in
                breakdownRow(entry)
            }
        }
        .frame(maxWidth: breakdownTableWidth, alignment: .leading)
    }

    @ViewBuilder
    func breakdownRow(_ entry: UsageGroupBreakdownEntry) -> some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            Text(entry.group)
                .font(VFont.captionMedium)
                .foregroundColor(VColor.contentDefault)
                .frame(width: 130, alignment: .leading)
                .lineLimit(1)
            Text(UsageFormatting.formatBreakdownSummary(entry))
                .font(VFont.small)
                .foregroundColor(VColor.contentSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            Text(formatCost(entry.totalEstimatedCostUsd))
                .font(VFont.small)
                .foregroundColor(VColor.contentSecondary)
                .frame(width: 60, alignment: .trailing)
        }
    }

    // MARK: - Shared Components

    @ViewBuilder
    private func statCard(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            Text(value)
                .font(VFont.captionMedium)
                .foregroundColor(VColor.contentDefault)
            Text(label)
                .font(VFont.small)
                .foregroundColor(VColor.contentTertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.sm)
        .background(VColor.borderBase.opacity(0.15))
        .cornerRadius(8)
    }

    @ViewBuilder
    private func loadingRow() -> some View {
        HStack {
            ProgressView()
                .controlSize(.small)
            Text("Loading...")
                .font(VFont.small)
                .foregroundColor(VColor.contentTertiary)
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.vertical, VSpacing.md)
    }

    @ViewBuilder
    private func errorRow(_ message: String) -> some View {
        HStack(spacing: VSpacing.xs) {
            VIconView(.triangleAlert, size: 14)
                .foregroundColor(VColor.systemNegativeHover)
            Text(message)
                .font(VFont.small)
                .foregroundColor(VColor.contentTertiary)
        }
        .padding(.vertical, VSpacing.sm)
    }

    // MARK: - Formatters

    private func formatCost(_ usd: Double) -> String {
        if usd < 0.01 {
            return UsageFormatting.formatCost(usd)
        }
        return UsageFormatting.formatCostShort(usd)
    }

    private func formatTokenCount(_ count: Int) -> String {
        if count >= 1_000_000 {
            return String(format: "%.1fM", Double(count) / 1_000_000)
        }
        if count >= 1_000 {
            return String(format: "%.1fk", Double(count) / 1_000)
        }
        return "\(count)"
    }

    private func formatCount(_ count: Int) -> String {
        UsageFormatting.formatCount(count)
    }
}

#Preview {
    ZStack {
        VColor.surfaceOverlay.ignoresSafeArea()
        UsageDashboardPanel(store: UsageDashboardStore(), onClose: {})
    }
    .frame(width: 400, height: 600)
}
