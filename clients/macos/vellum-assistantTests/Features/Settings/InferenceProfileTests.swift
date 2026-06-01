import XCTest
@testable import VellumAssistantLib

/// Verifies the `InferenceProfile` JSON ↔ struct round-trip used by
/// `SettingsStore` to patch `llm.profiles.<name>`. The fragment shape
/// must stay aligned with the daemon's `LLMConfigFragment` schema in
/// `assistant/src/config/schemas/llm.ts`.
final class InferenceProfileTests: XCTestCase {

    // MARK: - Empty fragment

    func testEmptyFragmentRoundTrips() {
        let profile = InferenceProfile(name: "empty")
        let json = profile.toJSON()
        XCTAssertTrue(json.isEmpty, "Empty profile must produce an empty JSON dict")

        let decoded = InferenceProfile(name: "empty", json: json)
        XCTAssertEqual(decoded, profile)
    }

    func testEmptyJSONDecodesToAllNilFields() {
        let profile = InferenceProfile(name: "empty", json: [:])
        XCTAssertNil(profile.provider)
        XCTAssertNil(profile.model)
        XCTAssertNil(profile.maxTokens)
        XCTAssertNil(profile.effort)
        XCTAssertNil(profile.speed)
        XCTAssertNil(profile.verbosity)
        XCTAssertEqual(profile.temperature, .unset)
        XCTAssertNil(profile.thinkingEnabled)
        XCTAssertNil(profile.thinkingStreamThinking)
    }

    func testIntegerFieldsDecodeExactDoublesWithinIntBounds() {
        let profile = InferenceProfile(
            name: "numeric-json",
            json: [
                "maxTokens": 64000.0,
                "contextWindow": [
                    "maxInputTokens": 150000.0,
                ],
            ]
        )

        XCTAssertEqual(profile.maxTokens, 64000)
        XCTAssertEqual(profile.contextWindowMaxInputTokens, 150000)
    }

    func testIntegerFieldsIgnoreUnsafeDoubleValues() {
        let huge = Double.greatestFiniteMagnitude
        let profile = InferenceProfile(
            name: "unsafe-numbers",
            json: [
                "maxTokens": huge,
                "contextWindow": [
                    "maxInputTokens": 150000.5,
                ],
            ]
        )

        XCTAssertNil(profile.maxTokens)
        XCTAssertNil(profile.contextWindowMaxInputTokens)
    }

    // MARK: - Fully-populated fragment

    func testFullyPopulatedFragmentRoundTrips() {
        let original = InferenceProfile(
            name: "balanced",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            maxTokens: 64000,
            effort: "medium",
            speed: "standard",
            verbosity: "high",
            temperature: 0.7,
            thinkingEnabled: true,
            thinkingStreamThinking: false
        )

        let json = original.toJSON()
        XCTAssertEqual(json["provider"] as? String, "anthropic")
        XCTAssertEqual(json["model"] as? String, "claude-sonnet-4-6")
        XCTAssertEqual(json["maxTokens"] as? Int, 64000)
        XCTAssertEqual(json["effort"] as? String, "medium")
        XCTAssertEqual(json["speed"] as? String, "standard")
        XCTAssertEqual(json["verbosity"] as? String, "high")
        XCTAssertEqual(json["temperature"] as? Double, 0.7)
        let thinking = json["thinking"] as? [String: Any]
        XCTAssertNotNil(thinking)
        XCTAssertEqual(thinking?["enabled"] as? Bool, true)
        XCTAssertEqual(thinking?["streamThinking"] as? Bool, false)

        let decoded = InferenceProfile(name: "balanced", json: json)
        XCTAssertEqual(decoded, original)
    }

    // MARK: - Thinking-only fragment

    func testThinkingOnlyFragmentRoundTrips() {
        let original = InferenceProfile(
            name: "thinking-only",
            thinkingEnabled: false,
            thinkingStreamThinking: true
        )

        let json = original.toJSON()
        XCTAssertNil(json["provider"])
        XCTAssertNil(json["model"])
        XCTAssertNil(json["maxTokens"])
        XCTAssertNil(json["effort"])
        XCTAssertNil(json["speed"])
        XCTAssertNil(json["verbosity"])
        XCTAssertNil(json["temperature"])
        let thinking = json["thinking"] as? [String: Any]
        XCTAssertNotNil(thinking, "Thinking dict must be present when any sub-field is set")
        XCTAssertEqual(thinking?["enabled"] as? Bool, false)
        XCTAssertEqual(thinking?["streamThinking"] as? Bool, true)

        let decoded = InferenceProfile(name: "thinking-only", json: json)
        XCTAssertEqual(decoded, original)
    }

    func testThinkingDictOmittedWhenBothSubFieldsAreNil() {
        let profile = InferenceProfile(
            name: "no-thinking",
            provider: "openai"
        )
        let json = profile.toJSON()
        XCTAssertNil(json["thinking"], "Thinking dict must be omitted when both sub-fields are nil")
    }

    func testThinkingDictKeptWhenOnlyOneSubFieldIsSet() {
        let onlyEnabled = InferenceProfile(name: "only-enabled", thinkingEnabled: true)
        let onlyEnabledThinking = onlyEnabled.toJSON()["thinking"] as? [String: Any]
        XCTAssertNotNil(onlyEnabledThinking)
        XCTAssertEqual(onlyEnabledThinking?["enabled"] as? Bool, true)
        XCTAssertNil(onlyEnabledThinking?["streamThinking"])

        let onlyStream = InferenceProfile(name: "only-stream", thinkingStreamThinking: true)
        let onlyStreamThinking = onlyStream.toJSON()["thinking"] as? [String: Any]
        XCTAssertNotNil(onlyStreamThinking)
        XCTAssertNil(onlyStreamThinking?["enabled"])
        XCTAssertEqual(onlyStreamThinking?["streamThinking"] as? Bool, true)
    }

    func testThinkingLevelRoundTrips() {
        let original = InferenceProfile(
            name: "gemini-level",
            provider: "gemini",
            model: "gemini-3.1-pro-preview",
            thinkingLevel: "high"
        )

        let thinking = original.toJSON()["thinking"] as? [String: Any]
        XCTAssertNotNil(thinking, "Thinking dict must be present when a level is set")
        XCTAssertEqual(thinking?["level"] as? String, "high")
        XCTAssertNil(thinking?["enabled"])
        XCTAssertNil(thinking?["streamThinking"])

        let decoded = InferenceProfile(name: "gemini-level", json: original.toJSON())
        XCTAssertEqual(decoded.thinkingLevel, "high")
        XCTAssertEqual(decoded, original)
    }

    // MARK: - Decoder edge cases

    func testEmptyStringFieldsDecodeAsNil() {
        let json: [String: Any] = [
            "provider": "",
            "model": "",
            "effort": "",
            "speed": "",
            "verbosity": "",
        ]
        let profile = InferenceProfile(name: "empties", json: json)
        XCTAssertNil(profile.provider)
        XCTAssertNil(profile.model)
        XCTAssertNil(profile.effort)
        XCTAssertNil(profile.speed)
        XCTAssertNil(profile.verbosity)
    }

    func testUnknownKeysArePreservedThroughJSONRoundTrip() {
        let json: [String: Any] = [
            "provider": "anthropic",
            "totallyUnknown": "preserved",
            "thinking": [
                "enabled": true,
                "alsoUnknown": 123,
            ],
        ]
        let profile = InferenceProfile(name: "extra", json: json)
        XCTAssertEqual(profile.provider, "anthropic")
        XCTAssertEqual(profile.thinkingEnabled, true)
        XCTAssertNil(profile.thinkingStreamThinking)

        let reEncoded = profile.toJSON()
        XCTAssertEqual(reEncoded["totallyUnknown"] as? String, "preserved")
        let thinking = reEncoded["thinking"] as? [String: Any]
        XCTAssertNil(thinking?["alsoUnknown"])
    }

    // MARK: - Identifiable

    func testIdReturnsName() {
        let profile = InferenceProfile(name: "balanced")
        XCTAssertEqual(profile.id, "balanced")
    }

    // MARK: - Source, label, description

    func testSourceLabelDescriptionRoundTrip() {
        let json: [String: Any] = [
            "source": "managed",
            "label": "Quality",
            "description": "Highest quality output",
            "provider": "anthropic",
        ]
        let profile = InferenceProfile(name: "quality-optimized", json: json)
        XCTAssertEqual(profile.source, "managed")
        XCTAssertEqual(profile.label, "Quality")
        XCTAssertEqual(profile.profileDescription, "Highest quality output")
        XCTAssertTrue(profile.isManaged)
        XCTAssertEqual(profile.displayName, "Quality")
        XCTAssertEqual(profile.subtitle, "Highest quality output")

        let reEncoded = profile.toJSON()
        XCTAssertEqual(reEncoded["source"] as? String, "managed")
        XCTAssertEqual(reEncoded["label"] as? String, "Quality")
        XCTAssertEqual(reEncoded["description"] as? String, "Highest quality output")
    }

    func testIsManagedFalseWhenSourceIsNil() {
        let profile = InferenceProfile(name: "custom")
        XCTAssertFalse(profile.isManaged)
    }

    func testIsManagedFalseWhenSourceIsNotManaged() {
        let profile = InferenceProfile(name: "custom", source: "user")
        XCTAssertFalse(profile.isManaged)
    }

    func testDisplayNameFallsBackToNameWhenLabelIsNil() {
        let profile = InferenceProfile(name: "my-profile")
        XCTAssertEqual(profile.displayName, "my-profile")
    }

    func testSubtitleIsNilWhenDescriptionIsNil() {
        let profile = InferenceProfile(name: "simple")
        XCTAssertNil(profile.subtitle)
    }

    // MARK: - Temperature: explicit null vs unset

    /// `null` and "absent" are NOT semantically equivalent in the daemon's
    /// resolver. `assistant/src/config/llm-resolver.ts` deepMerge does
    /// `if (value === undefined) continue;` — `null` is *not* skipped, so
    /// a profile fragment with `temperature: null` overrides any non-null
    /// value layered below. The Swift mapper must preserve the distinction.
    func testExplicitNullTemperatureSurvivesRoundTrip() {
        let json: [String: Any] = ["temperature": NSNull()]
        let decoded = InferenceProfile(name: "explicit-null", json: json)
        XCTAssertEqual(decoded.temperature, .explicitNull)

        let reEncoded = decoded.toJSON()
        XCTAssertTrue(
            reEncoded["temperature"] is NSNull,
            "Explicit null must round-trip as NSNull, not be omitted"
        )
    }

    func testAbsentTemperatureRoundTripsAsUnset() {
        let json: [String: Any] = [:]
        let decoded = InferenceProfile(name: "absent", json: json)
        XCTAssertEqual(decoded.temperature, .unset)

        let reEncoded = decoded.toJSON()
        XCTAssertNil(
            reEncoded["temperature"],
            "Unset temperature must remain absent on re-encode"
        )
    }

    func testTemperatureValueRoundTripsAsValue() {
        let json: [String: Any] = ["temperature": 0.42]
        let decoded = InferenceProfile(name: "warm", json: json)
        XCTAssertEqual(decoded.temperature, .value(0.42))

        let reEncoded = decoded.toJSON()
        XCTAssertEqual(reEncoded["temperature"] as? Double, 0.42)
    }

    /// The convenience `Optional<Double>` initializer maps `nil` to
    /// `.unset` so existing call sites that constructed profiles with
    /// `temperature: nil` keep producing fragments where the field is
    /// absent (the previous behavior).
    func testOptionalDoubleInitializerMapsNilToUnset() {
        let profile = InferenceProfile(
            name: "legacy",
            temperature: Double?.none
        )
        XCTAssertEqual(profile.temperature, .unset)
        XCTAssertNil(profile.toJSON()["temperature"])
    }

    func testOptionalDoubleInitializerMapsValueToValue() {
        let profile = InferenceProfile(
            name: "legacy-set",
            temperature: 0.7
        )
        XCTAssertEqual(profile.temperature, .value(0.7))
        XCTAssertEqual(profile.toJSON()["temperature"] as? Double, 0.7)
    }

    // MARK: - merging(_:)

    /// `setProfile`'s merge path (`SettingsStore.setProfile`) updates the
    /// local cache via `merging(fragment)` after a partial-update PATCH
    /// succeeds. A status flip in the fragment must propagate or the UI
    /// will show the stale status until the next config refresh.
    func testMergingAppliesStatusFromFragment() {
        let base = InferenceProfile(name: "quality", status: nil, provider: "anthropic", model: "claude")
        let fragment = InferenceProfile(name: "quality", status: "disabled")

        let merged = base.merging(fragment)

        XCTAssertEqual(merged.status, "disabled")
        XCTAssertEqual(merged.provider, "anthropic")
        XCTAssertEqual(merged.model, "claude")
    }

    /// Fragments that omit `status` (e.g. only `model` changed) must
    /// preserve the current status — same `if let` pattern every other
    /// field uses.
    func testMergingPreservesStatusWhenFragmentOmitsIt() {
        let base = InferenceProfile(name: "quality", status: "disabled", provider: "anthropic")
        let fragment = InferenceProfile(name: "quality", model: "claude-3.5")

        let merged = base.merging(fragment)

        XCTAssertEqual(merged.status, "disabled")
        XCTAssertEqual(merged.model, "claude-3.5")
    }

    // MARK: - provider_connection (audit finding #5)

    /// Profiles that bind to a specific provider connection must round-trip
    /// the daemon's snake_case `provider_connection` wire field. The Swift
    /// property uses camelCase `providerConnection` but the JSON key matches
    /// the Zod schema in `assistant/src/config/schemas/llm.ts`.
    func testProviderConnectionRoundTrip() {
        let json: [String: Any] = [
            "provider": "openai",
            "provider_connection": "personal-openai",
            "model": "gpt-5",
        ]
        let profile = InferenceProfile(name: "personal", json: json)
        XCTAssertEqual(profile.provider, "openai")
        XCTAssertEqual(profile.providerConnection, "personal-openai")
        XCTAssertEqual(profile.model, "gpt-5")

        let reEncoded = profile.toJSON()
        XCTAssertEqual(reEncoded["provider_connection"] as? String, "personal-openai")
        // Snake_case must not bleed into a camelCase duplicate — the
        // preservedJSON exclusion list guards against that.
        XCTAssertNil(reEncoded["providerConnection"])
    }

    /// Empty strings should decode as `nil` (rather than getting written
    /// back as an empty key) so disabling the binding via the editor's
    /// "Any active connection" option doesn't leave a min(1)-violating
    /// value on disk that the daemon would reject at Zod parse time.
    func testProviderConnectionEmptyStringDecodesAsNil() {
        let json: [String: Any] = [
            "provider": "openai",
            "provider_connection": "",
        ]
        let profile = InferenceProfile(name: "draft", json: json)
        XCTAssertNil(profile.providerConnection)

        let reEncoded = profile.toJSON()
        XCTAssertNil(reEncoded["provider_connection"])
    }

    /// `merging` must propagate a new `providerConnection` (re-bind) and
    /// preserve the existing one when the fragment omits it (other-field
    /// edits shouldn't clear the binding).
    func testMergingProviderConnectionFromFragment() {
        let base = InferenceProfile(
            name: "personal",
            provider: "openai",
            providerConnection: "personal-openai",
            model: "gpt-5"
        )
        let rebind = InferenceProfile(name: "personal", providerConnection: "work-openai")

        let merged = base.merging(rebind)

        XCTAssertEqual(merged.providerConnection, "work-openai")
        XCTAssertEqual(merged.provider, "openai")
        XCTAssertEqual(merged.model, "gpt-5")
    }

    func testMergingPreservesProviderConnectionWhenFragmentOmitsIt() {
        let base = InferenceProfile(
            name: "personal",
            provider: "openai",
            providerConnection: "personal-openai"
        )
        let modelOnly = InferenceProfile(name: "personal", model: "gpt-5")

        let merged = base.merging(modelOnly)

        XCTAssertEqual(merged.providerConnection, "personal-openai")
        XCTAssertEqual(merged.model, "gpt-5")
    }
}
