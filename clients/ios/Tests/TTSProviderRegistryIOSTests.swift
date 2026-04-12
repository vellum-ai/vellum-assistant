#if canImport(UIKit)
import XCTest

@testable import VellumAssistantShared

/// Tests verifying that the iOS TTS provider selector works correctly
/// with the shared ``TTSProviderRegistry``.
final class TTSProviderRegistryIOSTests: XCTestCase {

    // MARK: - Registry Loading

    func testRegistryLoadsNonEmptyProviderList() {
        let registry = loadTTSProviderRegistry()
        XCTAssertFalse(registry.providers.isEmpty, "Registry should contain at least one provider")
    }

    func testRegistryContainsElevenLabs() {
        let registry = loadTTSProviderRegistry()
        let entry = registry.provider(withId: "elevenlabs")
        XCTAssertNotNil(entry, "Registry should contain an 'elevenlabs' provider")
        XCTAssertEqual(entry?.displayName, "ElevenLabs")
    }

    // MARK: - Provider Lookup and Fallback

    func testProviderLookupReturnsMatchingEntry() {
        let registry = loadTTSProviderRegistry()
        for provider in registry.providers {
            let found = registry.provider(withId: provider.id)
            XCTAssertNotNil(found, "Lookup should find provider with id '\(provider.id)'")
            XCTAssertEqual(found?.id, provider.id)
        }
    }

    func testProviderLookupReturnsNilForUnknownId() {
        let registry = loadTTSProviderRegistry()
        let result = registry.provider(withId: "nonexistent-provider-id")
        XCTAssertNil(result, "Lookup should return nil for unknown provider IDs")
    }

    func testFallbackToFirstProviderForUnknownPersistedValue() {
        let registry = loadTTSProviderRegistry()
        // Simulate the fallback logic used in VoiceSettingsSection:
        // registry.provider(withId: raw) ?? registry.providers.first
        let unknownRaw = "deleted-provider"
        let resolved = registry.provider(withId: unknownRaw) ?? registry.providers.first
        XCTAssertNotNil(resolved, "Fallback should resolve to the first registry provider")
        XCTAssertEqual(resolved?.id, registry.providers.first?.id)
    }

    // MARK: - Setup Mode Filtering

    func testProvidersFilteredBySetupMode() {
        let registry = loadTTSProviderRegistry()
        let cliProviders = registry.providers.filter { $0.setupMode == .cli }
        XCTAssertTrue(
            cliProviders.contains { $0.id == "elevenlabs" },
            "ElevenLabs should have CLI setup mode"
        )
    }

    func testCLIProvidersExcludedFromAPIKeyList() {
        let registry = loadTTSProviderRegistry()
        let cliProviders = registry.providers.filter { $0.setupMode == .cli }
        let apiKeyProviders = registry.providers.filter { $0.setupMode == .apiKey }
        // CLI providers should not appear in the api-key filtered list
        for cliProvider in cliProviders {
            XCTAssertFalse(
                apiKeyProviders.contains { $0.id == cliProvider.id },
                "CLI provider '\(cliProvider.id)' should not appear in apiKey-filtered list"
            )
        }
    }

    // MARK: - Default Provider Selection

    func testDefaultProviderIdMatchesRegistryEntry() {
        let registry = loadTTSProviderRegistry()
        let defaultId = "elevenlabs" // matches the @AppStorage default in VoiceSettingsSection
        let entry = registry.provider(withId: defaultId)
        XCTAssertNotNil(entry, "Default provider ID '\(defaultId)' should exist in the registry")
    }
}
#endif
