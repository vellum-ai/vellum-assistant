import Foundation

/// A single observation from the simplified memory system.
public struct MemoryObservationPayload: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let scopeId: String
    public let conversationId: String
    public let conversationTitle: String?
    public let role: String
    public let content: String
    public let modality: String
    public let source: String?
    public let createdAt: Int  // epoch ms

    public var createdDate: Date {
        Date(timeIntervalSince1970: Double(createdAt) / 1000.0)
    }

    public var relativeCreatedAt: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: createdDate, relativeTo: Date())
    }
}

/// A narrative episode summary from the simplified memory system.
public struct MemoryEpisodePayload: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let scopeId: String
    public let conversationId: String
    public let conversationTitle: String?
    public let title: String
    public let summary: String
    public let source: String?
    public let startAt: Int   // epoch ms
    public let endAt: Int     // epoch ms
    public let createdAt: Int // epoch ms

    public var startDate: Date {
        Date(timeIntervalSince1970: Double(startAt) / 1000.0)
    }
    public var endDate: Date {
        Date(timeIntervalSince1970: Double(endAt) / 1000.0)
    }
    public var createdDate: Date {
        Date(timeIntervalSince1970: Double(createdAt) / 1000.0)
    }
}

/// A bounded time context from the assistant's brief.
public struct MemoryTimeContextPayload: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let summary: String
    public let source: String
    public let activeFrom: Int
    public let activeUntil: Int
    public let createdAt: Int

    public var activeFromDate: Date {
        Date(timeIntervalSince1970: Double(activeFrom) / 1000.0)
    }
    public var activeUntilDate: Date {
        Date(timeIntervalSince1970: Double(activeUntil) / 1000.0)
    }
}

/// An unresolved open loop tracked by the assistant.
public struct MemoryOpenLoopPayload: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let summary: String
    public let status: String
    public let source: String
    public let dueAt: Int?
    public let createdAt: Int

    public var dueDate: Date? {
        guard let ms = dueAt else { return nil }
        return Date(timeIntervalSince1970: Double(ms) / 1000.0)
    }
}

/// Response shape for GET /v1/memories.
public struct MemoriesListResponse: Codable, Sendable {
    public let observations: PaginatedSection<MemoryObservationPayload>
    public let episodes: PaginatedSection<MemoryEpisodePayload>
    public let timeContexts: PaginatedSection<MemoryTimeContextPayload>
    public let openLoops: PaginatedSection<MemoryOpenLoopPayload>
}

/// A paginated section with items and total count.
public struct PaginatedSection<T: Codable & Sendable>: Codable, Sendable {
    public let items: [T]
    public let total: Int
}
