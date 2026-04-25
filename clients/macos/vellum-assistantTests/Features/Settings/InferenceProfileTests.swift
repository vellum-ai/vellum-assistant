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
        XCTAssertNil(profile.temperature)
        XCTAssertNil(profile.thinkingEnabled)
        XCTAssertNil(profile.thinkingStreamThinking)
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

    func testUnknownKeysAreIgnored() {
        let json: [String: Any] = [
            "provider": "anthropic",
            "totallyUnknown": "ignored",
            "thinking": [
                "enabled": true,
                "alsoUnknown": 123,
            ],
        ]
        let profile = InferenceProfile(name: "extra", json: json)
        XCTAssertEqual(profile.provider, "anthropic")
        XCTAssertEqual(profile.thinkingEnabled, true)
        XCTAssertNil(profile.thinkingStreamThinking)
    }

    // MARK: - Identifiable

    func testIdReturnsName() {
        let profile = InferenceProfile(name: "balanced")
        XCTAssertEqual(profile.id, "balanced")
    }

    // MARK: - BuiltInInferenceProfile

    func testBuiltInProfileNames() {
        XCTAssertEqual(BuiltInInferenceProfile.qualityOptimized.rawValue, "quality-optimized")
        XCTAssertEqual(BuiltInInferenceProfile.balanced.rawValue, "balanced")
        XCTAssertEqual(BuiltInInferenceProfile.costOptimized.rawValue, "cost-optimized")
    }

    func testBuiltInAllNamesContainsEveryCase() {
        XCTAssertEqual(
            BuiltInInferenceProfile.allNames,
            ["quality-optimized", "balanced", "cost-optimized"]
        )
        XCTAssertEqual(BuiltInInferenceProfile.allNames.count, BuiltInInferenceProfile.allCases.count)
    }
}
