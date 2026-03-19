import Foundation

/// A single memory item returned by the assistant's memory API.
public struct MemoryItemPayload: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let kind: String
    public let subject: String
    public let statement: String
    public let status: String
    public let confidence: Double
    public let importance: Double?
    public let accessCount: Int
    public let verificationState: String
    public let scopeId: String
    public let scopeLabel: String?
    public let firstSeenAt: Int      // epoch ms
    public let lastSeenAt: Int       // epoch ms
    public let lastUsedAt: Int?      // epoch ms
    public let supersedes: String?
    public let supersededBy: String?
    public let supersedesSubject: String?    // populated by GET detail
    public let supersededBySubject: String?  // populated by GET detail

    enum CodingKeys: String, CodingKey {
        case id, kind, subject, statement, status, confidence, importance
        case accessCount, verificationState, scopeId, scopeLabel
        case firstSeenAt, lastSeenAt, lastUsedAt
        case supersedes, supersededBy
        case supersedesSubject, supersededBySubject
    }

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
}
