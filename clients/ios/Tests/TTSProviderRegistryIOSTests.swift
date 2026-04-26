#if canImport(UIKit)
import XCTest

@testable import VellumAssistantShared

/// Tests verifying that the TTS provider registry types decode correctly
/// and the lookup/fallback logic works as expected.
final class TTSProviderRegistryIOSTests: XCTestCase {

    // MARK: - Helpers

    private func buildTestRegistry() -> TTSProviderRegistry {
        let json = """
        {
            "providers": [
                {
                    "id": "elevenlabs",
                    "displayName": "ElevenLabs",
                    "subtitle": "High-quality voice synthesis.",
                    "setupMode": "cli",
                    "setupHint": "Run setup commands.",
                    "credentialMode": "credential",
                    "credentialNamespace": "elevenlabs",
                    "supportsVoiceSelection": true,
                    "credentialsGuide": {
                        "description": "Sign in to ElevenLabs.",
                        "url": "https://elevenlabs.io/app/settings/api-keys",
                        "linkLabel": "Open ElevenLabs API Keys"
                    }
                },
                {
                    "id": "deepgram",
                    "displayName": "Deepgram",
                    "subtitle": "Fast TTS synthesis.",
                    "setupMode": "cli",
                    "setupHint": "Run setup command.",
                    "credentialMode": "api-key",
                    "apiKeyProviderName": "deepgram",
                    "supportsVoiceSelection": false,
                    "credentialsGuide": {
                        "description": "Sign in to Deepgram.",
                        "url": "https://console.deepgram.com/",
                        "linkLabel": "Open Deepgram Console"
                    }
                }
            ]
        }
        """
        return try! JSONDecoder().decode(TTSProviderRegistry.self, from: json.data(using: .utf8)!)
    }

    // MARK: - Decoding

    func testRegistryDecodesFromJSON() {
        let registry = buildTestRegistry()
        XCTAssertEqual(registry.providers.count, 2)
    }

    func testProviderFieldsDecodeCorrectly() {
        let registry = buildTestRegistry()
        let entry = registry.provider(withId: "elevenlabs")
        XCTAssertNotNil(entry)
        XCTAssertEqual(entry?.displayName, "ElevenLabs")
        XCTAssertEqual(entry?.setupMode, .cli)
        XCTAssertEqual(entry?.credentialMode, .credential)
        XCTAssertEqual(entry?.credentialNamespace, "elevenlabs")
        XCTAssertTrue(entry?.supportsVoiceSelection == true)
    }

    func testApiKeyProviderDecodes() {
        let registry = buildTestRegistry()
        let entry = registry.provider(withId: "deepgram")
        XCTAssertNotNil(entry)
        XCTAssertEqual(entry?.credentialMode, .apiKey)
        XCTAssertEqual(entry?.apiKeyProviderName, "deepgram")
        XCTAssertFalse(entry?.supportsVoiceSelection == true)
    }

    // MARK: - Lookup

    func testProviderLookupReturnsMatchingEntry() {
        let registry = buildTestRegistry()
        for provider in registry.providers {
            let found = registry.provider(withId: provider.id)
            XCTAssertNotNil(found)
            XCTAssertEqual(found?.id, provider.id)
        }
    }

    func testProviderLookupReturnsNilForUnknownId() {
        let registry = buildTestRegistry()
        let result = registry.provider(withId: "nonexistent-provider-id")
        XCTAssertNil(result)
    }

    func testFallbackToFirstProviderForUnknownPersistedValue() {
        let registry = buildTestRegistry()
        let unknownRaw = "deleted-provider"
        let resolved = registry.provider(withId: unknownRaw) ?? registry.providers.first
        XCTAssertNotNil(resolved)
        XCTAssertEqual(resolved?.id, registry.providers.first?.id)
    }

    // MARK: - supportsVoiceSelection default

    func testSupportsVoiceSelectionDefaultsToFalse() {
        let json = """
        {
            "providers": [{
                "id": "test",
                "displayName": "Test",
                "subtitle": "Test provider.",
                "setupMode": "cli",
                "setupHint": "Test.",
                "credentialMode": "credential",
                "credentialNamespace": "test"
            }]
        }
        """
        let registry = try! JSONDecoder().decode(TTSProviderRegistry.self, from: json.data(using: .utf8)!)
        XCTAssertFalse(registry.providers[0].supportsVoiceSelection)
    }
}
#endif
