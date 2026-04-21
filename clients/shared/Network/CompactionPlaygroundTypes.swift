import Foundation

// MARK: - Compaction Playground Wire Types
//
// Codable types mirroring the daemon's compaction-playground HTTP surface.
// Keys are lowerCamelCase to match the daemon JSON convention — do not add a
// key-decoding strategy; the wire contract already matches Swift property names.

/// Response from `POST /v1/assistants/{id}/conversations/{id}/playground/compact`.
public struct CompactionForceResponse: Codable, Sendable {
    public let compacted: Bool
    public let previousTokens: Int
    public let newTokens: Int
    public let summaryText: String?
    public let messagesRemoved: Int
    public let summaryFailed: Bool?

    public init(
        compacted: Bool,
        previousTokens: Int,
        newTokens: Int,
        summaryText: String?,
        messagesRemoved: Int,
        summaryFailed: Bool?
    ) {
        self.compacted = compacted
        self.previousTokens = previousTokens
        self.newTokens = newTokens
        self.summaryText = summaryText
        self.messagesRemoved = messagesRemoved
        self.summaryFailed = summaryFailed
    }
}

/// Request body for `POST /v1/assistants/{id}/playground/seed-conversation`.
public struct SeedConversationRequest: Codable, Sendable {
    public let turns: Int
    public let avgTokensPerTurn: Int?
    public let title: String?

    public init(turns: Int, avgTokensPerTurn: Int? = nil, title: String? = nil) {
        self.turns = turns
        self.avgTokensPerTurn = avgTokensPerTurn
        self.title = title
    }
}

/// Response from `POST /v1/assistants/{id}/playground/seed-conversation`.
public struct SeedConversationResponse: Codable, Sendable {
    public let conversationId: String
    public let messagesInserted: Int
    public let estimatedTokens: Int

    public init(conversationId: String, messagesInserted: Int, estimatedTokens: Int) {
        self.conversationId = conversationId
        self.messagesInserted = messagesInserted
        self.estimatedTokens = estimatedTokens
    }
}

/// Request body for
/// `POST /v1/assistants/{id}/conversations/{id}/playground/inject-compaction-failures`.
public struct InjectFailuresRequest: Codable, Sendable {
    public let consecutiveFailures: Int?
    public let circuitOpenForMs: Int?

    public init(consecutiveFailures: Int? = nil, circuitOpenForMs: Int? = nil) {
        self.consecutiveFailures = consecutiveFailures
        self.circuitOpenForMs = circuitOpenForMs
    }
}

/// Response from `GET /v1/assistants/{id}/conversations/{id}/playground/compaction-state`.
public struct CompactionStateResponse: Codable, Sendable {
    public let estimatedInputTokens: Int
    public let maxInputTokens: Int
    public let compactThresholdRatio: Double
    public let thresholdTokens: Int
    public let messageCount: Int
    public let contextCompactedMessageCount: Int
    /// Milliseconds since epoch.
    public let contextCompactedAt: Int?
    public let consecutiveCompactionFailures: Int
    /// Milliseconds since epoch.
    public let compactionCircuitOpenUntil: Int?
    public let isCircuitOpen: Bool
    public let isCompactionEnabled: Bool

    public init(
        estimatedInputTokens: Int,
        maxInputTokens: Int,
        compactThresholdRatio: Double,
        thresholdTokens: Int,
        messageCount: Int,
        contextCompactedMessageCount: Int,
        contextCompactedAt: Int?,
        consecutiveCompactionFailures: Int,
        compactionCircuitOpenUntil: Int?,
        isCircuitOpen: Bool,
        isCompactionEnabled: Bool
    ) {
        self.estimatedInputTokens = estimatedInputTokens
        self.maxInputTokens = maxInputTokens
        self.compactThresholdRatio = compactThresholdRatio
        self.thresholdTokens = thresholdTokens
        self.messageCount = messageCount
        self.contextCompactedMessageCount = contextCompactedMessageCount
        self.contextCompactedAt = contextCompactedAt
        self.consecutiveCompactionFailures = consecutiveCompactionFailures
        self.compactionCircuitOpenUntil = compactionCircuitOpenUntil
        self.isCircuitOpen = isCircuitOpen
        self.isCompactionEnabled = isCompactionEnabled
    }
}

/// One entry in the seeded-conversations list.
public struct SeededConversationSummary: Codable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let messageCount: Int
    /// Milliseconds since epoch.
    public let createdAt: Int

    public init(id: String, title: String, messageCount: Int, createdAt: Int) {
        self.id = id
        self.title = title
        self.messageCount = messageCount
        self.createdAt = createdAt
    }
}

/// Response from `GET /v1/assistants/{id}/playground/seeded-conversations`.
public struct SeededConversationsListResponse: Codable, Sendable {
    public let conversations: [SeededConversationSummary]

    public init(conversations: [SeededConversationSummary]) {
        self.conversations = conversations
    }
}

/// Response from the seeded-conversations DELETE endpoints.
public struct DeleteSeededConversationsResponse: Codable, Sendable {
    public let deletedCount: Int

    public init(deletedCount: Int) {
        self.deletedCount = deletedCount
    }
}
