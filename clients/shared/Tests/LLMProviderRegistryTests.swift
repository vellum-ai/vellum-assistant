import XCTest
@testable import VellumAssistantShared

final class LLMProviderRegistryTests: XCTestCase {

    func testFallbackContainsExpectedProvidersInOrder() {
        let ids = LLMProviderRegistry.providers.map(\.id)
        XCTAssertEqual(
            ids,
            ["anthropic", "openai", "gemini", "ollama", "fireworks", "openrouter"]
        )
    }

    func testFallbackHasSixProviders() {
        XCTAssertEqual(LLMProviderRegistry.providers.count, 6)
    }

    func testDefaultProviderIsAnthropic() {
        XCTAssertEqual(LLMProviderRegistry.defaultProvider?.id, "anthropic")
    }

    func testEachProviderDefaultModelAppearsInModels() {
        for provider in LLMProviderRegistry.providers {
            let modelIds = provider.models.map(\.id)
            XCTAssertTrue(
                modelIds.contains(provider.defaultModel),
                "Provider \(provider.id) defaultModel \(provider.defaultModel) not found in models \(modelIds)"
            )
        }
    }

    func testGeminiFallbackModelsIncludeGemini3BeforeGemini25() {
        guard let gemini = LLMProviderRegistry.provider(id: "gemini") else {
            return XCTFail("Expected Gemini provider in fallback catalog")
        }

        XCTAssertEqual(gemini.defaultModel, "gemini-2.5-flash")
        XCTAssertFalse(gemini.models.map(\.id).contains("gemini-3-pro-preview"))
        XCTAssertEqual(
            Array(gemini.models.prefix(7).map(\.id)),
            [
                "gemini-3.1-pro-preview",
                "gemini-3.1-pro-preview-customtools",
                "gemini-3-flash-preview",
                "gemini-3.1-flash-lite-preview",
                "gemini-2.5-flash",
                "gemini-2.5-flash-lite",
                "gemini-2.5-pro",
            ]
        )
    }

    func testProviderLookupReturnsExpectedEntry() {
        let openai = LLMProviderRegistry.provider(id: "openai")
        XCTAssertNotNil(openai)
        XCTAssertEqual(openai?.displayName, "OpenAI")
        XCTAssertEqual(openai?.setupMode, .apiKey)
        XCTAssertEqual(openai?.envVar, "OPENAI_API_KEY")
        XCTAssertEqual(openai?.defaultModel, "gpt-5.5")

        let ollama = LLMProviderRegistry.provider(id: "ollama")
        XCTAssertNotNil(ollama)
        XCTAssertEqual(ollama?.setupMode, .keyless)
        XCTAssertNil(ollama?.envVar)
        XCTAssertNil(ollama?.apiKeyPlaceholder)
        XCTAssertNil(ollama?.credentialsGuide)
    }

    func testProviderLookupReturnsNilForUnknownId() {
        XCTAssertNil(LLMProviderRegistry.provider(id: "nonexistent-provider"))
    }

    func testModelLookupReturnsExpectedEntry() {
        let model = LLMProviderRegistry.model(provider: "anthropic", id: "claude-opus-4-7")
        XCTAssertNotNil(model)
        XCTAssertEqual(model?.displayName, "Claude Opus 4.7")
    }

    func testModelLookupReturnsNilForUnknownModel() {
        XCTAssertNil(LLMProviderRegistry.model(provider: "anthropic", id: "nonexistent-model"))
    }

    func testAPIKeyProvidersHavePlaceholderAndGuide() {
        let apiKeyProviders = LLMProviderRegistry.providers.filter { $0.setupMode == .apiKey }
        for provider in apiKeyProviders {
            XCTAssertNotNil(
                provider.apiKeyPlaceholder,
                "api-key provider \(provider.id) is missing apiKeyPlaceholder"
            )
            XCTAssertNotNil(
                provider.credentialsGuide,
                "api-key provider \(provider.id) is missing credentialsGuide"
            )
            XCTAssertNotNil(
                provider.envVar,
                "api-key provider \(provider.id) is missing envVar"
            )
        }
    }
}
