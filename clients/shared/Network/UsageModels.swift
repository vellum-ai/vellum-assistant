import Foundation

// MARK: - Usage Response Models

/// Aggregate totals for a time range from `GET /v1/usage/totals`.
public struct UsageTotalsResponse: Decodable, Equatable, Sendable {
    public let totalInputTokens: Int
    public let totalOutputTokens: Int
    public let totalCacheCreationTokens: Int
    public let totalCacheReadTokens: Int
    public let totalEstimatedCostUsd: Double
    public let eventCount: Int
    public let pricedEventCount: Int
    public let unpricedEventCount: Int

    public init(
        totalInputTokens: Int,
        totalOutputTokens: Int,
        totalCacheCreationTokens: Int,
        totalCacheReadTokens: Int,
        totalEstimatedCostUsd: Double,
        eventCount: Int,
        pricedEventCount: Int,
        unpricedEventCount: Int
    ) {
        self.totalInputTokens = totalInputTokens
        self.totalOutputTokens = totalOutputTokens
        self.totalCacheCreationTokens = totalCacheCreationTokens
        self.totalCacheReadTokens = totalCacheReadTokens
        self.totalEstimatedCostUsd = totalEstimatedCostUsd
        self.eventCount = eventCount
        self.pricedEventCount = pricedEventCount
        self.unpricedEventCount = unpricedEventCount
    }
}

/// A single day bucket from `GET /v1/usage/daily`.
public struct UsageDayBucket: Decodable, Equatable, Sendable, Identifiable {
    /// Stable unique identifier for use as a SwiftUI list key. Distinct across
    /// DST fall-back duplicate hours (which share the same `date` string).
    /// Older daemons don't send this field, so we fall back to `date` on decode
    /// — acceptable for daily buckets but hourly charts require a newer daemon
    /// to render correctly on fall-back days.
    public let bucketId: String
    /// Local-time bucket key in the requested tz: "YYYY-MM-DD" (daily) or
    /// "YYYY-MM-DD HH:00" (hourly). Not guaranteed unique — use `bucketId` for
    /// list identity and `displayLabel` for rendering.
    public let date: String
    /// Pre-formatted human-readable label from the daemon, formatted in the
    /// requested timezone. Absent for responses from older daemons.
    public let displayLabel: String?
    public let totalInputTokens: Int
    public let totalOutputTokens: Int
    public let totalEstimatedCostUsd: Double
    public let eventCount: Int

    public var id: String { bucketId }

    public init(
        bucketId: String? = nil,
        date: String,
        displayLabel: String? = nil,
        totalInputTokens: Int,
        totalOutputTokens: Int,
        totalEstimatedCostUsd: Double,
        eventCount: Int
    ) {
        self.bucketId = bucketId ?? date
        self.date = date
        self.displayLabel = displayLabel
        self.totalInputTokens = totalInputTokens
        self.totalOutputTokens = totalOutputTokens
        self.totalEstimatedCostUsd = totalEstimatedCostUsd
        self.eventCount = eventCount
    }

    private enum CodingKeys: String, CodingKey {
        case bucketId
        case date
        case displayLabel
        case totalInputTokens
        case totalOutputTokens
        case totalEstimatedCostUsd
        case eventCount
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        date = try container.decode(String.self, forKey: .date)
        bucketId = try container.decodeIfPresent(String.self, forKey: .bucketId) ?? date
        displayLabel = try container.decodeIfPresent(String.self, forKey: .displayLabel)
        totalInputTokens = try container.decode(Int.self, forKey: .totalInputTokens)
        totalOutputTokens = try container.decode(Int.self, forKey: .totalOutputTokens)
        totalEstimatedCostUsd = try container.decode(Double.self, forKey: .totalEstimatedCostUsd)
        eventCount = try container.decode(Int.self, forKey: .eventCount)
    }
}

/// Response wrapper for `GET /v1/usage/daily`.
public struct UsageDailyResponse: Decodable, Equatable, Sendable {
    public let buckets: [UsageDayBucket]

    public init(buckets: [UsageDayBucket]) {
        self.buckets = buckets
    }
}

/// A single grouped breakdown row from `GET /v1/usage/breakdown`.
public struct UsageGroupBreakdownEntry: Decodable, Equatable, Sendable {
    public let group: String
    public let groupId: String?
    public let groupKey: String?
    public let totalInputTokens: Int
    public let totalOutputTokens: Int
    public let totalCacheCreationTokens: Int
    public let totalCacheReadTokens: Int
    public let totalEstimatedCostUsd: Double
    public let eventCount: Int

    public init(
        group: String,
        groupId: String? = nil,
        groupKey: String? = nil,
        totalInputTokens: Int,
        totalOutputTokens: Int,
        totalCacheCreationTokens: Int = 0,
        totalCacheReadTokens: Int = 0,
        totalEstimatedCostUsd: Double,
        eventCount: Int
    ) {
        self.group = group
        self.groupId = groupId
        self.groupKey = groupKey
        self.totalInputTokens = totalInputTokens
        self.totalOutputTokens = totalOutputTokens
        self.totalCacheCreationTokens = totalCacheCreationTokens
        self.totalCacheReadTokens = totalCacheReadTokens
        self.totalEstimatedCostUsd = totalEstimatedCostUsd
        self.eventCount = eventCount
    }

    private enum CodingKeys: String, CodingKey {
        case group
        case groupId
        case groupKey
        case totalInputTokens
        case totalOutputTokens
        case totalCacheCreationTokens
        case totalCacheReadTokens
        case totalEstimatedCostUsd
        case eventCount
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        group = try container.decode(String.self, forKey: .group)
        groupId = try container.decodeIfPresent(String.self, forKey: .groupId)
        groupKey = try container.decodeIfPresent(String.self, forKey: .groupKey)
        totalInputTokens = try container.decode(Int.self, forKey: .totalInputTokens)
        totalOutputTokens = try container.decode(Int.self, forKey: .totalOutputTokens)
        totalCacheCreationTokens = try container.decodeIfPresent(Int.self, forKey: .totalCacheCreationTokens) ?? 0
        totalCacheReadTokens = try container.decodeIfPresent(Int.self, forKey: .totalCacheReadTokens) ?? 0
        totalEstimatedCostUsd = try container.decode(Double.self, forKey: .totalEstimatedCostUsd)
        eventCount = try container.decode(Int.self, forKey: .eventCount)
    }
}

/// Response wrapper for `GET /v1/usage/breakdown`.
public struct UsageBreakdownResponse: Decodable, Equatable, Sendable {
    public let breakdown: [UsageGroupBreakdownEntry]

    public init(breakdown: [UsageGroupBreakdownEntry]) {
        self.breakdown = breakdown
    }
}

/// A single grouped value inside a usage series bucket from `GET /v1/usage/series`.
public struct UsageSeriesGroupValue: Decodable, Equatable, Sendable {
    public let group: String
    public let groupKey: String?
    public let totalInputTokens: Int
    public let totalOutputTokens: Int
    public let totalEstimatedCostUsd: Double
    public let eventCount: Int

    public init(
        group: String,
        groupKey: String? = nil,
        totalInputTokens: Int,
        totalOutputTokens: Int,
        totalEstimatedCostUsd: Double,
        eventCount: Int
    ) {
        self.group = group
        self.groupKey = groupKey
        self.totalInputTokens = totalInputTokens
        self.totalOutputTokens = totalOutputTokens
        self.totalEstimatedCostUsd = totalEstimatedCostUsd
        self.eventCount = eventCount
    }
}

/// A grouped time-series bucket from `GET /v1/usage/series`.
public struct UsageSeriesBucket: Decodable, Equatable, Sendable, Identifiable {
    public let bucketId: String
    public let date: String
    public let displayLabel: String?
    public let totalInputTokens: Int
    public let totalOutputTokens: Int
    public let totalEstimatedCostUsd: Double
    public let eventCount: Int
    public let groups: [String: UsageSeriesGroupValue]

    public var id: String { bucketId }

    public init(
        bucketId: String? = nil,
        date: String,
        displayLabel: String? = nil,
        totalInputTokens: Int,
        totalOutputTokens: Int,
        totalEstimatedCostUsd: Double,
        eventCount: Int,
        groups: [String: UsageSeriesGroupValue] = [:]
    ) {
        self.bucketId = bucketId ?? date
        self.date = date
        self.displayLabel = displayLabel
        self.totalInputTokens = totalInputTokens
        self.totalOutputTokens = totalOutputTokens
        self.totalEstimatedCostUsd = totalEstimatedCostUsd
        self.eventCount = eventCount
        self.groups = groups
    }

    private enum CodingKeys: String, CodingKey {
        case bucketId
        case date
        case displayLabel
        case totalInputTokens
        case totalOutputTokens
        case totalEstimatedCostUsd
        case eventCount
        case groups
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        date = try container.decode(String.self, forKey: .date)
        bucketId = try container.decodeIfPresent(String.self, forKey: .bucketId) ?? date
        displayLabel = try container.decodeIfPresent(String.self, forKey: .displayLabel)
        totalInputTokens = try container.decode(Int.self, forKey: .totalInputTokens)
        totalOutputTokens = try container.decode(Int.self, forKey: .totalOutputTokens)
        totalEstimatedCostUsd = try container.decode(Double.self, forKey: .totalEstimatedCostUsd)
        eventCount = try container.decode(Int.self, forKey: .eventCount)
        groups = try container.decodeIfPresent([String: UsageSeriesGroupValue].self, forKey: .groups) ?? [:]
    }
}

/// Response wrapper for `GET /v1/usage/series`.
public struct UsageSeriesResponse: Decodable, Equatable, Sendable {
    public let buckets: [UsageSeriesBucket]

    public init(buckets: [UsageSeriesBucket]) {
        self.buckets = buckets
    }
}
