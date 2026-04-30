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
///
/// Conformance is intentionally limited to `Hashable` and `Identifiable`.
/// `Codable` is *not* on the list because the wire shape is bespoke (the
/// daemon emits a nested `thinking` sub-object) and synthesized Codable
/// would emit the two `thinking*` properties as flat keys, which the
/// daemon would reject. JSON round-trips go through the manual
/// `init(name:json:)` / `toJSON()` pair below.
public struct InferenceProfile: Hashable, Identifiable {
    /// Profile name; doubles as the key under `llm.profiles` and the
    /// stable `id` for `Identifiable` conformance.
    public var name: String

    /// Origin of the profile. `"managed"` indicates a daemon-seeded profile
    /// that should be read-only in the UI. User-created profiles have `nil`.
    public var source: String?

    /// Human-readable label for pickers and list rows (e.g. "Quality").
    /// Falls back to `name` when absent — see `displayName`.
    public var label: String?

    /// Longer description surfaced as secondary text in the profiles list.
    /// Named `profileDescription` because `description` collides with
    /// Swift's `CustomStringConvertible.description`.
    public var profileDescription: String?

    public var provider: String?
    public var model: String?
    public var maxTokens: Int?
    public var effort: String?
    public var speed: String?
    public var verbosity: String?

    /// Three-state temperature so JSON round-trips preserve the daemon's
    /// `null` vs absent distinction. The resolver's `deepMerge` skips
    /// `undefined` (absent) but treats `null` as a value that overrides
    /// the previous layer — see `assistant/src/config/llm-resolver.ts`,
    /// which has `if (value === undefined) continue;` and no analogous
    /// short-circuit for `null`. `LLMConfigBase.temperature` is
    /// `z.number().min(0).max(2).nullable()` and defaults to `null`, so
    /// an explicit `null` in a fragment carries semantic weight: it
    /// erases any non-null value layered below.
    public var temperature: TemperatureValue

    /// Maps to `thinking.enabled` in the fragment JSON.
    public var thinkingEnabled: Bool?

    /// Maps to `thinking.streamThinking` in the fragment JSON.
    public var thinkingStreamThinking: Bool?

    public var id: String { name }

    /// Whether this profile was seeded by the daemon and should be
    /// treated as read-only in the UI. Users can duplicate a managed
    /// profile to create a customizable variant.
    public var isManaged: Bool { source == "managed" }

    /// Label for pickers and list rows. Prefers the explicit `label`
    /// (e.g. "Quality") and falls back to `name`.
    public var displayName: String { label ?? name }

    /// Optional secondary text for list row subtitles.
    public var subtitle: String? { profileDescription }

    public init(
        name: String,
        source: String? = nil,
        label: String? = nil,
        profileDescription: String? = nil,
        provider: String? = nil,
        model: String? = nil,
        maxTokens: Int? = nil,
        effort: String? = nil,
        speed: String? = nil,
        verbosity: String? = nil,
        temperature: TemperatureValue = .unset,
        thinkingEnabled: Bool? = nil,
        thinkingStreamThinking: Bool? = nil
    ) {
        self.name = name
        self.source = source
        self.label = label
        self.profileDescription = profileDescription
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

    /// Convenience overload that accepts an `Optional<Double>`. `nil`
    /// maps to `.unset` (the field is absent from the fragment). To
    /// produce an explicit `null`, pass `.explicitNull` directly.
    public init(
        name: String,
        source: String? = nil,
        label: String? = nil,
        profileDescription: String? = nil,
        provider: String? = nil,
        model: String? = nil,
        maxTokens: Int? = nil,
        effort: String? = nil,
        speed: String? = nil,
        verbosity: String? = nil,
        temperature: Double?,
        thinkingEnabled: Bool? = nil,
        thinkingStreamThinking: Bool? = nil
    ) {
        self.init(
            name: name,
            source: source,
            label: label,
            profileDescription: profileDescription,
            provider: provider,
            model: model,
            maxTokens: maxTokens,
            effort: effort,
            speed: speed,
            verbosity: verbosity,
            temperature: TemperatureValue(value: temperature),
            thinkingEnabled: thinkingEnabled,
            thinkingStreamThinking: thinkingStreamThinking
        )
    }

    /// Decodes a fragment JSON dictionary as produced by the daemon's
    /// config sync. Unknown keys are ignored. Empty strings are treated
    /// as nil so the round-trip stays symmetric with `toJSON()`, which
    /// omits nil keys entirely. `temperature: null` round-trips as
    /// `.explicitNull` so the daemon's "clear back to default" semantics
    /// survive a save.
    public init(name: String, json: [String: Any]) {
        self.name = name
        self.source = (json["source"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.label = (json["label"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.profileDescription = (json["description"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.provider = (json["provider"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.model = (json["model"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.maxTokens = json["maxTokens"] as? Int
        self.effort = (json["effort"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.speed = (json["speed"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.verbosity = (json["verbosity"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.temperature = TemperatureValue(jsonValue: json["temperature"], present: json.keys.contains("temperature"))
        let thinking = json["thinking"] as? [String: Any]
        self.thinkingEnabled = thinking?["enabled"] as? Bool
        self.thinkingStreamThinking = thinking?["streamThinking"] as? Bool
    }

    /// Returns a copy of `self` with every non-nil field on `fragment`
    /// applied on top — mirrors the daemon's deep-merge semantics for
    /// `llm.profiles.<name>` patches so the local cache stays in sync
    /// with what the daemon will store after a partial-update PATCH.
    public func merging(_ fragment: InferenceProfile) -> InferenceProfile {
        var merged = self
        if let v = fragment.provider { merged.provider = v }
        if let v = fragment.model { merged.model = v }
        if let v = fragment.maxTokens { merged.maxTokens = v }
        if let v = fragment.effort { merged.effort = v }
        if let v = fragment.speed { merged.speed = v }
        if let v = fragment.verbosity { merged.verbosity = v }
        // `.unset` means "no opinion" — any other state overrides.
        if fragment.temperature != .unset { merged.temperature = fragment.temperature }
        if let v = fragment.thinkingEnabled { merged.thinkingEnabled = v }
        if let v = fragment.thinkingStreamThinking { merged.thinkingStreamThinking = v }
        return merged
    }

    /// Encodes the profile as a fragment JSON dictionary suitable for
    /// `settingsClient.patchConfig`. Nil keys are omitted; the nested
    /// `thinking` dict is emitted only when at least one of its
    /// sub-fields is set. `temperature` emits `NSNull()` for
    /// `.explicitNull` so the daemon receives the original wire-shape
    /// distinction between "absent" and "null".
    public func toJSON() -> [String: Any] {
        var result: [String: Any] = [:]
        if let source { result["source"] = source }
        if let label { result["label"] = label }
        if let profileDescription { result["description"] = profileDescription }
        if let provider { result["provider"] = provider }
        if let model { result["model"] = model }
        if let maxTokens { result["maxTokens"] = maxTokens }
        if let effort { result["effort"] = effort }
        if let speed { result["speed"] = speed }
        if let verbosity { result["verbosity"] = verbosity }
        switch temperature {
        case .unset:
            break
        case .explicitNull:
            result["temperature"] = NSNull()
        case .value(let v):
            result["temperature"] = v
        }
        var thinking: [String: Any] = [:]
        if let thinkingEnabled { thinking["enabled"] = thinkingEnabled }
        if let thinkingStreamThinking { thinking["streamThinking"] = thinkingStreamThinking }
        if !thinking.isEmpty {
            result["thinking"] = thinking
        }
        return result
    }
}

/// Three-state representation of `LLMConfigFragment.temperature`. The
/// daemon's resolver distinguishes "absent" (let the previous layer's
/// value pass through) from "explicit null" (override to null and clear
/// any value layered below); see `assistant/src/config/llm-resolver.ts`
/// and the `nullable` schema in `assistant/src/config/schemas/llm.ts`.
public enum TemperatureValue: Hashable {
    /// Field absent from the fragment — no opinion.
    case unset

    /// Field present in the fragment with JSON `null`. Overrides any
    /// non-null temperature layered below.
    case explicitNull

    /// Field present with a numeric value in `[0, 2]`.
    case value(Double)

    /// Convenience: map an `Optional<Double>` (the legacy shape) into
    /// the three-state enum. `nil` maps to `.unset`. To produce
    /// `.explicitNull`, construct the case directly.
    public init(value: Double?) {
        if let value {
            self = .value(value)
        } else {
            self = .unset
        }
    }

    /// Decodes the temperature leaf from a JSON dictionary entry.
    /// `present` indicates whether the dictionary contained the
    /// `temperature` key at all — JSON `null` decodes to `NSNull` in
    /// `[String: Any]`, which fails the `Double` cast, so we need the
    /// presence flag to distinguish "key absent" from "key set to null".
    public init(jsonValue: Any?, present: Bool) {
        if !present {
            self = .unset
        } else if let number = jsonValue as? Double {
            self = .value(number)
        } else if let int = jsonValue as? Int {
            self = .value(Double(int))
        } else {
            // Present but not a number — either explicit `NSNull` or an
            // unexpected shape. Treat both as `.explicitNull`; the
            // daemon's schema accepts only `null` or a number, so a
            // non-number is the only other valid daemon-emitted shape.
            self = .explicitNull
        }
    }

    /// The numeric value, if any. Returns `nil` for both `.unset` and
    /// `.explicitNull` — callers that need to distinguish them should
    /// switch on the enum directly.
    public var doubleValue: Double? {
        if case .value(let v) = self { return v }
        return nil
    }
}

