import Foundation

// MARK: - Usage Client Protocol

/// Abstraction for fetching usage data, decoupled from the full GatewayConnectionManager.
@MainActor
public protocol UsageClientProtocol {
    func fetchUsageTotals(from: Int, to: Int) async -> UsageTotalsResponse?
    func fetchUsageDaily(from: Int, to: Int, granularity: String) async -> UsageDailyResponse?
    func fetchUsageBreakdown(from: Int, to: Int, groupBy: String) async -> UsageBreakdownResponse?
}

/// Fetches usage data via GatewayHTTPClient.
@MainActor
public struct UsageClient: UsageClientProtocol {
    /// A restricted character set for encoding query parameter values.
    /// `.urlQueryAllowed` permits `&`, `=`, `+`, and `#` which are
    /// query-string metacharacters that would break parameter parsing.
    private static let queryValueAllowed: CharacterSet = {
        var cs = CharacterSet.urlQueryAllowed
        cs.remove(charactersIn: "&=+#")
        return cs
    }()

    nonisolated public init() {}

    public func fetchUsageTotals(from: Int, to: Int) async -> UsageTotalsResponse? {
        let result: (UsageTotalsResponse?, GatewayHTTPClient.Response)? = try? await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/usage/totals?from=\(from)&to=\(to)", timeout: 10
        )
        return result?.0
    }

    public func fetchUsageDaily(from: Int, to: Int, granularity: String = "daily") async -> UsageDailyResponse? {
        let result: (UsageDailyResponse?, GatewayHTTPClient.Response)? = try? await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/usage/daily?from=\(from)&to=\(to)&granularity=\(granularity)", timeout: 10
        )
        return result?.0
    }

    public func fetchUsageBreakdown(from: Int, to: Int, groupBy: String) async -> UsageBreakdownResponse? {
        let encoded = groupBy.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? groupBy
        let result: (UsageBreakdownResponse?, GatewayHTTPClient.Response)? = try? await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/usage/breakdown?from=\(from)&to=\(to)&groupBy=\(encoded)", timeout: 10
        )
        return result?.0
    }
}

// MARK: - Time Range Selection

/// Predefined time ranges for the usage dashboard.
public enum UsageTimeRange: String, CaseIterable, Sendable {
    case today = "Today"
    case last7Days = "Last 7 Days"
    case last30Days = "Last 30 Days"
    case last90Days = "Last 90 Days"

    /// Compute the epoch-millisecond `from` and `to` bounds for this range.
    /// `to` is always the current instant; `from` is midnight UTC of the starting day.
    public func epochMillisRange(now: Date = Date()) -> (from: Int, to: Int) {
        let to = Int(now.timeIntervalSince1970 * 1000)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let startOfToday = calendar.startOfDay(for: now)

        let startDate: Date
        switch self {
        case .today:
            startDate = startOfToday
        case .last7Days:
            startDate = calendar.date(byAdding: .day, value: -6, to: startOfToday)!
        case .last30Days:
            startDate = calendar.date(byAdding: .day, value: -29, to: startOfToday)!
        case .last90Days:
            startDate = calendar.date(byAdding: .day, value: -89, to: startOfToday)!
        }

        let from = Int(startDate.timeIntervalSince1970 * 1000)
        return (from: from, to: to)
    }
}

// MARK: - Loading State

/// Tri-state loading model for async fetches.
public enum UsageLoadingState<T: Equatable>: Equatable {
    case idle
    case loading
    case loaded(T)
    case failed(String)

    public var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }
}

// MARK: - Group-By Dimension

/// The dimension to group usage breakdown by.
public enum UsageGroupByDimension: String, CaseIterable, Sendable {
    case actor
    case provider
    case model
}

// MARK: - Formatting Helpers

/// Formatting helpers for usage dashboard values, shared across platforms.
public enum UsageFormatting {
    public static let directInputTokensLabel = "Direct Input Tokens"

    public static func formatCost(_ usd: Double) -> String {
        formatCostWithPrecision(usd, fractionDigits: 4)
    }

    /// Format a cost value with 2 decimal places, suitable for display
    /// amounts >= $0.01 where extra precision is unnecessary.
    public static func formatCostShort(_ usd: Double) -> String {
        formatCostWithPrecision(usd, fractionDigits: 2)
    }

    private static func formatCostWithPrecision(_ usd: Double, fractionDigits: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.minimumFractionDigits = fractionDigits
        formatter.maximumFractionDigits = fractionDigits
        return formatter.string(from: NSNumber(value: usd)) ?? "\(usd)"
    }

    public static func formatCount(_ n: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        return formatter.string(from: NSNumber(value: n)) ?? "\(n)"
    }

    public static func formatBreakdownSummary(_ entry: UsageGroupBreakdownEntry) -> String {
        let segments = [
            "\(formatCount(entry.totalInputTokens)) direct",
            "\(formatCount(entry.totalCacheCreationTokens)) cache created",
            "\(formatCount(entry.totalCacheReadTokens)) cache read",
            "\(formatCount(entry.totalOutputTokens)) out",
        ]
        return segments.joined(separator: " / ")
    }
}

// MARK: - UsageDashboardStore

/// Shared store that owns the selected time range, fetches usage data from the
/// daemon client, and exposes loaded summaries for both macOS and iOS dashboards.
@MainActor
@Observable
public final class UsageDashboardStore {

    // MARK: - State

    public var selectedRange: UsageTimeRange = .last7Days
    public var totalsState: UsageLoadingState<UsageTotalsResponse> = .idle
    public var dailyState: UsageLoadingState<UsageDailyResponse> = .idle
    public var breakdownState: UsageLoadingState<UsageBreakdownResponse> = .idle
    public var selectedGroupBy: UsageGroupByDimension = .model

    /// Whether the current daily data uses hourly granularity (true when range is "Today").
    public var isHourlyGranularity: Bool { selectedRange == .today }

    // MARK: - Dependencies

    private var client: any UsageClientProtocol = UsageClient()

    /// Generation counters to discard results from stale in-flight requests
    /// when the user changes filters faster than fetches complete.
    private var refreshGeneration: UInt = 0
    private var breakdownGeneration: UInt = 0

    public init() {}

    /// Replace the underlying client and reset all loaded data.
    public func updateClient(_ newClient: any UsageClientProtocol) {
        client = newClient
        reset()
    }

    /// Reset all loaded data so the next `refresh()` re-fetches.
    public func reset() {
        refreshGeneration &+= 1
        breakdownGeneration &+= 1
        totalsState = .idle
        dailyState = .idle
        breakdownState = .idle
    }

    /// Whether any section needs a (re)fetch — used by views to auto-refresh
    /// on first appearance or after a partial/total failure.
    public var needsRefresh: Bool {
        totalsState == .idle || totalsState.isFailed ||
        dailyState == .idle || dailyState.isFailed ||
        breakdownState == .idle || breakdownState.isFailed
    }

    // MARK: - Refresh

    /// Load all usage data (totals, daily, breakdown) for the currently selected range.
    public func refresh() async {
        refreshGeneration &+= 1
        let capturedRefreshGen = refreshGeneration
        breakdownGeneration &+= 1
        let capturedBreakdownGen = breakdownGeneration

        let range = selectedRange.epochMillisRange()

        totalsState = .loading
        dailyState = .loading
        breakdownState = .loading

        let granularity = isHourlyGranularity ? "hourly" : "daily"
        async let totalsResult = client.fetchUsageTotals(from: range.from, to: range.to)
        async let dailyResult = client.fetchUsageDaily(from: range.from, to: range.to, granularity: granularity)
        async let breakdownResult = client.fetchUsageBreakdown(
            from: range.from, to: range.to, groupBy: selectedGroupBy.rawValue
        )

        let totals = await totalsResult
        let daily = await dailyResult
        let breakdown = await breakdownResult

        if capturedRefreshGen == refreshGeneration {
            if let totals {
                totalsState = .loaded(totals)
            } else {
                totalsState = .failed("Failed to load usage totals")
            }

            if let daily {
                dailyState = .loaded(daily)
            } else {
                dailyState = .failed("Failed to load daily usage")
            }
        }

        if capturedBreakdownGen == breakdownGeneration {
            if let breakdown {
                breakdownState = .loaded(breakdown)
            } else {
                breakdownState = .failed("Failed to load usage breakdown")
            }
        }
    }

    /// Convenience to change the selected range and immediately refresh.
    public func selectRange(_ range: UsageTimeRange) async {
        selectedRange = range
        await refresh()
    }

    /// Convenience to change the group-by dimension and refresh the breakdown.
    public func selectGroupBy(_ dimension: UsageGroupByDimension) async {
        selectedGroupBy = dimension
        breakdownGeneration &+= 1
        let capturedGeneration = breakdownGeneration

        let range = selectedRange.epochMillisRange()
        breakdownState = .loading

        let result = await client.fetchUsageBreakdown(
            from: range.from, to: range.to, groupBy: dimension.rawValue
        )

        guard capturedGeneration == breakdownGeneration else { return }

        if let result {
            breakdownState = .loaded(result)
        } else {
            breakdownState = .failed("Failed to load usage breakdown")
        }
    }
}
