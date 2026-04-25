import Foundation

/// User-editable inference profile that mirrors the daemon's
/// `LLMConfigFragment` schema (`assistant/src/config/schemas/llm.ts`).
///
/// Each profile is a partial `llm.default` override stored under
/// `llm.profiles.<name>`. Call sites can reference a profile by name, and
/// the resolver layers the profile's fields on top of `llm.default` before
/// applying any per-call-site overrides.
///
/// Only the leaves the macOS UI exposes are modeled here: `provider`,
/// `model`, `maxTokens`, `effort`, `speed`, `verbosity`, `temperature`,
/// and the two `thinking` sub-fields. Other `LLMConfigFragment` leaves
/// (e.g. `contextWindow`, `openrouter`) flow through the daemon's config
/// layer untouched — the JSON mapper preserves only the fields it knows
/// about, but `SettingsStore.patchConfig` merges into the live config so
/// unknown keys are not clobbered.
public struct InferenceProfile: Codable, Hashable, Identifiable {
    /// Profile name; doubles as the key under `llm.profiles` and the
    /// stable `id` for `Identifiable` conformance.
    public var name: String

    public var provider: String?
    public var model: String?
    public var maxTokens: Int?
    public var effort: String?
    public var speed: String?
    public var verbosity: String?
    public var temperature: Double?

    /// Maps to `thinking.enabled` in the fragment JSON.
    public var thinkingEnabled: Bool?

    /// Maps to `thinking.streamThinking` in the fragment JSON.
    public var thinkingStreamThinking: Bool?

    public var id: String { name }

    public init(
        name: String,
        provider: String? = nil,
        model: String? = nil,
        maxTokens: Int? = nil,
        effort: String? = nil,
        speed: String? = nil,
        verbosity: String? = nil,
        temperature: Double? = nil,
        thinkingEnabled: Bool? = nil,
        thinkingStreamThinking: Bool? = nil
    ) {
        self.name = name
        self.provider = provider
        self.model = model
        self.maxTokens = maxTokens
        self.effort = effort
        self.speed = speed
        self.verbosity = verbosity
        self.temperature = temperature
        self.thinkingEnabled = thinkingEnabled
        self.thinkingStreamThinking = thinkingStreamThinking
    }

    /// Decodes a fragment JSON dictionary as produced by the daemon's
    /// config sync. Unknown keys are ignored. Empty strings are treated
    /// as nil so the round-trip stays symmetric with `toJSON()`, which
    /// omits nil keys entirely.
    public init(name: String, json: [String: Any]) {
        self.name = name
        self.provider = (json["provider"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.model = (json["model"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.maxTokens = json["maxTokens"] as? Int
        self.effort = (json["effort"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.speed = (json["speed"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.verbosity = (json["verbosity"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.temperature = json["temperature"] as? Double
        let thinking = json["thinking"] as? [String: Any]
        self.thinkingEnabled = thinking?["enabled"] as? Bool
        self.thinkingStreamThinking = thinking?["streamThinking"] as? Bool
    }

    /// Encodes the profile as a fragment JSON dictionary suitable for
    /// `settingsClient.patchConfig`. Nil keys are omitted; the nested
    /// `thinking` dict is emitted only when at least one of its
    /// sub-fields is set.
    public func toJSON() -> [String: Any] {
        var result: [String: Any] = [:]
        if let provider { result["provider"] = provider }
        if let model { result["model"] = model }
        if let maxTokens { result["maxTokens"] = maxTokens }
        if let effort { result["effort"] = effort }
        if let speed { result["speed"] = speed }
        if let verbosity { result["verbosity"] = verbosity }
        if let temperature { result["temperature"] = temperature }
        var thinking: [String: Any] = [:]
        if let thinkingEnabled { thinking["enabled"] = thinkingEnabled }
        if let thinkingStreamThinking { thinking["streamThinking"] = thinkingStreamThinking }
        if !thinking.isEmpty {
            result["thinking"] = thinking
        }
        return result
    }
}

/// The three first-class profiles the daemon seeds into every workspace
/// (see migration 052 in `assistant/src/workspace/migrations/`). The
/// macOS UI uses this enum only to render a "Built-in" badge — deletion
/// and editing remain allowed for these profiles.
public enum BuiltInInferenceProfile: String, CaseIterable {
    case qualityOptimized = "quality-optimized"
    case balanced = "balanced"
    case costOptimized = "cost-optimized"

    /// Set of built-in profile names, derived from `allCases`. Used by
    /// the profile editor to decide whether to render the badge.
    public static var allNames: Set<String> {
        Set(allCases.map(\.rawValue))
    }
}
