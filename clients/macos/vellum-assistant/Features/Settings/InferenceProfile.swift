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
/// the three `thinking` sub-fields, and `contextWindow.maxInputTokens`.
/// Other `LLMConfigFragment` leaves (e.g. `openrouter` and non-UI
/// `contextWindow` sub-fields) are preserved by the JSON mapper so edits
/// can round-trip profile fragments without clobbering hidden settings.
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

    /// Visibility status. `"active"` (default, represented as `nil` in the JSON)
    /// means the profile is shown in pickers. `"disabled"` hides it from pickers
    /// but keeps it visible in the profiles list so the user can re-enable it.
    public var status: String?

    /// Human-readable label for pickers and list rows (e.g. "Quality").
    /// Falls back to `name` when absent — see `displayName`.
    public var label: String?

    /// Longer description surfaced as secondary text in the profiles list.
    /// Named `profileDescription` because `description` collides with
    /// Swift's `CustomStringConvertible.description`.
    public var profileDescription: String?

    public var provider: String?

    /// Name of a `provider_connections` row to bind this profile to. When set,
    /// the daemon dispatcher resolves auth from this specific connection
    /// instead of falling back to "the first active connection for the
    /// provider." Mirrors `ProfileEntry.provider_connection` in
    /// `assistant/src/config/schemas/llm.ts`.
    ///
    /// Wire shape is `provider_connection` (snake_case) because the daemon's
    /// Zod schema declares the field with that literal key; see
    /// `LLMConfigBase.provider_connection` in `llm.ts`.
    public var providerConnection: String?

    public var model: String?
    public var maxTokens: Int?
    public var effort: String?
    public var speed: String?
    public var verbosity: String?
    public var contextWindowMaxInputTokens: Int?

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

    /// Maps to `thinking.level` in the fragment JSON. Gemini's reasoning-depth
    /// knob (`minimal`/`low`/`medium`/`high`); other providers ignore it.
    public var thinkingLevel: String?

    private var preservedJSON: [String: Any]

    public var id: String { name }

    /// Whether this profile was seeded by the daemon and should be
    /// treated as read-only in the UI. Users can duplicate a managed
    /// profile to create a customizable variant.
    public var isManaged: Bool { source == "managed" }

    /// Whether this profile is disabled. Disabled profiles are hidden from
    /// picker UIs but remain visible in the profiles list for re-enabling.
    public var isDisabled: Bool { status == "disabled" }

    /// Label for pickers and list rows. Prefers the explicit `label`
    /// (e.g. "Quality") and falls back to `name`.
    public var displayName: String { label ?? name }

    /// Optional secondary text for list row subtitles.
    public var subtitle: String? { profileDescription }

    public init(
        name: String,
        source: String? = nil,
        status: String? = nil,
        label: String? = nil,
        profileDescription: String? = nil,
        provider: String? = nil,
        providerConnection: String? = nil,
        model: String? = nil,
        maxTokens: Int? = nil,
        effort: String? = nil,
        speed: String? = nil,
        verbosity: String? = nil,
        contextWindowMaxInputTokens: Int? = nil,
        temperature: TemperatureValue = .unset,
        thinkingEnabled: Bool? = nil,
        thinkingStreamThinking: Bool? = nil,
        thinkingLevel: String? = nil
    ) {
        self.name = name
        self.source = source
        self.status = status
        self.label = label
        self.profileDescription = profileDescription
        self.provider = provider
        self.providerConnection = providerConnection
        self.model = model
        self.maxTokens = maxTokens
        self.effort = effort
        self.speed = speed
        self.verbosity = verbosity
        self.contextWindowMaxInputTokens = contextWindowMaxInputTokens
        self.temperature = temperature
        self.thinkingEnabled = thinkingEnabled
        self.thinkingStreamThinking = thinkingStreamThinking
        self.thinkingLevel = thinkingLevel
        self.preservedJSON = [:]
    }

    /// Convenience overload that accepts an `Optional<Double>`. `nil`
    /// maps to `.unset` (the field is absent from the fragment). To
    /// produce an explicit `null`, pass `.explicitNull` directly.
    public init(
        name: String,
        source: String? = nil,
        status: String? = nil,
        label: String? = nil,
        profileDescription: String? = nil,
        provider: String? = nil,
        providerConnection: String? = nil,
        model: String? = nil,
        maxTokens: Int? = nil,
        effort: String? = nil,
        speed: String? = nil,
        verbosity: String? = nil,
        contextWindowMaxInputTokens: Int? = nil,
        temperature: Double?,
        thinkingEnabled: Bool? = nil,
        thinkingStreamThinking: Bool? = nil,
        thinkingLevel: String? = nil
    ) {
        self.init(
            name: name,
            source: source,
            status: status,
            label: label,
            profileDescription: profileDescription,
            provider: provider,
            providerConnection: providerConnection,
            model: model,
            maxTokens: maxTokens,
            effort: effort,
            speed: speed,
            verbosity: verbosity,
            contextWindowMaxInputTokens: contextWindowMaxInputTokens,
            temperature: TemperatureValue(value: temperature),
            thinkingEnabled: thinkingEnabled,
            thinkingStreamThinking: thinkingStreamThinking,
            thinkingLevel: thinkingLevel
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
        self.status = (json["status"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.label = (json["label"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.profileDescription = (json["description"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.provider = (json["provider"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.providerConnection = (json["provider_connection"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.model = (json["model"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.maxTokens = Self.intValue(json["maxTokens"])
        self.effort = (json["effort"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.speed = (json["speed"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.verbosity = (json["verbosity"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let contextWindow = json["contextWindow"] as? [String: Any]
        self.contextWindowMaxInputTokens = Self.intValue(contextWindow?["maxInputTokens"])
        self.temperature = TemperatureValue(jsonValue: json["temperature"], present: json.keys.contains("temperature"))
        let thinking = json["thinking"] as? [String: Any]
        self.thinkingEnabled = thinking?["enabled"] as? Bool
        self.thinkingStreamThinking = thinking?["streamThinking"] as? Bool
        self.thinkingLevel = (thinking?["level"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.preservedJSON = Self.preservedJSON(from: json)
    }

    /// Returns a copy of `self` with every non-nil field on `fragment`
    /// applied on top — mirrors the daemon's deep-merge semantics for
    /// `llm.profiles.<name>` patches so the local cache stays in sync
    /// with what the daemon will store after a partial-update PATCH.
    public func merging(_ fragment: InferenceProfile) -> InferenceProfile {
        var merged = self
        if let v = fragment.status { merged.status = v }
        if let v = fragment.provider { merged.provider = v }
        if let v = fragment.providerConnection { merged.providerConnection = v }
        if let v = fragment.model { merged.model = v }
        if let v = fragment.maxTokens { merged.maxTokens = v }
        if let v = fragment.effort { merged.effort = v }
        if let v = fragment.speed { merged.speed = v }
        if let v = fragment.verbosity { merged.verbosity = v }
        if let v = fragment.contextWindowMaxInputTokens { merged.contextWindowMaxInputTokens = v }
        // `.unset` means "no opinion" — any other state overrides.
        if fragment.temperature != .unset { merged.temperature = fragment.temperature }
        if let v = fragment.thinkingEnabled { merged.thinkingEnabled = v }
        if let v = fragment.thinkingStreamThinking { merged.thinkingStreamThinking = v }
        if let v = fragment.thinkingLevel { merged.thinkingLevel = v }
        return merged
    }

    /// Encodes the profile as a fragment JSON dictionary suitable for
    /// `settingsClient.patchConfig`. Nil keys are omitted; the nested
    /// `thinking` dict is emitted only when at least one of its
    /// sub-fields is set. `temperature` emits `NSNull()` for
    /// `.explicitNull` so the daemon receives the original wire-shape
    /// distinction between "absent" and "null".
    public func toJSON() -> [String: Any] {
        var result = preservedJSON
        if let source { result["source"] = source }
        // Omit status when active (absent == active convention); always include when disabled.
        if let status, status == "disabled" { result["status"] = status }
        if let label { result["label"] = label }
        if let profileDescription { result["description"] = profileDescription }
        if let provider { result["provider"] = provider }
        if let providerConnection { result["provider_connection"] = providerConnection }
        if let model { result["model"] = model }
        if let maxTokens { result["maxTokens"] = maxTokens }
        if let effort { result["effort"] = effort }
        if let speed { result["speed"] = speed }
        if let verbosity { result["verbosity"] = verbosity }
        var contextWindow = (result["contextWindow"] as? [String: Any]) ?? [:]
        if let contextWindowMaxInputTokens {
            contextWindow["maxInputTokens"] = contextWindowMaxInputTokens
        } else {
            contextWindow.removeValue(forKey: "maxInputTokens")
        }
        if contextWindow.isEmpty {
            result.removeValue(forKey: "contextWindow")
        } else {
            result["contextWindow"] = contextWindow
        }
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
        if let thinkingLevel { thinking["level"] = thinkingLevel }
        if !thinking.isEmpty {
            result["thinking"] = thinking
        }
        return result
    }

    private static func preservedJSON(from json: [String: Any]) -> [String: Any] {
        var preserved = json
        for key in [
            "source",
            "status",
            "label",
            "description",
            "provider",
            "provider_connection",
            "model",
            "maxTokens",
            "effort",
            "speed",
            "verbosity",
            "temperature",
            "thinking",
        ] {
            preserved.removeValue(forKey: key)
        }

        if var contextWindow = json["contextWindow"] as? [String: Any] {
            contextWindow.removeValue(forKey: "maxInputTokens")
            if contextWindow.isEmpty {
                preserved.removeValue(forKey: "contextWindow")
            } else {
                preserved["contextWindow"] = contextWindow
            }
        } else {
            preserved.removeValue(forKey: "contextWindow")
        }
        return preserved
    }

    private static func intValue(_ value: Any?) -> Int? {
        if let int = value as? Int {
            return int
        }
        if let double = value as? Double,
           double.isFinite,
           double.rounded(.towardZero) == double,
           double >= Double(Int.min),
           double < Double(Int.max) {
            return Int(double)
        }
        return nil
    }

    public static func == (lhs: InferenceProfile, rhs: InferenceProfile) -> Bool {
        lhs.name == rhs.name
            && lhs.source == rhs.source
            && lhs.status == rhs.status
            && lhs.label == rhs.label
            && lhs.profileDescription == rhs.profileDescription
            && lhs.provider == rhs.provider
            && lhs.providerConnection == rhs.providerConnection
            && lhs.model == rhs.model
            && lhs.maxTokens == rhs.maxTokens
            && lhs.effort == rhs.effort
            && lhs.speed == rhs.speed
            && lhs.verbosity == rhs.verbosity
            && lhs.contextWindowMaxInputTokens == rhs.contextWindowMaxInputTokens
            && lhs.temperature == rhs.temperature
            && lhs.thinkingEnabled == rhs.thinkingEnabled
            && lhs.thinkingStreamThinking == rhs.thinkingStreamThinking
            && lhs.thinkingLevel == rhs.thinkingLevel
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(name)
        hasher.combine(source)
        hasher.combine(status)
        hasher.combine(label)
        hasher.combine(profileDescription)
        hasher.combine(provider)
        hasher.combine(providerConnection)
        hasher.combine(model)
        hasher.combine(maxTokens)
        hasher.combine(effort)
        hasher.combine(speed)
        hasher.combine(verbosity)
        hasher.combine(contextWindowMaxInputTokens)
        hasher.combine(temperature)
        hasher.combine(thinkingEnabled)
        hasher.combine(thinkingStreamThinking)
        hasher.combine(thinkingLevel)
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

extension InferenceProfile {
    /// Name of the meta-"auto" profile seeded by the daemon. The entry
    /// exists in `llm.profiles` unconditionally so a switched-on
    /// `query-complexity-routing` flag has something to point at, but
    /// every UI surface that lists profiles must hide it while the flag
    /// is off. Otherwise it leaks into the composer picker, the Default
    /// Profile dropdown, the Manage Profiles list, and the per-call-site
    /// override picker.
    ///
    /// Mirrors `AUTO_PROFILE_KEY` in
    /// `assistant/src/config/seed-inference-profiles.ts` and
    /// `AUTO_PROFILE_NAME` in `apps/web/src/assistant/profile-pickers.ts`.
    public static let autoProfileName = "auto"

    /// Returns the subset of `profiles` to render in a list-style UI.
    /// Drops the meta-"auto" profile when the `query-complexity-routing`
    /// feature flag is off. When the flag is on, the input is returned
    /// unchanged so the auto profile renders alongside user profiles.
    ///
    /// Mirrors `gateAutoProfile` in
    /// `apps/web/src/assistant/profile-pickers.ts`.
    public static func gateAutoProfile(
        _ profiles: [InferenceProfile],
        queryComplexityRoutingEnabled: Bool
    ) -> [InferenceProfile] {
        if queryComplexityRoutingEnabled { return profiles }
        return profiles.filter { $0.name != autoProfileName }
    }
}
