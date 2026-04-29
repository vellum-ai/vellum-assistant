import Foundation

/// Home activity feed data contract.
///
/// Wire-compatible Swift mirror of
/// `assistant/src/home/feed-types.ts`. The TypeScript types are the
/// source of truth — any change there must be mirrored here so a JSON
/// blob produced by the daemon decodes byte-for-byte on the macOS side.
///
/// **v2 schema collapse** — feed items now have a single `notification`
/// type. The legacy `nudge | digest | action | thread` distinctions
/// (and the `source` / `author` / `minTimeAway` fields that supported
/// them) have been removed; everything that lands in the home feed is
/// a notification, with the writer's only merge rule being "same `id`
/// replaces in place, otherwise append". Workspace migration
/// `061-home-feed-notification-only` rewrites pre-v2 files on first
/// boot.
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
///
/// Collapsed to a single `notification` case in v2. Kept as an enum
/// (rather than removed entirely) so the JSON `"type": "notification"`
/// field continues to decode and to leave room for future types
/// without another wire-format change.
public enum FeedItemType: String, Codable, Sendable, Hashable {
    case notification
}

/// User-facing lifecycle of a feed item.
public enum FeedItemStatus: String, Codable, Sendable, Hashable {
    case new
    case seen
    case actedOn = "acted_on"
    case dismissed
}

/// Visual urgency treatment — controls badge color independently of sort priority.
public enum FeedItemUrgency: String, Codable, Sendable, Hashable {
    case low
    case medium
    case high
    case critical
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

// MARK: - FeedItemDetailPanel

/// Which detail panel the macOS client should open for this feed item.
public enum FeedItemDetailPanelKind: String, Codable, Sendable, Hashable {
    case emailDraft
    case documentPreview
    case permissionChat
    case paymentAuth
    case toolPermission
    case updatesList
}

/// Server-driven detail panel descriptor attached to a feed item.
public struct FeedItemDetailPanel: Codable, Sendable, Hashable {
    public let kind: FeedItemDetailPanelKind
    public init(kind: FeedItemDetailPanelKind) { self.kind = kind }
}

// MARK: - FeedItem

/// A single item rendered in the Home feed (schema **v2**).
///
/// Mirrors the TDD contract plus one internal-only field:
///   - `createdAt` — when the writer recorded the item (distinct from
///                   `timestamp`, which is the event time). Used for
///                   TTL sweeps and stable ordering.
///
/// In v2 every feed item is a `.notification` — the legacy
/// `source` / `author` / `minTimeAway` discriminators were removed when
/// the type collapsed. See the module comment above for rationale.
public struct FeedItem: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let type: FeedItemType
    /// Integer in [0, 100]; higher values sort earlier.
    public let priority: Int
    public let title: String
    public let summary: String
    /// Event time.
    public let timestamp: Date
    public let status: FeedItemStatus
    /// Absolute expiry timestamp (renamed from TDD `ttl`).
    public let expiresAt: Date?
    public let actions: [FeedAction]?
    /// Visual urgency treatment — controls badge color independently of sort priority.
    public let urgency: FeedItemUrgency?
    /// Optional conversation this feed item is associated with.
    public let conversationId: String?
    /// Server-driven detail panel descriptor; when present, the client opens this panel kind.
    public let detailPanel: FeedItemDetailPanel?
    /// Internal: writer-record time, used for ordering + TTL.
    public let createdAt: Date

    public init(
        id: String,
        type: FeedItemType,
        priority: Int,
        title: String,
        summary: String,
        timestamp: Date,
        status: FeedItemStatus,
        expiresAt: Date? = nil,
        actions: [FeedAction]? = nil,
        urgency: FeedItemUrgency? = nil,
        conversationId: String? = nil,
        detailPanel: FeedItemDetailPanel? = nil,
        createdAt: Date
    ) {
        self.id = id
        self.type = type
        self.priority = priority
        self.title = title
        self.summary = summary
        self.timestamp = timestamp
        self.status = status
        self.expiresAt = expiresAt
        self.actions = actions
        self.urgency = urgency
        self.conversationId = conversationId
        self.detailPanel = detailPanel
        self.createdAt = createdAt
    }
}

// MARK: - SuggestedPrompt

/// Origin of a suggested prompt — whether it was deterministically derived
/// (e.g. from a missing OAuth connection) or generated by the assistant.
public enum SuggestedPromptSource: String, Codable, Sendable, Hashable {
    case deterministic
    case assistant
}

/// A prompt suggestion shown at the top of the Home page.
///
/// Deterministic prompts are derived from workspace state (e.g. missing
/// OAuth connections). Assistant-generated prompts are contextual
/// conversation starters produced by the LLM.
public struct SuggestedPrompt: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let label: String
    public let icon: String?
    public let prompt: String
    public let source: SuggestedPromptSource

    public init(
        id: String,
        label: String,
        icon: String? = nil,
        prompt: String,
        source: SuggestedPromptSource
    ) {
        self.id = id
        self.label = label
        self.icon = icon
        self.prompt = prompt
        self.source = source
    }
}

// MARK: - LowPriorityCollapsed

/// Summary of low-priority items that were collapsed out of the main
/// feed list. The client renders this as a single "N low priority
/// updates" line instead of showing each item individually.
public struct LowPriorityCollapsed: Codable, Sendable, Hashable {
    public let count: Int
    public let itemIds: [String]

    public init(count: Int, itemIds: [String]) {
        self.count = count
        self.itemIds = itemIds
    }
}

// MARK: - HomeFeedFile

/// On-disk file format for `~/.vellum/workspace/data/home-feed.json`.
///
/// Written by the daemon feed writer, read by the daemon HTTP route
/// and the macOS `HomeFeedStore`. `version` is currently `2` (the
/// collapsed-schema format); pre-v2 files are rewritten by workspace
/// migration `061-home-feed-notification-only`. The Swift type keeps
/// `version` as `Int` (rather than a literal) for forward-compatibility —
/// the client tolerates higher version numbers and lets the daemon
/// gate which format it actually serves.
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
