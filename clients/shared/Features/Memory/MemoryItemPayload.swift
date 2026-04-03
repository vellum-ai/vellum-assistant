import Foundation

/// Emotional charge metadata for a graph memory node.
public struct EmotionalChargePayload: Codable, Hashable, Sendable {
    public let valence: Double?
    public let intensity: Double?
    public let decayCurve: String?
    public let decayRate: Double?
    public let originalIntensity: Double?
}

/// Bucketed importance level derived from the 0–1 importance score.
public enum ImportanceLevel: Int, Comparable {
    case low = 1
    case medium = 2
    case high = 3

    public static func < (lhs: ImportanceLevel, rhs: ImportanceLevel) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

/// A single memory item returned by the assistant's memory API.
public struct MemoryItemPayload: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let kind: String
    public let subject: String
    public let statement: String
    public let status: String
    public let confidence: Double?
    public let importance: Double?
    public let firstSeenAt: Int      // epoch ms
    public let lastSeenAt: Int       // epoch ms

    // Graph-specific fields
    public let fidelity: String?
    public let sourceType: String?
    public let narrativeRole: String?
    public let partOfStory: String?
    public let reinforcementCount: Int?
    public let stability: Double?
    public let emotionalCharge: EmotionalChargePayload?

    // Legacy fields — optional for backward compatibility
    public let accessCount: Int?
    public let verificationState: String?
    public let scopeId: String?
    public let scopeLabel: String?
    public let lastUsedAt: Int?      // epoch ms
    public let supersedes: String?
    public let supersededBy: String?
    public let supersedesSubject: String?
    public let supersededBySubject: String?

    // MARK: - Date Helpers

    /// Converts `firstSeenAt` (epoch milliseconds) to a `Date`.
    public var firstSeenDate: Date {
        Date(timeIntervalSince1970: Double(firstSeenAt) / 1000.0)
    }

    /// Converts `lastSeenAt` (epoch milliseconds) to a `Date`.
    public var lastSeenDate: Date {
        Date(timeIntervalSince1970: Double(lastSeenAt) / 1000.0)
    }

    /// Converts `lastUsedAt` (epoch milliseconds) to a `Date`, if present.
    public var lastUsedDate: Date? {
        guard let ms = lastUsedAt else { return nil }
        return Date(timeIntervalSince1970: Double(ms) / 1000.0)
    }

    /// Human-readable relative time for `lastSeenAt` (e.g. "2 hours ago").
    public var relativeLastSeen: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: lastSeenDate, relativeTo: Date())
    }

    /// Bucketed importance level for visual indicators (dots, bars).
    public var importanceLevel: ImportanceLevel {
        let value = importance ?? 0
        if value >= 0.66 { return .high }
        if value >= 0.33 { return .medium }
        return .low
    }

    /// Human-readable label for the source type, or nil if unknown.
    public var sourceLabel: String? {
        switch sourceType {
        case "direct": return "Told directly"
        case "observed": return "Observed"
        case "inferred": return "Inferred"
        case "told-by-other": return "Told by other"
        default: return nil
        }
    }

    // MARK: - Status Helpers

    /// Whether this memory has been superseded by another.
    public var isSuperseded: Bool {
        supersededBy != nil
    }

    /// Whether the user has explicitly confirmed this memory.
    public var isUserConfirmed: Bool {
        verificationState == "user_confirmed"
    }

    /// Whether this memory was extracted from a user message.
    public var isUserReported: Bool {
        verificationState == "user_reported"
    }
}

/// Response shape for the memory items list endpoint.
public struct MemoryItemsListResponse: Codable, Sendable {
    public let items: [MemoryItemPayload]
    public let total: Int
    /// Server-side count of items per kind (respects status/search filters but not the kind filter).
    public let kindCounts: [String: Int]?
}
