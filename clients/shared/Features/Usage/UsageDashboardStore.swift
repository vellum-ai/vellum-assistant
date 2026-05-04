import Foundation

// MARK: - Usage Client Protocol

/// Abstraction for fetching usage data, decoupled from the full GatewayConnectionManager.
public protocol UsageClientProtocol {
    func fetchUsageTotals(from: Int, to: Int) async -> UsageTotalsResponse?
    func fetchUsageDaily(from: Int, to: Int, granularity: String, tz: String) async -> UsageDailyResponse?
    func fetchUsageSeries(from: Int, to: Int, granularity: String, groupBy: String, tz: String) async -> UsageSeriesResponse?
    func fetchUsageBreakdown(from: Int, to: Int, groupBy: String) async -> UsageFetchResult<UsageBreakdownResponse>
}

public struct UsageFetchResult<Value: Sendable>: Sendable {
    public let value: Value?
    public let statusCode: Int?

    public init(value: Value?, statusCode: Int?) {
        self.value = value
        self.statusCode = statusCode
    }

    public static func success(_ value: Value) -> Self {
        Self(value: value, statusCode: 200)
    }

    public static func failure(statusCode: Int? = nil) -> Self {
        Self(value: nil, statusCode: statusCode)
    }
}

/// Fetches usage data via GatewayHTTPClient.
public struct UsageClient: UsageClientProtocol {
    /// A restricted character set for encoding query parameter values.
    /// `.urlQueryAllowed` permits `&`, `=`, `+`, and `#` which are
    /// query-string metacharacters that would break parameter parsing.
    private static let queryValueAllowed: CharacterSet = {
        var cs = CharacterSet.urlQueryAllowed
        cs.remove(charactersIn: "&=+#")
        return cs
    }()

    public init() {}

    public func fetchUsageTotals(from: Int, to: Int) async -> UsageTotalsResponse? {
        let result: (UsageTotalsResponse?, GatewayHTTPClient.Response)? = try? await GatewayHTTPClient.get(
            path: "usage/totals?from=\(from)&to=\(to)", timeout: 10
        )
        return result?.0
    }

    public func fetchUsageDaily(from: Int, to: Int, granularity: String = "daily", tz: String) async -> UsageDailyResponse? {
        let encodedTz = tz.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? tz
        let result: (UsageDailyResponse?, GatewayHTTPClient.Response)? = try? await GatewayHTTPClient.get(
            path: "usage/daily?from=\(from)&to=\(to)&granularity=\(granularity)&tz=\(encodedTz)", timeout: 10
        )
        return result?.0
    }

    public func fetchUsageSeries(from: Int, to: Int, granularity: String = "daily", groupBy: String, tz: String) async -> UsageSeriesResponse? {
        let encodedGroupBy = groupBy.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? groupBy
        let encodedTz = tz.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? tz
        let result: (UsageSeriesResponse?, GatewayHTTPClient.Response)? = try? await GatewayHTTPClient.get(
            path: "usage/series?from=\(from)&to=\(to)&granularity=\(granularity)&groupBy=\(encodedGroupBy)&tz=\(encodedTz)", timeout: 10
        )
        return result?.0
    }

    public func fetchUsageBreakdown(from: Int, to: Int, groupBy: String) async -> UsageFetchResult<UsageBreakdownResponse> {
        let encoded = groupBy.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? groupBy
        do {
            let result: (UsageBreakdownResponse?, GatewayHTTPClient.Response) = try await GatewayHTTPClient.get(
                path: "usage/breakdown?from=\(from)&to=\(to)&groupBy=\(encoded)", timeout: 10
            )
            return UsageFetchResult(value: result.0, statusCode: result.1.statusCode)
        } catch {
            return .failure()
        }
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
    /// `to` is always the current instant; `from` is midnight in `timeZone` of
    /// the starting day. The timezone parameter controls where the range
    /// anchors — e.g. "Today" means midnight in the user's local timezone, not
    /// midnight UTC.
    public func epochMillisRange(
        now: Date = Date(),
        timeZone: TimeZone = .current
    ) -> (from: Int, to: Int) {
        let to = Int(now.timeIntervalSince1970 * 1000)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
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
    case callSite = "call_site"
    case inferenceProfile = "inference_profile"
    case actor
    case provider
    case model
    case conversation

    public static let dashboardOptions: [UsageGroupByDimension] = [
        .callSite,
        .inferenceProfile,
        .model,
        .provider,
        .conversation,
    ]

    public var displayName: String {
        switch self {
        case .callSite: return "Action"
        case .inferenceProfile: return "Profile"
        case .actor: return "Actor (Legacy)"
        case .provider: return "Provider"
        case .model: return "Model"
        case .conversation: return "Conversation"
        }
    }
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
    public var seriesState: UsageLoadingState<UsageSeriesResponse> = .idle
    public var breakdownState: UsageLoadingState<UsageBreakdownResponse> = .idle
    public var selectedGroupBy: UsageGroupByDimension = .callSite

    /// Whether the current daily data uses hourly granularity (true when range is "Today").
    public var isHourlyGranularity: Bool { selectedRange == .today }

    /// IANA identifier of the timezone used for bucket boundaries and labels.
    /// Defaults to the system timezone; callers override via `updateTimezone`
    /// when the user sets an explicit `ui.userTimezone`.
    public private(set) var resolvedTimezoneIdentifier: String = TimeZone.current.identifier

    /// The resolved `TimeZone` that matches `resolvedTimezoneIdentifier`.
    public var resolvedTimezone: TimeZone {
        TimeZone(identifier: resolvedTimezoneIdentifier) ?? .current
    }

    // MARK: - Dependencies

    private var client: any UsageClientProtocol = UsageClient()

    /// Generation counters to discard results from stale in-flight requests
    /// when the user changes filters faster than fetches complete.
    private var refreshGeneration: UInt = 0
    private var breakdownGeneration: UInt = 0

    public init() {}

    private func shouldFallbackToModelBreakdown(
        requested groupBy: UsageGroupByDimension,
        result: UsageFetchResult<UsageBreakdownResponse>
    ) -> Bool {
        guard result.value == nil else { return false }
        guard groupBy == .callSite || groupBy == .inferenceProfile else { return false }
        return result.statusCode == 400 || result.statusCode == 404 || result.statusCode == 422
    }

    /// Replace the underlying client and reset all loaded data.
    public func updateClient(_ newClient: any UsageClientProtocol) {
        client = newClient
        reset()
    }

    /// Update the effective timezone used for range calculation and bucket
    /// labels. If `identifier` is nil or unrecognized, falls back to
    /// `TimeZone.current`. Resets any loaded data so the next refresh
    /// re-fetches with the new timezone.
    public func updateTimezone(_ identifier: String?) {
        let resolved = identifier.flatMap { TimeZone(identifier: $0) } ?? .current
        if resolved.identifier != resolvedTimezoneIdentifier {
            resolvedTimezoneIdentifier = resolved.identifier
            reset()
        }
    }

    /// Reset all loaded data so the next `refresh()` re-fetches.
    public func reset() {
        refreshGeneration &+= 1
        breakdownGeneration &+= 1
        totalsState = .idle
        dailyState = .idle
        seriesState = .idle
        breakdownState = .idle
    }

    /// Whether any section needs a (re)fetch — used by views to auto-refresh
    /// on first appearance or after a partial/total failure.
    public var needsRefresh: Bool {
        totalsState == .idle || totalsState.isFailed ||
        seriesState == .idle || seriesState.isFailed ||
        breakdownState == .idle || breakdownState.isFailed
    }

    // MARK: - Refresh

    /// Load all usage data (totals, daily, breakdown) for the currently selected range.
    public func refresh() async {
        refreshGeneration &+= 1
        let capturedRefreshGen = refreshGeneration
        breakdownGeneration &+= 1
        let capturedBreakdownGen = breakdownGeneration

        let tz = resolvedTimezone
        let tzIdentifier = resolvedTimezoneIdentifier
        let range = selectedRange.epochMillisRange(timeZone: tz)

        totalsState = .loading
        dailyState = .loading
        seriesState = .loading
        breakdownState = .loading

        let granularity = isHourlyGranularity ? "hourly" : "daily"
        let groupBy = selectedGroupBy
        async let totalsResult = client.fetchUsageTotals(from: range.from, to: range.to)
        async let dailyResult = client.fetchUsageDaily(
            from: range.from, to: range.to, granularity: granularity, tz: tzIdentifier
        )
        async let seriesResult = client.fetchUsageSeries(
            from: range.from, to: range.to, granularity: granularity, groupBy: groupBy.rawValue, tz: tzIdentifier
        )
        async let breakdownResult = client.fetchUsageBreakdown(
            from: range.from, to: range.to, groupBy: groupBy.rawValue
        )

        let totals = await totalsResult
        let daily = await dailyResult
        var series = await seriesResult
        let breakdownResultValue = await breakdownResult
        var breakdown = breakdownResultValue.value
        var effectiveGroupBy = groupBy

        if shouldFallbackToModelBreakdown(requested: groupBy, result: breakdownResultValue) {
            effectiveGroupBy = .model
            async let modelSeriesResult = client.fetchUsageSeries(
                from: range.from,
                to: range.to,
                granularity: granularity,
                groupBy: UsageGroupByDimension.model.rawValue,
                tz: tzIdentifier
            )
            async let modelBreakdownResult = client.fetchUsageBreakdown(
                from: range.from, to: range.to, groupBy: UsageGroupByDimension.model.rawValue
            )
            series = await modelSeriesResult
            let modelBreakdown = await modelBreakdownResult
            breakdown = modelBreakdown.value
        }

        if series == nil, let daily {
            series = UsageSeriesResponse(daily: daily)
        }

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
            if effectiveGroupBy != groupBy && selectedGroupBy == groupBy {
                selectedGroupBy = effectiveGroupBy
            }

            if let series {
                seriesState = .loaded(series)
            } else {
                seriesState = .failed("Failed to load usage series")
            }

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

        let range = selectedRange.epochMillisRange(timeZone: resolvedTimezone)
        let granularity = isHourlyGranularity ? "hourly" : "daily"
        breakdownState = .loading
        seriesState = .loading

        async let seriesResult = client.fetchUsageSeries(
            from: range.from,
            to: range.to,
            granularity: granularity,
            groupBy: dimension.rawValue,
            tz: resolvedTimezoneIdentifier
        )
        async let breakdownResult = client.fetchUsageBreakdown(
            from: range.from, to: range.to, groupBy: dimension.rawValue
        )

        var series = await seriesResult
        let breakdown = await breakdownResult
        var result = breakdown.value
        var effectiveDimension = dimension

        if shouldFallbackToModelBreakdown(requested: dimension, result: breakdown) {
            effectiveDimension = .model
            async let modelSeriesResult = client.fetchUsageSeries(
                from: range.from,
                to: range.to,
                granularity: granularity,
                groupBy: UsageGroupByDimension.model.rawValue,
                tz: resolvedTimezoneIdentifier
            )
            async let modelBreakdownResult = client.fetchUsageBreakdown(
                from: range.from, to: range.to, groupBy: UsageGroupByDimension.model.rawValue
            )
            series = await modelSeriesResult
            let modelBreakdown = await modelBreakdownResult
            result = modelBreakdown.value
        }

        if series == nil, case .loaded(let daily) = dailyState {
            series = UsageSeriesResponse(daily: daily)
        }

        guard capturedGeneration == breakdownGeneration else { return }

        if effectiveDimension != dimension && selectedGroupBy == dimension {
            selectedGroupBy = effectiveDimension
        }

        if let series {
            seriesState = .loaded(series)
        } else {
            seriesState = .failed("Failed to load usage series")
        }

        if let result {
            breakdownState = .loaded(result)
        } else {
            breakdownState = .failed("Failed to load usage breakdown")
        }
    }
}

private extension UsageSeriesResponse {
    init(daily: UsageDailyResponse) {
        self.init(
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
}
