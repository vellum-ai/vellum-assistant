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

/// One `(assistant, user)` turn pair rendered inside `<last_turn>`. The
/// last pair in ``MemoryRouterSimulateInput.recentTurnPairs`` represents
/// the just-arrived user turn the router is routing for; earlier pairs
/// are conversation history. `assistantMessage` may be empty on the
/// oldest pair for a first-turn scenario — the daemon skips the
/// `[assistant]:` line in that case.
public struct RecentTurnPair: Equatable, Sendable {
    public let assistantMessage: String
    public let userMessage: String

    public init(assistantMessage: String, userMessage: String) {
        self.assistantMessage = assistantMessage
        self.userMessage = userMessage
    }
}

/// Parsed form input for the playground. Encoded into the wire JSON by
/// ``MemoryRouterPlaygroundClient`` so the explicit-null branch is handled
/// in one place instead of leaking through a custom Codable.
public struct MemoryRouterSimulateInput: Equatable, Sendable {
    /// Recent (assistant, user) turn pairs, oldest first. Must contain at
    /// least one entry; the last entry's `userMessage` is the just-arrived
    /// turn that triggered the router.
    public let recentTurnPairs: [RecentTurnPair]
    /// Verbatim `<now>` body. `nil` means "let the daemon load the live
    /// NOW.md" (production-like default).
    public let nowText: String?
    public let tier1Size: MemoryRouterOverride
    public let tier2Size: MemoryRouterOverride
    public let batchSize: MemoryRouterOverride
    /// Per-call `llm.profiles` override name. `nil` means "inherit active".
    public let profileOverride: String?
    /// Inline router system-prompt override. `nil` or whitespace-only means
    /// "use the bundled template" — the daemon normalizes either way.
    public let routerPromptOverride: String?

    public init(
        recentTurnPairs: [RecentTurnPair],
        nowText: String? = nil,
        tier1Size: MemoryRouterOverride = .inherit,
        tier2Size: MemoryRouterOverride = .inherit,
        batchSize: MemoryRouterOverride = .inherit,
        profileOverride: String? = nil,
        routerPromptOverride: String? = nil
    ) {
        self.recentTurnPairs = recentTurnPairs
        self.nowText = nowText
        self.tier1Size = tier1Size
        self.tier2Size = tier2Size
        self.batchSize = batchSize
        self.profileOverride = profileOverride
        self.routerPromptOverride = routerPromptOverride
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
    /// Profile name passed as an override on this call, or `nil` if none.
    public let profileOverride: String?
    /// `true` when an inline router prompt override was applied this call.
    public let routerPromptOverridden: Bool

    private enum CodingKeys: String, CodingKey {
        case selectedSlugs
        case sourceBySlug
        case scores
        case failureReason
        case effectiveConfig
        case overrides
        case totalCandidatePages
        case profileOverride
        case routerPromptOverridden
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.selectedSlugs = try container.decode([String].self, forKey: .selectedSlugs)
        self.sourceBySlug = try container.decode([String: String].self, forKey: .sourceBySlug)
        self.scores = try container.decode([String: Double].self, forKey: .scores)
        self.failureReason = try container.decodeIfPresent(String.self, forKey: .failureReason)
        self.effectiveConfig = try container.decode(MemoryRouterEffectiveConfig.self, forKey: .effectiveConfig)
        self.overrides = try container.decode(MemoryRouterReportedOverrides.self, forKey: .overrides)
        self.totalCandidatePages = try container.decode(Int.self, forKey: .totalCandidatePages)
        self.profileOverride = try container.decodeIfPresent(String.self, forKey: .profileOverride)
        // Forward-compat: an older daemon won't send this field. Default
        // to `false` rather than failing the decode for the entire response.
        self.routerPromptOverridden =
            try container.decodeIfPresent(Bool.self, forKey: .routerPromptOverridden) ?? false
    }
}

/// Response from `GET /v1/assistants/{id}/config/llm/profiles/`. Used to
/// populate per-pane profile dropdowns in the playground.
public struct LlmProfilesListResponse: Decodable, Sendable {
    public let profiles: [String]
    public let activeProfile: String?
}

/// Decoded simulate response paired with the pretty-printed request body
/// that was sent and the raw response body that came back. The playground
/// surfaces both strings in a "Raw API exchange" disclosure for debugging.
public struct MemoryRouterSimulateResult: Sendable {
    public let response: MemoryRouterSimulateResponse
    public let rawRequest: String
    public let rawResponse: String

    public init(
        response: MemoryRouterSimulateResponse,
        rawRequest: String,
        rawResponse: String
    ) {
        self.response = response
        self.rawRequest = rawRequest
        self.rawResponse = rawResponse
    }
}
