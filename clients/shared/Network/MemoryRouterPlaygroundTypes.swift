import Foundation

// MARK: - Memory Router Playground Wire Types
//
// Codable types mirroring the daemon's `memory_v2_simulate_router` HTTP
// surface. Keys are lowerCamelCase to match the daemon JSON convention — do
// not add a key-decoding strategy; the wire contract already matches Swift
// property names.

/// A single per-call override for a `memory.v2.router` knob. Distinct from
/// a plain `Int?` so the caller can express the three states the playground
/// supports: "inherit live" (nil), "use this integer", and "explicitly
/// disable this tier" (`.disable`).
public enum MemoryRouterOverride: Equatable, Sendable {
    case inherit
    case value(Int)
    case disable
}

/// Parsed form input for the playground. Encoded into the wire JSON by
/// ``MemoryRouterPlaygroundClient`` so the explicit-null branch is handled
/// in one place instead of leaking through a custom Codable.
public struct MemoryRouterSimulateInput: Equatable, Sendable {
    public let query: String
    public let tier1Size: MemoryRouterOverride
    public let tier2Size: MemoryRouterOverride
    public let batchSize: MemoryRouterOverride

    public init(
        query: String,
        tier1Size: MemoryRouterOverride = .inherit,
        tier2Size: MemoryRouterOverride = .inherit,
        batchSize: MemoryRouterOverride = .inherit
    ) {
        self.query = query
        self.tier1Size = tier1Size
        self.tier2Size = tier2Size
        self.batchSize = batchSize
    }
}

/// The `memory.v2.router` config the simulator actually ran with (live ∪
/// overrides). Mirrors the daemon's `effectiveConfig` object.
public struct MemoryRouterEffectiveConfig: Codable, Sendable {
    public let tier1Size: Int?
    public let tier2Size: Int?
    public let batchSize: Int?
    public let maxPageIds: Int

    public init(tier1Size: Int?, tier2Size: Int?, batchSize: Int?, maxPageIds: Int) {
        self.tier1Size = tier1Size
        self.tier2Size = tier2Size
        self.batchSize = batchSize
        self.maxPageIds = maxPageIds
    }

    private enum CodingKeys: String, CodingKey {
        case tier1Size = "tier1_size"
        case tier2Size = "tier2_size"
        case batchSize = "batch_size"
        case maxPageIds = "max_page_ids"
    }
}

/// The overrides the simulator response echoes back. Each field's presence
/// indicates whether the caller overrode that knob; `nil` means inherited.
public struct MemoryRouterReportedOverrides: Sendable {
    public let tier1Size: MemoryRouterOverride
    public let tier2Size: MemoryRouterOverride
    public let batchSize: MemoryRouterOverride

    public init(
        tier1Size: MemoryRouterOverride = .inherit,
        tier2Size: MemoryRouterOverride = .inherit,
        batchSize: MemoryRouterOverride = .inherit
    ) {
        self.tier1Size = tier1Size
        self.tier2Size = tier2Size
        self.batchSize = batchSize
    }
}

extension MemoryRouterReportedOverrides: Decodable {
    private enum CodingKeys: String, CodingKey {
        case tier1Size = "tier1_size"
        case tier2Size = "tier2_size"
        case batchSize = "batch_size"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.tier1Size = try Self.decode(forKey: .tier1Size, in: container)
        self.tier2Size = try Self.decode(forKey: .tier2Size, in: container)
        self.batchSize = try Self.decode(forKey: .batchSize, in: container)
    }

    private static func decode(
        forKey key: CodingKeys,
        in container: KeyedDecodingContainer<CodingKeys>
    ) throws -> MemoryRouterOverride {
        if !container.contains(key) { return .inherit }
        if try container.decodeNil(forKey: key) { return .disable }
        return .value(try container.decode(Int.self, forKey: key))
    }
}

/// Response from `POST /v1/assistants/{id}/memory/v2/simulate-router/`.
public struct MemoryRouterSimulateResponse: Decodable, Sendable {
    /// Slugs the router would select, in model-returned order.
    public let selectedSlugs: [String]
    /// Per-slug provenance: `"tier1"`, `"tier2"`, or `"tier3:<bucket>"`.
    public let sourceBySlug: [String: String]
    /// EMA scores for the selected slugs (0 when the slug has no events).
    public let scores: [String: Double]
    /// `nil` on success; one of the router failure reasons otherwise.
    public let failureReason: String?
    public let effectiveConfig: MemoryRouterEffectiveConfig
    public let overrides: MemoryRouterReportedOverrides
    /// Page index size the router was given (post-tier-carve, all batches).
    public let totalCandidatePages: Int
}
