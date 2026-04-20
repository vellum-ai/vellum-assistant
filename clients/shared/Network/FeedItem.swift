import Foundation

/// Home activity feed data contract.
///
/// Wire-compatible Swift mirror of
/// `assistant/src/home/feed-types.ts`. The TypeScript types are the
/// source of truth — any change there must be mirrored here so a JSON
/// blob produced by the daemon decodes byte-for-byte on the macOS side.
///
/// The TDD contract field originally named `ttl` is renamed internally
/// to `expiresAt` on both sides — it is an absolute ISO-8601 timestamp,
/// not a duration. See the TypeScript module comment for rationale.
///
/// These are pure value types — `Date` fields are decoded via
/// `JSONDecoder.dateDecodingStrategy = .iso8601` at the call site, not
/// inside the type definitions.

// MARK: - Enums

/// High-level kind of feed item — drives which Swift view renders it.
public enum FeedItemType: String, Codable, Sendable, Hashable {
    case nudge
    case digest
    case action
    case thread
}

/// User-facing lifecycle of a feed item.
public enum FeedItemStatus: String, Codable, Sendable, Hashable {
    case new
    case seen
    case actedOn = "acted_on"
    case dismissed
}

/// Origin of the underlying event.
///
/// In v1 this is constrained to a closed set so the Swift icon mapping
/// stays exhaustive. Future sources will be added explicitly rather
/// than letting arbitrary strings slip through.
public enum FeedItemSource: String, Codable, Sendable, Hashable {
    case gmail
    case slack
    case calendar
    case assistant
}

/// Visual urgency treatment — controls badge color independently of sort priority.
public enum FeedItemUrgency: String, Codable, Sendable, Hashable {
    case low
    case medium
    case high
    case critical
}

/// Internal field used by the hybrid authoring resolver.
///
/// Distinguishes items the assistant produced on its own from items
/// the platform baseline generators produced, so assistant overrides
/// can win over platform defaults for the same source.
public enum FeedItemAuthor: String, Codable, Sendable, Hashable {
    case assistant
    case platform
}

// MARK: - FeedAction

/// A single action button attached to a feed item.
///
/// `prompt` is the pre-seeded user message the action sends to the
/// assistant when triggered — the daemon's feed HTTP route creates a
/// new conversation with this prompt as the first user turn.
public struct FeedAction: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let label: String
    public let prompt: String

    public init(id: String, label: String, prompt: String) {
        self.id = id
        self.label = label
        self.prompt = prompt
    }
}

// MARK: - FeedItem

/// A single item rendered in the Home feed.
///
/// Mirrors the TDD contract plus two internal-only fields:
///   - `author`    — hybrid-authoring resolver discriminator
///   - `createdAt` — when the writer recorded the item (distinct from
///                   `timestamp`, which is the event time). Used for
///                   TTL sweeps and stable ordering.
public struct FeedItem: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let type: FeedItemType
    /// Integer in [0, 100]; higher values sort earlier.
    public let priority: Int
    public let title: String
    public let summary: String
    /// Optional; when present must be one of the four v1 sources.
    public let source: FeedItemSource?
    /// Event time.
    public let timestamp: Date
    public let status: FeedItemStatus
    /// Absolute expiry timestamp (renamed from TDD `ttl`).
    public let expiresAt: Date?
    /// Minimum seconds the user must be away before the item is shown.
    public let minTimeAway: TimeInterval?
    public let actions: [FeedAction]?
    /// Visual urgency treatment — controls badge color independently of sort priority.
    public let urgency: FeedItemUrgency?
    /// Internal: who authored this item.
    public let author: FeedItemAuthor
    /// Internal: writer-record time, used for ordering + TTL.
    public let createdAt: Date

    public init(
        id: String,
        type: FeedItemType,
        priority: Int,
        title: String,
        summary: String,
        source: FeedItemSource? = nil,
        timestamp: Date,
        status: FeedItemStatus,
        expiresAt: Date? = nil,
        minTimeAway: TimeInterval? = nil,
        actions: [FeedAction]? = nil,
        urgency: FeedItemUrgency? = nil,
        author: FeedItemAuthor,
        createdAt: Date
    ) {
        self.id = id
        self.type = type
        self.priority = priority
        self.title = title
        self.summary = summary
        self.source = source
        self.timestamp = timestamp
        self.status = status
        self.expiresAt = expiresAt
        self.minTimeAway = minTimeAway
        self.actions = actions
        self.urgency = urgency
        self.author = author
        self.createdAt = createdAt
    }
}

// MARK: - HomeFeedFile

/// On-disk file format for `~/.vellum/workspace/data/home-feed.json`.
///
/// Written by the daemon feed writer, read by the daemon HTTP route
/// and the macOS `HomeFeedStore` (lands in a later PR). `version` is
/// pinned to `1`; future format changes bump this and live behind a
/// workspace migration.
public struct HomeFeedFile: Codable, Sendable, Hashable {
    public let version: Int
    public let items: [FeedItem]
    public let updatedAt: Date

    public init(version: Int, items: [FeedItem], updatedAt: Date) {
        self.version = version
        self.items = items
        self.updatedAt = updatedAt
    }
}
