import Foundation

// MARK: - Feed Item Type

/// The category of a feed item.
public enum FeedItemType: String, Codable, Sendable {
    case nudge
    case digest
    case action
    case thread
}

// MARK: - Feed Item Status

/// Lifecycle status of a feed item.
public enum FeedItemStatus: String, Codable, Sendable {
    case new
    case seen
    case actedOn = "acted_on"
}

// MARK: - Feed Action

/// An actionable button presented on a feed item.
public struct FeedAction: Codable, Identifiable, Sendable {
    public let id: String
    public let label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

// MARK: - Feed Item

/// A single entry in the Home feed.
public struct FeedItem: Codable, Identifiable, Sendable {
    public let id: String
    public let type: FeedItemType
    public let priority: Int
    public let title: String
    public let summary: String
    public let source: String?
    public let timestamp: Date
    public let status: FeedItemStatus
    public let ttl: Date?
    public let minTimeAway: TimeInterval?
    public let actions: [FeedAction]?

    public init(
        id: String,
        type: FeedItemType,
        priority: Int,
        title: String,
        summary: String,
        source: String? = nil,
        timestamp: Date,
        status: FeedItemStatus,
        ttl: Date? = nil,
        minTimeAway: TimeInterval? = nil,
        actions: [FeedAction]? = nil
    ) {
        self.id = id
        self.type = type
        self.priority = priority
        self.title = title
        self.summary = summary
        self.source = source
        self.timestamp = timestamp
        self.status = status
        self.ttl = ttl
        self.minTimeAway = minTimeAway
        self.actions = actions
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case type
        case priority
        case title
        case summary
        case source
        case timestamp
        case status
        case ttl
        case minTimeAway = "min_time_away"
        case actions
    }
}
