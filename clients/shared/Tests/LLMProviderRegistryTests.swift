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

    func testProviderLookupReturnsExpectedEntry() {
        let openai = LLMProviderRegistry.provider(id: "openai")
        XCTAssertNotNil(openai)
        XCTAssertEqual(openai?.displayName, "OpenAI")
        XCTAssertEqual(openai?.setupMode, .apiKey)
        XCTAssertEqual(openai?.envVar, "OPENAI_API_KEY")

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
