#if canImport(UIKit)
import XCTest

@testable import VellumAssistantShared

/// Tests verifying that the iOS STT provider selector works correctly
/// with the shared ``STTProviderRegistry``.
final class STTProviderRegistryIOSTests: XCTestCase {

    // MARK: - Registry Loading

    func testRegistryLoadsNonEmptyProviderList() {
        let registry = loadSTTProviderRegistry()
        XCTAssertFalse(registry.providers.isEmpty, "Registry should contain at least one provider")
    }

    func testRegistryContainsOpenAIWhisper() {
        let registry = loadSTTProviderRegistry()
        let entry = registry.provider(withId: "openai-whisper")
        XCTAssertNotNil(entry, "Registry should contain an 'openai-whisper' provider")
        XCTAssertEqual(entry?.displayName, "OpenAI Whisper")
    }

    // MARK: - Provider Lookup and Fallback

    func testProviderLookupReturnsMatchingEntry() {
        let registry = loadSTTProviderRegistry()
        for provider in registry.providers {
            let found = registry.provider(withId: provider.id)
            XCTAssertNotNil(found, "Lookup should find provider with id '\(provider.id)'")
            XCTAssertEqual(found?.id, provider.id)
        }
    }

    func testProviderLookupReturnsNilForUnknownId() {
        let registry = loadSTTProviderRegistry()
        let result = registry.provider(withId: "nonexistent-provider-id")
        XCTAssertNil(result, "Lookup should return nil for unknown provider IDs")
    }

    func testFallbackToFirstProviderForUnknownPersistedValue() {
        let registry = loadSTTProviderRegistry()
        // Simulate the fallback logic used in settings:
        // registry.provider(withId: raw) ?? registry.providers.first
        let unknownRaw = "deleted-provider"
        let resolved = registry.provider(withId: unknownRaw) ?? registry.providers.first
        XCTAssertNotNil(resolved, "Fallback should resolve to the first registry provider")
        XCTAssertEqual(resolved?.id, registry.providers.first?.id)
    }

    // MARK: - API Key Provider Name

    func testEveryEntryHasNonEmptyApiKeyProviderName() {
        let registry = loadSTTProviderRegistry()
        for provider in registry.providers {
            XCTAssertFalse(
                provider.apiKeyProviderName.isEmpty,
                "Provider '\(provider.id)' should have a non-empty apiKeyProviderName"
            )
        }
    }

    func testOpenAIWhisperMapsToOpenAICredentialProvider() {
        let registry = loadSTTProviderRegistry()
        let entry = registry.provider(withId: "openai-whisper")
        XCTAssertEqual(
            entry?.apiKeyProviderName, "openai",
            "openai-whisper should map to 'openai' credential provider"
        )
    }

    func testDeepgramMapsToDeepgramCredentialProvider() {
        let registry = loadSTTProviderRegistry()
        let entry = registry.provider(withId: "deepgram")
        XCTAssertEqual(
            entry?.apiKeyProviderName, "deepgram",
            "deepgram should map to 'deepgram' credential provider"
        )
    }

    // MARK: - Default Provider Selection

    func testDefaultProviderIdMatchesRegistryEntry() {
        let registry = loadSTTProviderRegistry()
        let defaultId = "openai-whisper" // matches the default STT provider in settings
        let entry = registry.provider(withId: defaultId)
        XCTAssertNotNil(entry, "Default provider ID '\(defaultId)' should exist in the registry")
    }
}
#endif
