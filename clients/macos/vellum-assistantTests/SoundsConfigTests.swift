import XCTest
@testable import VellumAssistantLib

final class SoundsConfigTests: XCTestCase {

    // MARK: - Helpers

    private func decode(_ json: String) throws -> SoundEventConfig {
        let data = Data(json.utf8)
        return try JSONDecoder().decode(SoundEventConfig.self, from: data)
    }

    private func decodeTopLevel(_ json: String) throws -> SoundsConfig {
        let data = Data(json.utf8)
        return try JSONDecoder().decode(SoundsConfig.self, from: data)
    }

    private func encode(_ config: SoundEventConfig) throws -> [String: Any] {
        let data = try JSONEncoder().encode(config)
        let obj = try JSONSerialization.jsonObject(with: data)
        guard let dict = obj as? [String: Any] else {
            XCTFail("Encoded SoundEventConfig is not a JSON object")
            return [:]
        }
        return dict
    }

    // MARK: - Legacy decode

    func test_legacyDecode_singleSound_populatesPool() throws {
        let config = try decode(#"{"enabled": true, "sound": "gentle.aiff"}"#)
        XCTAssertTrue(config.enabled)
        XCTAssertEqual(config.sounds, ["gentle.aiff"])
        XCTAssertEqual(config.sound, "gentle.aiff")
    }

    func test_legacyDecode_explicitNull_emptyPool() throws {
        let config = try decode(#"{"enabled": true, "sound": null}"#)
        XCTAssertTrue(config.enabled)
        XCTAssertEqual(config.sounds, [])
        XCTAssertNil(config.sound)
    }

    func test_legacyDecode_missingField_emptyPool() throws {
        let config = try decode(#"{"enabled": false}"#)
        XCTAssertFalse(config.enabled)
        XCTAssertEqual(config.sounds, [])
    }

    // MARK: - New decode

    func test_newDecode_multiSoundPool_preservesOrder() throws {
        let config = try decode(#"{"enabled": true, "sounds": ["a.wav", "b.wav", "c.wav"]}"#)
        XCTAssertTrue(config.enabled)
        XCTAssertEqual(config.sounds, ["a.wav", "b.wav", "c.wav"])
    }

    // MARK: - Encode shape

    func test_encode_writesSoundsKey_omitsLegacySoundKey() throws {
        let config = SoundEventConfig(enabled: true, sounds: ["a.wav"])
        let dict = try encode(config)

        XCTAssertEqual(dict["enabled"] as? Bool, true)
        XCTAssertEqual(dict["sounds"] as? [String], ["a.wav"])
        XCTAssertNil(dict["sound"], "Legacy 'sound' key should not be written by the encoder")
    }

    // MARK: - Roundtrip

    func test_roundtrip_multiSound_preservesEquality() throws {
        let original = SoundEventConfig(enabled: true, sounds: ["a.wav", "b.wav", "c.wav"])
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(SoundEventConfig.self, from: data)
        XCTAssertEqual(decoded, original)
    }

    // MARK: - Shim setter

    func test_shimSetter_nonNil_replacesPool() {
        var config = SoundEventConfig(enabled: true, sounds: [])
        config.sound = "x.wav"
        XCTAssertEqual(config.sounds, ["x.wav"])
    }

    func test_shimSetter_nil_clearsPool() {
        var config = SoundEventConfig(enabled: true, sounds: ["a.wav", "b.wav"])
        config.sound = nil
        XCTAssertEqual(config.sounds, [])
    }

    // MARK: - Top-level decode

    func test_topLevelDecode_legacyPayload_eachEventResolvesToSoundsArray() throws {
        // Matches the "Config shape reference" section in skills/vellum-sounds/SKILL.md.
        let json = #"""
        {
          "globalEnabled": false,
          "volume": 0.7,
          "events": {
            "app_open":         { "enabled": false, "sound": null },
            "task_complete":    { "enabled": true,  "sound": "ding.aiff" },
            "needs_input":      { "enabled": false, "sound": null },
            "task_failed":      { "enabled": false, "sound": null },
            "notification":     { "enabled": false, "sound": null },
            "new_conversation": { "enabled": false, "sound": null },
            "message_sent":     { "enabled": true,  "sound": "whoosh.wav" },
            "character_poke":   { "enabled": false, "sound": null },
            "random":           { "enabled": false, "sound": null }
          }
        }
        """#
        let config = try decodeTopLevel(json)

        XCTAssertFalse(config.globalEnabled)
        XCTAssertEqual(config.volume, Float(0.7))

        for event in SoundEvent.allCases {
            let eventConfig = config.config(for: event)
            // Every event must resolve to the new `sounds` array shape.
            switch event {
            case .taskComplete:
                XCTAssertEqual(eventConfig.sounds, ["ding.aiff"])
                XCTAssertTrue(eventConfig.enabled)
            case .messageSent:
                XCTAssertEqual(eventConfig.sounds, ["whoosh.wav"])
                XCTAssertTrue(eventConfig.enabled)
            default:
                XCTAssertEqual(eventConfig.sounds, [], "\(event.rawValue) should have empty pool")
                XCTAssertFalse(eventConfig.enabled)
            }
        }
    }

    // MARK: - Empty-string defense

    func test_decode_dropsEmptyStringEntries() throws {
        let config = try decode(#"{"enabled": true, "sounds": ["", "x.wav"]}"#)
        XCTAssertTrue(config.enabled)
        XCTAssertEqual(config.sounds, ["x.wav"])
    }

    // MARK: - pickSoundFilename

    @MainActor
    func test_pickSoundFilename_emptyPool_returnsNil() {
        let result = SoundManager.shared.pickSoundFilename(from: [])
        XCTAssertNil(result)
    }

    @MainActor
    func test_pickSoundFilename_singleEntry_returnsThatEntry() {
        let result = SoundManager.shared.pickSoundFilename(from: ["solo.wav"])
        XCTAssertEqual(result, "solo.wav")
    }

    @MainActor
    func test_pickSoundFilename_filtersInvalidEntry() {
        // "bad.xyz" fails the extension check; "good.wav" is the only valid entry,
        // so the random pick is deterministic.
        let result = SoundManager.shared.pickSoundFilename(from: ["bad.xyz", "good.wav"])
        XCTAssertEqual(result, "good.wav")
    }

    @MainActor
    func test_pickSoundFilename_allInvalid_returnsNil() {
        let result = SoundManager.shared.pickSoundFilename(from: ["a.xyz", "b.exe"])
        XCTAssertNil(result)
    }

    @MainActor
    func test_pickSoundFilename_multiValidPool_returnsEntryFromPool() {
        let pool = ["a.wav", "b.wav"]
        var seen: Set<String> = []
        for _ in 0..<20 {
            guard let picked = SoundManager.shared.pickSoundFilename(from: pool) else {
                XCTFail("pickSoundFilename returned nil for a valid pool")
                return
            }
            XCTAssertTrue(pool.contains(picked), "Picked '\(picked)' is not in the input pool")
            seen.insert(picked)
        }
        // With a uniform random pick across two entries, the probability of
        // seeing only one entry after 20 tries is 2 * (1/2)^20 ≈ 2^-19, which
        // is small enough that a failure indicates a real bug rather than flake.
        XCTAssertEqual(seen, Set(pool), "Expected both entries to be selected at least once across 20 picks")
    }
}
