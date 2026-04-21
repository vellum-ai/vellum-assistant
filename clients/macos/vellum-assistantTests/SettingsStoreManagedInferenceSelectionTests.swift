import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Tests for SettingsStore provider capability helpers and managed-mode
/// provider selection behavior.
@MainActor
final class SettingsStoreManagedInferenceSelectionTests: XCTestCase {

    private var store: SettingsStore!

    override func setUp() {
        super.setUp()
        store = SettingsStore(settingsClient: MockSettingsClient())
    }

    override func tearDown() {
        store = nil
        super.tearDown()
    }

    // MARK: - isManagedCapable

    func testAnthropicIsManagedCapable() {
        XCTAssertTrue(store.isManagedCapable("anthropic"))
    }

    func testOpenAIIsManagedCapable() {
        XCTAssertTrue(store.isManagedCapable("openai"))
    }

    func testGeminiIsManagedCapable() {
        XCTAssertTrue(store.isManagedCapable("gemini"))
    }

    func testOllamaIsNotManagedCapable() {
        XCTAssertFalse(store.isManagedCapable("ollama"))
    }

    func testFireworksIsNotManagedCapable() {
        XCTAssertFalse(store.isManagedCapable("fireworks"))
    }

    func testOpenRouterIsNotManagedCapable() {
        XCTAssertFalse(store.isManagedCapable("openrouter"))
    }

    func testUnknownProviderIsNotManagedCapable() {
        XCTAssertFalse(store.isManagedCapable("unknown-provider"))
    }

    // MARK: - isNativeWebSearchCapable

    func testAnthropicIsNativeWebSearchCapable() {
        XCTAssertTrue(store.isNativeWebSearchCapable("anthropic", model: "claude-opus-4.7"))
    }

    func testOpenAIIsNativeWebSearchCapable() {
        XCTAssertTrue(store.isNativeWebSearchCapable("openai", model: "gpt-5"))
    }

    func testGeminiIsNotNativeWebSearchCapable() {
        XCTAssertFalse(store.isNativeWebSearchCapable("gemini", model: "gemini-2.5-pro"))
    }

    func testOllamaIsNotNativeWebSearchCapable() {
        XCTAssertFalse(store.isNativeWebSearchCapable("ollama", model: "llama3"))
    }

    func testOpenRouterWithAnthropicModelIsNativeWebSearchCapable() {
        // OpenRouter routes `anthropic/*` models through the Anthropic-compat
        // endpoint, which supports Anthropic's native web_search tool.
        XCTAssertTrue(store.isNativeWebSearchCapable("openrouter", model: "anthropic/claude-opus-4.7"))
        XCTAssertTrue(store.isNativeWebSearchCapable("openrouter", model: "anthropic/claude-sonnet-4.6"))
    }

    func testOpenRouterWithNonAnthropicModelIsNotNativeWebSearchCapable() {
        XCTAssertFalse(store.isNativeWebSearchCapable("openrouter", model: "openai/gpt-5"))
        XCTAssertFalse(store.isNativeWebSearchCapable("openrouter", model: "x-ai/grok-4"))
        XCTAssertFalse(store.isNativeWebSearchCapable("openrouter", model: ""))
    }

    // MARK: - managedCapableProviders

    func testManagedCapableProvidersContainsExpectedEntries() {
        let ids = store.managedCapableProviders.map(\.id)
        XCTAssertTrue(ids.contains("anthropic"), "expected anthropic in managed-capable providers")
        XCTAssertTrue(ids.contains("openai"), "expected openai in managed-capable providers")
        XCTAssertTrue(ids.contains("gemini"), "expected gemini in managed-capable providers")
    }

    func testManagedCapableProvidersExcludesNonManagedEntries() {
        let ids = store.managedCapableProviders.map(\.id)
        XCTAssertFalse(ids.contains("ollama"), "ollama should not be in managed-capable providers")
        XCTAssertFalse(ids.contains("fireworks"), "fireworks should not be in managed-capable providers")
        XCTAssertFalse(ids.contains("openrouter"), "openrouter should not be in managed-capable providers")
    }

    // MARK: - nativeWebSearchCapableProviders

    func testNativeWebSearchCapableProvidersContainsExpectedEntries() {
        let ids = store.nativeWebSearchCapableProviders.map(\.id)
        XCTAssertTrue(ids.contains("anthropic"), "expected anthropic in native-web-search-capable providers")
        XCTAssertTrue(ids.contains("openai"), "expected openai in native-web-search-capable providers")
    }

    func testNativeWebSearchCapableProvidersExcludesOthers() {
        let ids = store.nativeWebSearchCapableProviders.map(\.id)
        XCTAssertFalse(ids.contains("gemini"), "gemini should not be in native-web-search-capable providers")
        XCTAssertFalse(ids.contains("ollama"), "ollama should not be in native-web-search-capable providers")
    }

    // MARK: - Managed Provider Persistence

    func testManagedModeCanPersistOpenAIAsProvider() {
        let mockClient = MockSettingsClient()
        mockClient.patchConfigResponse = true
        let testStore = SettingsStore(settingsClient: mockClient)

        // Simulate selecting OpenAI in managed mode
        testStore.selectedInferenceProvider = "openai"
        testStore.inferenceMode = "managed"

        // Persist the provider selection
        _ = testStore.setLLMDefaultProvider("openai")

        // Wait for the async patch to be captured
        let predicate = NSPredicate { _, _ in
            mockClient.patchConfigCalls.count >= 1
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        // Verify the patched provider is "openai", not "anthropic"
        let providerPatches = mockClient.patchConfigCalls.compactMap { call -> String? in
            guard let llm = call["llm"] as? [String: Any],
                  let defaults = llm["default"] as? [String: Any],
                  let provider = defaults["provider"] as? String else {
                return nil
            }
            return provider
        }
        XCTAssertTrue(providerPatches.contains("openai"),
                       "expected openai to be persisted as the inference provider, got: \(providerPatches)")
    }

    func testManagedModeCanPersistGeminiAsProvider() {
        let mockClient = MockSettingsClient()
        mockClient.patchConfigResponse = true
        let testStore = SettingsStore(settingsClient: mockClient)

        testStore.selectedInferenceProvider = "gemini"
        testStore.inferenceMode = "managed"
        _ = testStore.setLLMDefaultProvider("gemini")

        let predicate = NSPredicate { _, _ in
            mockClient.patchConfigCalls.count >= 1
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        let providerPatches = mockClient.patchConfigCalls.compactMap { call -> String? in
            guard let llm = call["llm"] as? [String: Any],
                  let defaults = llm["default"] as? [String: Any],
                  let provider = defaults["provider"] as? String else {
                return nil
            }
            return provider
        }
        XCTAssertTrue(providerPatches.contains("gemini"),
                       "expected gemini to be persisted as the inference provider, got: \(providerPatches)")
    }

    // MARK: - Managed Provider + Native Web Search Capability Gating

    func testManagedOpenAIPlusProviderNativeIsValid() {
        // OpenAI is both managed-capable and native-web-search-capable,
        // so managed inference + inference-provider-native should be allowed.
        XCTAssertTrue(store.isManagedCapable("openai"))
        XCTAssertTrue(store.isNativeWebSearchCapable("openai", model: "gpt-5"))
    }

    func testManagedAnthropicPlusProviderNativeIsValid() {
        // Anthropic is both managed-capable and native-web-search-capable.
        XCTAssertTrue(store.isManagedCapable("anthropic"))
        XCTAssertTrue(store.isNativeWebSearchCapable("anthropic", model: "claude-opus-4.7"))
    }

    func testManagedGeminiPlusProviderNativeIsInvalid() {
        // Gemini is managed-capable but NOT native-web-search-capable,
        // so managed Gemini + inference-provider-native should be rejected.
        XCTAssertTrue(store.isManagedCapable("gemini"))
        XCTAssertFalse(store.isNativeWebSearchCapable("gemini", model: "gemini-2.5-pro"))
    }

    func testManagedOpenAIProviderNativeWebSearchCanBePersisted() {
        let mockClient = MockSettingsClient()
        mockClient.patchConfigResponse = true
        let testStore = SettingsStore(settingsClient: mockClient)

        // Configure managed OpenAI inference + provider-native web search
        testStore.selectedInferenceProvider = "openai"
        testStore.inferenceMode = "managed"
        testStore.webSearchProvider = "inference-provider-native"

        // Persist the web search provider
        testStore.setWebSearchProvider("inference-provider-native")

        let predicate = NSPredicate { _, _ in
            mockClient.patchConfigCalls.count >= 1
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        // Verify inference-provider-native was persisted (not rewritten to perplexity)
        let webSearchPatches = mockClient.patchConfigCalls.compactMap { call -> String? in
            guard let services = call["services"] as? [String: Any],
                  let webSearch = services["web-search"] as? [String: Any],
                  let provider = webSearch["provider"] as? String else {
                return nil
            }
            return provider
        }
        XCTAssertTrue(webSearchPatches.contains("inference-provider-native"),
                       "expected inference-provider-native to be persisted with managed OpenAI, got: \(webSearchPatches)")
    }

    func testNonNativeWebSearchCapableProviderFallsBackToPerplexity() {
        // When the inference provider doesn't support native web search,
        // isNativeWebSearchCapable should return false, indicating the UI
        // should enforce fallback to perplexity or brave.
        XCTAssertFalse(store.isNativeWebSearchCapable("gemini", model: "gemini-2.5-pro"))
        XCTAssertFalse(store.isNativeWebSearchCapable("ollama", model: "llama3"))
        XCTAssertFalse(store.isNativeWebSearchCapable("fireworks", model: "accounts/fireworks/models/kimi-k2"))
        // OpenRouter with a non-anthropic model is not native-web-search-capable.
        XCTAssertFalse(store.isNativeWebSearchCapable("openrouter", model: "openai/gpt-5"))
    }

    // MARK: - Model Validation Against Selected Provider

    func testOpenAIModelsAreAvailableForOpenAIProvider() {
        let models = store.dynamicProviderModels("openai")
        XCTAssertFalse(models.isEmpty, "expected OpenAI to have models in the default catalog")
        // Verify these are OpenAI models (not Anthropic)
        let modelIds = models.map(\.id)
        XCTAssertTrue(modelIds.allSatisfy { !$0.hasPrefix("claude-") },
                       "OpenAI models should not contain claude model IDs")
    }

    func testAnthropicModelsAreAvailableForAnthropicProvider() {
        let models = store.dynamicProviderModels("anthropic")
        XCTAssertFalse(models.isEmpty, "expected Anthropic to have models in the default catalog")
        let modelIds = models.map(\.id)
        XCTAssertTrue(modelIds.allSatisfy { $0.hasPrefix("claude-") },
                       "Anthropic models should all be claude models")
    }
}
