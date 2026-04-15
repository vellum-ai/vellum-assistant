import Foundation

/// Relationship state data contract.
///
/// Wire-compatible mirror of
/// `assistant/src/home/relationship-state.ts`. The TypeScript types are
/// the source of truth — any change there must be mirrored here so a
/// JSON blob produced by one side decodes byte-for-byte on the other.
public struct RelationshipState: Codable, Sendable, Equatable {
    public let version: Int
    /// Forward-compat for multi-assistant. Only one assistant is supported in v1.
    public let assistantId: String
    /// 1-4
    public let tier: Int
    /// 0-100
    public let progressPercent: Int
    public let facts: [Fact]
    public let capabilities: [Capability]
    public let conversationCount: Int
    /// ISO 8601
    public let hatchedDate: String
    public let assistantName: String
    public let userName: String?
    /// ISO 8601
    public let updatedAt: String

    public init(
        version: Int,
        assistantId: String,
        tier: Int,
        progressPercent: Int,
        facts: [Fact],
        capabilities: [Capability],
        conversationCount: Int,
        hatchedDate: String,
        assistantName: String,
        userName: String?,
        updatedAt: String
    ) {
        self.version = version
        self.assistantId = assistantId
        self.tier = tier
        self.progressPercent = progressPercent
        self.facts = facts
        self.capabilities = capabilities
        self.conversationCount = conversationCount
        self.hatchedDate = hatchedDate
        self.assistantName = assistantName
        self.userName = userName
        self.updatedAt = updatedAt
    }
}

public struct Fact: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let category: Category
    public let text: String
    public let confidence: Confidence
    public let source: Source

    public enum Category: String, Codable, Sendable {
        case voice
        case world
        case priorities
    }

    public enum Confidence: String, Codable, Sendable {
        case strong
        case uncertain
    }

    public enum Source: String, Codable, Sendable {
        case onboarding
        case inferred
    }

    public init(
        id: String,
        category: Category,
        text: String,
        confidence: Confidence,
        source: Source
    ) {
        self.id = id
        self.category = category
        self.text = text
        self.confidence = confidence
        self.source = source
    }
}

public struct Capability: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let description: String
    public let tier: Tier
    /// Human-readable unlock requirement.
    public let gate: String
    /// Shown on `.earned` tier: why, not when.
    public let unlockHint: String?
    /// Shown on `.nextUp` tier: e.g. "Connect Google →".
    public let ctaLabel: String?

    public enum Tier: String, Codable, Sendable {
        case unlocked
        case nextUp = "next-up"
        case earned
    }

    public init(
        id: String,
        name: String,
        description: String,
        tier: Tier,
        gate: String,
        unlockHint: String?,
        ctaLabel: String?
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.tier = tier
        self.gate = gate
        self.unlockHint = unlockHint
        self.ctaLabel = ctaLabel
    }
}

public enum RelationshipTier: Int, CaseIterable, Sendable {
    case gettingToKnowYou = 1
    case findingFooting = 2
    case hittingStride = 3
    case inSync = 4

    public var label: String {
        switch self {
        case .gettingToKnowYou: return "Getting to know you"
        case .findingFooting: return "Finding my footing"
        case .hittingStride: return "Hitting our stride"
        case .inSync: return "In sync"
        }
    }

    public var descriptionText: String {
        switch self {
        case .gettingToKnowYou: return "We just met — learning the basics"
        case .findingFooting: return "Starting to understand how you work"
        case .hittingStride: return "We have a real working relationship"
        case .inSync: return "Full partnership"
        }
    }

    public var nextTierHint: String? {
        switch self {
        case .gettingToKnowYou:
            return "A few more conversations and I'll start to find my footing"
        case .findingFooting:
            return "Keep working with me and we'll hit our stride"
        case .hittingStride:
            return "Give me more context and autonomy and we'll be fully in sync"
        case .inSync:
            return nil
        }
    }
}
