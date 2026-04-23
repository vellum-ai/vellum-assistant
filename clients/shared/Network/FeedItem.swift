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
    case telegram
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

// MARK: - FeedItemDetailPanel

/// Which detail panel the macOS client should open for this feed item.
public enum FeedItemDetailPanelKind: String, Codable, Sendable, Hashable {
    case emailDraft
    case documentPreview
    case permissionChat
    case paymentAuth
    case toolPermission
    case updatesList
    case scheduled
    case nudge
}

/// Server-driven detail panel descriptor attached to a feed item.
///
/// `data` is an untyped dictionary on the wire — kind-specific parsing
/// happens at the consumer via the per-kind data structs below.
public struct FeedItemDetailPanel: Codable, Sendable, Hashable {
    public let kind: FeedItemDetailPanelKind
    public let data: [String: AnyCodable]?

    public init(kind: FeedItemDetailPanelKind, data: [String: AnyCodable]? = nil) {
        self.kind = kind
        self.data = data
    }
}

// MARK: - Per-kind panel data structs

/// Data for the `emailDraft` detail panel kind.
public struct EmailDraftPanelData: Sendable, Hashable {
    public let to: String
    public let subject: String
    public let body: String

    public static func from(_ data: [String: AnyCodable]?) -> EmailDraftPanelData? {
        guard let data,
              let to = data["to"]?.value as? String,
              let subject = data["subject"]?.value as? String,
              let body = data["body"]?.value as? String else { return nil }
        return EmailDraftPanelData(to: to, subject: subject, body: body)
    }
}

/// Data for the `documentPreview` detail panel kind.
public struct DocumentPreviewPanelData: Sendable, Hashable {
    public let imageUrl: String?
    public let caption: String?

    public static func from(_ data: [String: AnyCodable]?) -> DocumentPreviewPanelData? {
        guard let data else { return nil }
        return DocumentPreviewPanelData(
            imageUrl: data["imageUrl"]?.value as? String,
            caption: data["caption"]?.value as? String
        )
    }
}

/// Data for the `permissionChat` detail panel kind.
public struct PermissionChatPanelData: Sendable, Hashable {
    public let userMessage: String
    public let assistantResponse: String
    public let requestId: String
    public let toolName: String
    public let commandPreview: String?
    public let riskLevel: String?

    public static func from(_ data: [String: AnyCodable]?) -> PermissionChatPanelData? {
        guard let data,
              let userMessage = data["userMessage"]?.value as? String,
              let assistantResponse = data["assistantResponse"]?.value as? String,
              let requestId = data["requestId"]?.value as? String,
              let toolName = data["toolName"]?.value as? String else { return nil }
        return PermissionChatPanelData(
            userMessage: userMessage,
            assistantResponse: assistantResponse,
            requestId: requestId,
            toolName: toolName,
            commandPreview: data["commandPreview"]?.value as? String,
            riskLevel: data["riskLevel"]?.value as? String
        )
    }
}

/// Data for the `paymentAuth` detail panel kind.
public struct PaymentAuthPanelData: Sendable, Hashable {
    public let imageUrl: String?
    public let caption: String?
    public let amount: String?
    public let recipient: String?

    public static func from(_ data: [String: AnyCodable]?) -> PaymentAuthPanelData? {
        guard let data else { return nil }
        return PaymentAuthPanelData(
            imageUrl: data["imageUrl"]?.value as? String,
            caption: data["caption"]?.value as? String,
            amount: data["amount"]?.value as? String,
            recipient: data["recipient"]?.value as? String
        )
    }
}

/// Data for the `toolPermission` detail panel kind.
public struct ToolPermissionPanelData: Sendable, Hashable {
    public let toolName: String
    public let commandPreview: String?
    public let riskLevel: String?
    public let decision: String?

    public static func from(_ data: [String: AnyCodable]?) -> ToolPermissionPanelData? {
        guard let data,
              let toolName = data["toolName"]?.value as? String else { return nil }
        return ToolPermissionPanelData(
            toolName: toolName,
            commandPreview: data["commandPreview"]?.value as? String,
            riskLevel: data["riskLevel"]?.value as? String,
            decision: data["decision"]?.value as? String
        )
    }
}

/// Data for the `updatesList` detail panel kind.
public struct UpdatesListPanelData: Sendable, Hashable {
    public struct Item: Sendable, Hashable {
        public let title: String
        public let description: String
    }

    public let items: [Item]

    public static func from(_ data: [String: AnyCodable]?) -> UpdatesListPanelData? {
        guard let data,
              let rawItems = data["items"]?.value as? [Any] else { return nil }
        var parsed: [Item] = []
        for rawItem in rawItems {
            guard let dict = rawItem as? [String: Any],
                  let title = dict["title"] as? String,
                  let description = dict["description"] as? String else { continue }
            parsed.append(Item(title: title, description: description))
        }
        return UpdatesListPanelData(items: parsed)
    }
}

/// Data for the `scheduled` detail panel kind.
public struct ScheduledPanelData: Sendable, Hashable {
    public let description: String?
    public let jobName: String
    public let syntax: String
    public let mode: String
    public let schedule: String?
    public let enabled: Bool
    public let nextRun: String?

    public static func from(_ data: [String: AnyCodable]?) -> ScheduledPanelData? {
        guard let data,
              let jobName = data["jobName"]?.value as? String,
              let syntax = data["syntax"]?.value as? String,
              let mode = data["mode"]?.value as? String,
              let enabled = data["enabled"]?.value as? Bool else { return nil }
        return ScheduledPanelData(
            description: data["description"]?.value as? String,
            jobName: jobName,
            syntax: syntax,
            mode: mode,
            schedule: data["schedule"]?.value as? String,
            enabled: enabled,
            nextRun: data["nextRun"]?.value as? String
        )
    }
}

/// Data for the `nudge` detail panel kind.
public struct NudgePanelData: Sendable, Hashable {
    public struct Card: Sendable, Hashable {
        public let id: String
        public let title: String
        public let description: String
    }

    public let description: String?
    public let cards: [Card]

    public static func from(_ data: [String: AnyCodable]?) -> NudgePanelData? {
        guard let data,
              let rawCards = data["cards"]?.value as? [Any] else { return nil }
        var parsed: [Card] = []
        for rawCard in rawCards {
            guard let dict = rawCard as? [String: Any],
                  let id = dict["id"] as? String,
                  let title = dict["title"] as? String,
                  let description = dict["description"] as? String else { continue }
            parsed.append(Card(id: id, title: title, description: description))
        }
        return NudgePanelData(
            description: data["description"]?.value as? String,
            cards: parsed
        )
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
    /// Optional conversation this feed item is associated with.
    public let conversationId: String?
    /// Server-driven detail panel descriptor; when present, the client opens this panel kind.
    public let detailPanel: FeedItemDetailPanel?
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
        conversationId: String? = nil,
        detailPanel: FeedItemDetailPanel? = nil,
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
        self.conversationId = conversationId
        self.detailPanel = detailPanel
        self.author = author
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
