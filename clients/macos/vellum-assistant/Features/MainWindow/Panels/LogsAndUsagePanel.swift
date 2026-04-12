import SwiftUI
import VellumAssistantShared

enum LogsAndUsageTab: String {
    case logs = "Logs"
    case usage = "Usage"

    var icon: VIcon {
        switch self {
        case .logs: return .scrollText
        case .usage: return .barChart
        }
    }

    static var allTabs: [LogsAndUsageTab] { [.logs, .usage] }
}

@MainActor
struct LogsAndUsagePanel: View {
    @ObservedObject var traceStore: TraceStore
    @ObservedObject var connectionManager: GatewayConnectionManager
    let activeSessionId: String?
    let usageDashboardStore: UsageDashboardStore
    var onClose: () -> Void
    var onSelectConversation: (String) -> Void

    @State private var selectedTab: LogsAndUsageTab = .logs

    var body: some View {
        VStack(spacing: 0) {
            // Header: back chevron + title
            HStack(spacing: VSpacing.md) {
                VButton(
                    label: "Back",
                    iconOnly: VIcon.chevronLeft.rawValue,
                    style: .ghost,
                    tooltip: "Back"
                ) {
                    onClose()
                }

                Text("Logs & Usage")
                    .font(VFont.titleLarge)
                    .foregroundStyle(VColor.contentEmphasized)

                Spacer()
            }
            .padding(.trailing, VSpacing.xl)
            .padding(.bottom, VSpacing.md)

            VColor.borderDisabled.frame(height: 1)
                .padding(.trailing, VSpacing.xl)

            // Body: nav pinned left + content area (each tab manages its own scrolling)
            HStack(alignment: .top, spacing: 0) {
                tabNav
                    .frame(width: 200)

                selectedTabContent
                    .padding(.top, VSpacing.lg)
                    .padding(.trailing, VSpacing.xl)
                    .padding(.bottom, VSpacing.xl)
                    .frame(maxWidth: .infinity)
            }
            .frame(maxWidth: .infinity)
        }
        .padding(.top, VSpacing.xl)
        .padding(.leading, VSpacing.xl)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
    }

    // MARK: - Nav Sidebar

    private var tabNav: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            ForEach(LogsAndUsageTab.allTabs, id: \.self) { tab in
                VNavItem(icon: tab.icon.rawValue, label: tab.rawValue, isActive: selectedTab == tab) {
                    selectedTab = tab
                }
            }
            Spacer()
        }
        .padding(.top, VSpacing.lg)
        .padding(.bottom, VSpacing.xl)
        .padding(.trailing, VSpacing.sm)
    }

    // MARK: - Tab Content Router

    @ViewBuilder
    private var selectedTabContent: some View {
        switch selectedTab {
        case .logs:
            LogsTabContent(
                traceStore: traceStore,
                connectionManager: connectionManager,
                activeSessionId: activeSessionId
            )
        case .usage:
            UsageTabContent(store: usageDashboardStore, onSelectConversation: onSelectConversation)
        }
    }
}

// MARK: - Logs Tab Content

@MainActor
struct LogsTabContent: View {
    @ObservedObject var traceStore: TraceStore
    @ObservedObject var connectionManager: GatewayConnectionManager
    let activeSessionId: String?

    @State private var loadingConversationId: String?
    @State private var hydrationTask: Task<Void, Never>?
    private let traceEventClient: any TraceEventClientProtocol = TraceEventClient()

    private var isLoadingHistory: Bool {
        loadingConversationId != nil && loadingConversationId == activeSessionId
    }

    private var hasEvents: Bool {
        guard let conversationId = activeSessionId else { return false }
        return !(traceStore.eventsByConversation[conversationId] ?? []).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            if let conversationId = activeSessionId {
                metricsCard(conversationId: conversationId)

                if hasEvents {
                    TraceTimelineView(traceStore: traceStore, conversationId: conversationId)
                }
            }

            if !hasEvents {
                Spacer()
                if activeSessionId != nil {
                    if isLoadingHistory {
                        VEmptyState(
                            title: "Loading trace history...",
                            subtitle: "Fetching persisted events from the assistant",
                            icon: "waveform.path"
                        )
                    } else {
                        VEmptyState(
                            title: "No trace events yet",
                            subtitle: "Events will appear as the session runs",
                            icon: "waveform.path"
                        )
                    }
                } else {
                    VEmptyState(
                        title: "No session selected",
                        subtitle: "Start a conversation to see trace events",
                        icon: "ant"
                    )
                }
                Spacer()
            }
        }
        .frame(maxWidth: 900, alignment: .top)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear {
            traceStore.isObserved = true
            hydrateIfNeeded()
        }
        .onDisappear { traceStore.isObserved = false }
        .onChange(of: activeSessionId) { _, _ in
            hydrationTask?.cancel()
            hydrationTask = nil
            loadingConversationId = nil
            hydrateIfNeeded()
        }
    }

    // MARK: - History Hydration

    private func hydrateIfNeeded() {
        guard let conversationId = activeSessionId else { return }
        guard loadingConversationId != conversationId else { return }
        loadingConversationId = conversationId
        hydrationTask = Task {
            defer {
                if !Task.isCancelled {
                    loadingConversationId = nil
                    hydrationTask = nil
                }
            }
            do {
                let events = try await traceEventClient.fetchHistory(conversationId: conversationId)
                guard !Task.isCancelled else { return }
                traceStore.loadHistory(events)
            } catch {
                // Fetch failed — fall back to the existing empty state
            }
        }
    }

    // MARK: - Metrics Card

    @ViewBuilder
    private func metricsCard(conversationId: String) -> some View {
        SettingsCard(title: "Session Metrics") {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: VSpacing.md) {
                metricStatCard(
                    label: "Requests",
                    value: "\(traceStore.requestCount(conversationId: conversationId))"
                )
                metricStatCard(
                    label: "LLM Calls",
                    value: "\(traceStore.llmCallCount(conversationId: conversationId))"
                )
                metricStatCard(
                    label: "Tokens",
                    value: formatTokens(
                        input: traceStore.totalInputTokens(conversationId: conversationId),
                        output: traceStore.totalOutputTokens(conversationId: conversationId)
                    )
                )
                metricStatCard(
                    label: "Avg Latency",
                    value: formatLatency(traceStore.averageLlmLatencyMs(conversationId: conversationId))
                )

                let failures = traceStore.toolFailureCount(conversationId: conversationId)
                if failures > 0 {
                    metricStatCard(
                        label: "Failures",
                        value: "\(failures)",
                        valueColor: VColor.systemNegativeStrong
                    )
                }

                if let memory = connectionManager.latestMemoryStatus {
                    let memoryDegraded = memory.enabled && memory.degraded
                    metricStatCard(
                        label: "Memory",
                        value: !memory.enabled ? "Disabled"
                            : memoryDegraded ? "Degraded"
                            : "Healthy",
                        valueColor: !memory.enabled ? VColor.contentTertiary
                            : memoryDegraded ? VColor.systemMidStrong
                            : VColor.systemPositiveStrong
                    )
                    if let provider = memory.provider {
                        metricStatCard(
                            label: "Embed Provider",
                            value: memory.model.map { "\(provider)/\($0)" } ?? provider
                        )
                    }
                    if memoryDegraded, let reason = memory.reason {
                        metricStatCard(
                            label: "Degradation Reason",
                            value: reason,
                            valueColor: VColor.systemMidStrong
                        )
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func metricStatCard(label: String, value: String, valueColor: Color = VColor.contentDefault) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            Text(value)
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(valueColor)
            Text(label)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.sm)
        .background(VColor.borderBase.opacity(0.15))
        .cornerRadius(8)
    }

    // MARK: - Formatters

    private func formatTokens(input: Int, output: Int) -> String {
        let total = input + output
        if total >= 1000 {
            return String(format: "%.1fk", Double(total) / 1000)
        }
        return "\(total)"
    }

    private func formatLatency(_ ms: Double) -> String {
        if ms <= 0 { return "--" }
        if ms >= 1000 {
            return String(format: "%.1fs", ms / 1000)
        }
        return String(format: "%.0fms", ms)
    }
}

// MARK: - Usage Tab Content

@MainActor
struct UsageTabContent: View {
    let store: UsageDashboardStore
    let onSelectConversation: (String) -> Void

    @State private var refreshTask: Task<Void, Never>?
    @State private var breakdownTask: Task<Void, Never>?
    @State private var hoveredConversationGroupId: String?

    private var allFailed: Bool {
        store.totalsState.isFailed && store.dailyState.isFailed && store.breakdownState.isFailed
    }

    var body: some View {
        ScrollView {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            timeRangeStrip(store: store)

            if allFailed {
                VStack(spacing: VSpacing.lg) {
                    VIconView(.circleAlert, size: 32)
                        .foregroundStyle(VColor.systemNegativeHover)
                    Text("Unable to load usage data")
                        .font(VFont.bodySmallEmphasised)
                        .foregroundStyle(VColor.contentDefault)
                    Text("Please check your connection and try again.")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                    VButton(label: "Try Again", style: .outlined) {
                        refreshTask?.cancel()
                        refreshTask = Task { await store.refresh() }
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, VSpacing.xl)
            } else {
                totalsSection(store: store)
                dailySection(store: store)
                breakdownSection(store: store)
            }
        }
        .frame(maxWidth: 900, alignment: .top)
        .frame(maxWidth: .infinity)
        .background { OverlayScrollerStyle() }
        }
        .scrollContentBackground(.hidden)
        .onAppear {
            refreshTask = Task {
                await store.refresh()
            }
        }
        .onChange(of: store.needsRefresh) {
            let hasIdle = store.totalsState == .idle || store.dailyState == .idle || store.breakdownState == .idle
            if hasIdle {
                refreshTask?.cancel()
                refreshTask = Task {
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
                options: UsageTimeRange.allCases.map { VDropdownOption(label: $0.rawValue, value: $0) },
                selection: Binding(
                    get: { store.selectedRange },
                    set: { _ in }
                ),
                maxWidth: 150,
                onChange: { newRange in
                    refreshTask?.cancel()
                    breakdownTask?.cancel()
                    refreshTask = Task { await store.selectRange(newRange) }
                }
            )
            Spacer()
        }
    }

    // MARK: - Totals Section

    @ViewBuilder
    func totalsSection(store: UsageDashboardStore) -> some View {
        SettingsCard(title: "Totals") {
            switch store.totalsState {
            case .idle, .loading:
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: VSpacing.md) {
                    ForEach(0..<6, id: \.self) { _ in
                        VStack(alignment: .leading, spacing: VSpacing.xxs) {
                            VSkeletonBone(width: 50, height: 14)
                            VSkeletonBone(width: 90, height: 12)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(VSpacing.sm)
                        .background(VColor.borderBase.opacity(0.15))
                        .cornerRadius(8)
                    }
                }
                .accessibilityHidden(true)
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
                errorRow(message) { refreshTask?.cancel(); refreshTask = Task { await store.refresh() } }
            }
        }
    }

    // MARK: - Trend Section

    @ViewBuilder
    func dailySection(store: UsageDashboardStore) -> some View {
        let isHourly = store.isHourlyGranularity
        SettingsCard(title: isHourly ? "Hourly Trend" : "Daily Trend") {
            switch store.dailyState {
            case .idle, .loading:
                HStack(alignment: .bottom, spacing: VSpacing.xs) {
                    ForEach(0..<7, id: \.self) { index in
                        VStack(spacing: VSpacing.xxs) {
                            Spacer(minLength: 0)
                            VSkeletonBone(width: maxBarWidth, height: CGFloat([40, 80, 60, 100, 50, 70, 30][index]), radius: VRadius.xs)
                        }
                    }
                }
                .frame(height: barChartHeight)
                .accessibilityHidden(true)
            case .loaded(let daily):
                if daily.buckets.isEmpty {
                    VEmptyState(
                        title: isHourly ? "No hourly data" : "No daily data",
                        subtitle: "No usage recorded in this time range",
                        icon: "calendar"
                    )
                } else {
                    trendBarChart(daily.buckets, isHourly: isHourly)
                }
            case .failed(let message):
                errorRow(message) { refreshTask?.cancel(); refreshTask = Task { await store.refresh() } }
            }
        }
    }

    private let barChartHeight: CGFloat = 140
    private let maxBarWidth: CGFloat = 40
    private let hourlyBarWidth: CGFloat = 28

    @ViewBuilder
    private func trendBarChart(_ buckets: [UsageDayBucket], isHourly: Bool) -> some View {
        let sorted = buckets.sorted { $0.date < $1.date }
        let maxCost = buckets.map(\.totalEstimatedCostUsd).max() ?? 1.0
        let barWidth = isHourly ? hourlyBarWidth : maxBarWidth

        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                HStack(alignment: .bottom, spacing: VSpacing.xs) {
                    ForEach(sorted, id: \.bucketId) { bucket in
                        let fraction = maxCost > 0 ? bucket.totalEstimatedCostUsd / maxCost : 0
                        VStack(spacing: VSpacing.xxs) {
                            Spacer(minLength: 0)
                            RoundedRectangle(cornerRadius: VRadius.xs)
                                .fill(VColor.systemPositiveStrong)
                                .frame(width: barWidth, height: max(2, barChartHeight * fraction))
                        }
                    }
                }
                .frame(height: barChartHeight)

                HStack(alignment: .top, spacing: VSpacing.xs) {
                    ForEach(sorted, id: \.bucketId) { bucket in
                        VStack(spacing: VSpacing.xxs) {
                            Text(formatCost(bucket.totalEstimatedCostUsd))
                                .font(VFont.labelSmall)
                                .foregroundStyle(VColor.contentSecondary)
                            Text(formatBucketLabel(bucket))
                                .font(VFont.labelSmall)
                                .foregroundStyle(VColor.contentTertiary)
                        }
                        .frame(width: barWidth)
                        .lineLimit(1)
                    }
                }
            }
        }
    }

    /// The daemon emits `displayLabel` already formatted in the requested
    /// timezone. We fall back to the raw `date` string for responses from
    /// older daemons that don't include the label.
    private func formatBucketLabel(_ bucket: UsageDayBucket) -> String {
        bucket.displayLabel ?? bucket.date
    }

    // MARK: - Breakdown Section

    @ViewBuilder
    func breakdownSection(store: UsageDashboardStore) -> some View {
        SettingsCard(title: "Breakdown") {
            groupByPicker(store: store)

            switch store.breakdownState {
            case .idle, .loading:
                VStack(spacing: 0) {
                    HStack(spacing: VSpacing.sm) {
                        VSkeletonBone(width: 50, height: 12)
                        VSkeletonBone(height: 12)
                        VSkeletonBone(width: 50, height: 12)
                    }
                    .padding(.horizontal, VSpacing.md)
                    .padding(.vertical, VSpacing.sm)
                    ForEach(0..<4, id: \.self) { _ in
                        Divider().background(VColor.borderBase)
                        HStack(spacing: VSpacing.sm) {
                            VSkeletonBone(width: 100, height: 14)
                            VSkeletonBone(height: 12)
                            VSkeletonBone(width: 50, height: 14)
                        }
                        .padding(.horizontal, VSpacing.md)
                        .padding(.vertical, VSpacing.sm)
                    }
                }
                .frame(maxWidth: breakdownTableWidth, alignment: .leading)
                .accessibilityHidden(true)
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
                errorRow(message) { refreshTask?.cancel(); refreshTask = Task { await store.refresh() } }
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
            options: UsageGroupByDimension.allCases.map { ($0.rawValue.capitalized, $0) },
            maxWidth: 140
        )
    }

    private var groupColumnWidth: CGFloat {
        store.selectedGroupBy == .conversation ? 200 : 130
    }

    private let breakdownTableWidth: CGFloat = 500

    @ViewBuilder
    private func breakdownTable(_ entries: [UsageGroupBreakdownEntry]) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .center, spacing: VSpacing.sm) {
                Text("Group")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .frame(width: groupColumnWidth, alignment: .leading)
                Text("Tokens")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("Cost")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .frame(width: 70, alignment: .trailing)
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)

            ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                Divider().background(VColor.borderBase)
                breakdownRow(entry)
            }
        }
        .frame(maxWidth: breakdownTableWidth, alignment: .leading)
    }

    /// Returns the conversation id that a tap on `entry`'s row should
    /// navigate to, or `nil` if the row is not navigable (non-conversation
    /// group-by, or the "Other" bucket whose `groupId` is nil). Extracted as a
    /// pure helper so it can be unit-tested without mounting the view.
    func navigationTarget(for entry: UsageGroupBreakdownEntry) -> String? {
        guard store.selectedGroupBy == .conversation else { return nil }
        return entry.groupId
    }

    @ViewBuilder
    func breakdownRow(_ entry: UsageGroupBreakdownEntry) -> some View {
        let target = navigationTarget(for: entry)
        let isHovered = target != nil && hoveredConversationGroupId == target
        let titleColor: Color = isHovered ? VColor.contentEmphasized : VColor.contentDefault

        let row = HStack(alignment: .top, spacing: VSpacing.sm) {
            Text(entry.group)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(titleColor)
                .frame(width: groupColumnWidth, alignment: .leading)
                .lineLimit(store.selectedGroupBy == .conversation ? 2 : 1)
            Text(UsageFormatting.formatBreakdownSummary(entry))
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            Text(formatCost(entry.totalEstimatedCostUsd))
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
                .frame(width: 70, alignment: .trailing)
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)

        if let target {
            row
                .background(VColor.borderBase.opacity(isHovered ? 0.15 : 0))
                .contentShape(Rectangle())
                .onTapGesture {
                    onSelectConversation(target)
                }
                .pointerCursor { hovering in
                    hoveredConversationGroupId = hovering ? target : nil
                }
                .accessibilityAddTraits(.isButton)
                .accessibilityAction {
                    onSelectConversation(target)
                }
        } else {
            row
        }
    }

    // MARK: - Shared Components

    @ViewBuilder
    private func statCard(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            Text(value)
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentDefault)
            Text(label)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.sm)
        .background(VColor.borderBase.opacity(0.15))
        .cornerRadius(8)
    }

    @ViewBuilder
    private func errorRow(_ message: String, retryAction: (() -> Void)? = nil) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.xs) {
                VIconView(.triangleAlert, size: 14)
                    .foregroundStyle(VColor.systemNegativeHover)
                Text(message)
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentTertiary)
            }
            if let retryAction {
                VButton(label: "Try Again", style: .outlined) {
                    retryAction()
                }
            }
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
