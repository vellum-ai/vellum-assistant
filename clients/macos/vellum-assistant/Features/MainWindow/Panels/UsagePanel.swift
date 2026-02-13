import SwiftUI
import Charts

@MainActor
struct UsagePanel: View {
    var onClose: () -> Void
    let daemonClient: DaemonClient

    @StateObject private var usageManager: UsageManager

    init(onClose: @escaping () -> Void, daemonClient: DaemonClient) {
        self.onClose = onClose
        self.daemonClient = daemonClient
        _usageManager = StateObject(
            wrappedValue: UsageManager(daemonClient: daemonClient)
        )
    }

    private let presets = ["24h", "7d", "30d"]

    var body: some View {
        VSidePanel(title: "Usage", onClose: onClose) {
            VStack(alignment: .leading, spacing: VSpacing.xl) {
                // Time preset selector
                presetSelector

                // Budget warning banner
                if !usageManager.budgetWarnings.isEmpty {
                    budgetWarningBanner
                }

                // Summary totals
                if let summary = usageManager.summary {
                    summarySection(summary)
                    dailyChartSection(summary)
                    providerBreakdown(summary)
                    modelBreakdown(summary)
                }

                // Budget status
                if let budget = usageManager.budgetStatus, budget.enabled {
                    budgetStatusSection(budget)
                }

                if usageManager.isLoading && usageManager.summary == nil {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                }
            }
        }
        .onAppear {
            usageManager.fetchSummary()
            usageManager.fetchBudgetStatus()
            usageManager.subscribeToBudgetWarnings()
        }
    }

    // MARK: - Preset Selector

    private var presetSelector: some View {
        HStack(spacing: 0) {
            ForEach(presets, id: \.self) { preset in
                Button(action: {
                    usageManager.selectedPreset = preset
                    usageManager.fetchSummary()
                }) {
                    Text(preset)
                        .font(VFont.captionMedium)
                        .foregroundColor(
                            usageManager.selectedPreset == preset
                                ? VColor.textPrimary
                                : VColor.textSecondary
                        )
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, VSpacing.xs)
                }
                .buttonStyle(.plain)
                .background(
                    usageManager.selectedPreset == preset
                        ? VColor.surface
                        : Color.clear
                )
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
    }

    // MARK: - Budget Warning Banner

    private var budgetWarningBanner: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            HStack(spacing: VSpacing.xs) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 12))
                    .foregroundColor(VColor.warning)
                Text("Budget Warning")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.warning)
            }
            ForEach(usageManager.budgetWarnings) { violation in
                Text("Spent $\(violation.currentSpend, specifier: "%.2f") of $\(violation.amountUsd, specifier: "%.2f") \(violation.period) budget")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
            }
        }
        .padding(VSpacing.lg)
        .vCard()
    }

    // MARK: - Summary Section

    private func summarySection(_ summary: UsageSummaryResponseMessage) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("SUMMARY")
                .font(VFont.display)
                .foregroundColor(VColor.textPrimary)

            // Total cost
            Text("$\(summary.totalPricedCostUsd, specifier: "%.2f")")
                .font(VFont.largeTitle)
                .foregroundColor(VColor.textPrimary)

            // Token counts
            HStack(spacing: VSpacing.xl) {
                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text("Input tokens")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    Text(formatTokenCount(summary.totalInputTokens))
                        .font(VFont.mono)
                        .foregroundColor(VColor.textSecondary)
                }
                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text("Output tokens")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    Text(formatTokenCount(summary.totalOutputTokens))
                        .font(VFont.mono)
                        .foregroundColor(VColor.textSecondary)
                }
                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text("API calls")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    Text("\(summary.eventCount)")
                        .font(VFont.mono)
                        .foregroundColor(VColor.textSecondary)
                }
            }
        }
        .padding(VSpacing.lg)
        .vCard()
    }

    // MARK: - Daily Chart

    private func dailyChartSection(_ summary: UsageSummaryResponseMessage) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("DAILY SPEND")
                .font(VFont.display)
                .foregroundColor(VColor.textPrimary)

            if summary.dailyBuckets.isEmpty {
                Text("No data for this period")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            } else {
                Chart(summary.dailyBuckets) { bucket in
                    BarMark(
                        x: .value("Date", bucket.date),
                        y: .value("Cost", bucket.totalCost ?? 0)
                    )
                    .foregroundStyle(VColor.accent)
                    .cornerRadius(VRadius.xs)
                }
                .chartXAxis {
                    AxisMarks(values: .automatic) { _ in
                        AxisValueLabel()
                            .font(VFont.small)
                            .foregroundStyle(VColor.textMuted)
                    }
                }
                .chartYAxis {
                    AxisMarks { value in
                        AxisGridLine()
                            .foregroundStyle(VColor.surfaceBorder)
                        AxisValueLabel {
                            if let v = value.as(Double.self) {
                                Text("$\(v, specifier: "%.2f")")
                                    .font(VFont.small)
                                    .foregroundStyle(VColor.textMuted)
                            }
                        }
                    }
                }
                .frame(height: 140)
            }
        }
        .padding(VSpacing.lg)
        .vCard()
    }

    // MARK: - Provider Breakdown

    private func providerBreakdown(_ summary: UsageSummaryResponseMessage) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("BY PROVIDER")
                .font(VFont.display)
                .foregroundColor(VColor.textPrimary)

            if summary.byProvider.isEmpty {
                Text("No data")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            } else {
                ForEach(summary.byProvider) { entry in
                    breakdownRow(key: entry.key, cost: entry.totalCost, count: entry.eventCount)
                }
            }
        }
        .padding(VSpacing.lg)
        .vCard()
    }

    // MARK: - Model Breakdown

    private func modelBreakdown(_ summary: UsageSummaryResponseMessage) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("BY MODEL")
                .font(VFont.display)
                .foregroundColor(VColor.textPrimary)

            if summary.byModel.isEmpty {
                Text("No data")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            } else {
                ForEach(summary.byModel) { entry in
                    breakdownRow(key: entry.key, cost: entry.totalCost, count: entry.eventCount)
                }
            }
        }
        .padding(VSpacing.lg)
        .vCard()
    }

    // MARK: - Budget Status

    private func budgetStatusSection(_ budget: BudgetStatusResponseMessage) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("BUDGETS")
                .font(VFont.display)
                .foregroundColor(VColor.textPrimary)

            if budget.budgets.isEmpty {
                Text("No budgets configured")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            } else {
                ForEach(budget.budgets) { entry in
                    HStack {
                        VStack(alignment: .leading, spacing: VSpacing.xxs) {
                            Text(entry.period.capitalized)
                                .font(VFont.bodyMedium)
                                .foregroundColor(VColor.textPrimary)
                            Text("\(entry.action)")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: VSpacing.xxs) {
                            Text("$\(entry.currentSpend, specifier: "%.2f") / $\(entry.amountUsd, specifier: "%.2f")")
                                .font(VFont.mono)
                                .foregroundColor(entry.exceeded ? VColor.error : VColor.textSecondary)
                            if entry.exceeded {
                                Text("Exceeded")
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.error)
                            }
                        }
                    }
                    if entry.id != budget.budgets.last?.id {
                        Divider()
                    }
                }
            }
        }
        .padding(VSpacing.lg)
        .vCard()
    }

    // MARK: - Helpers

    private func breakdownRow(key: String, cost: Double?, count: Int) -> some View {
        HStack {
            Text(key)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .lineLimit(1)
            Spacer()
            if let cost = cost {
                Text("$\(cost, specifier: "%.2f")")
                    .font(VFont.mono)
                    .foregroundColor(VColor.textSecondary)
            } else {
                Text("N/A")
                    .font(VFont.mono)
                    .foregroundColor(VColor.textMuted)
            }
            Text("\(count) calls")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .frame(width: 60, alignment: .trailing)
        }
    }

    private func formatTokenCount(_ count: Int) -> String {
        if count >= 1_000_000 {
            return String(format: "%.1fM", Double(count) / 1_000_000)
        } else if count >= 1_000 {
            return String(format: "%.1fK", Double(count) / 1_000)
        }
        return "\(count)"
    }
}

#Preview("UsagePanel") {
    ZStack {
        VColor.background.ignoresSafeArea()
        UsagePanel(onClose: {}, daemonClient: DaemonClient())
    }
    .frame(width: 420, height: 700)
}
