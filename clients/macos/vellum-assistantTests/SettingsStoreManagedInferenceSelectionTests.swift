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

    // MARK: - isPlatformCapable

    func testAnthropicIsManagedCapable() {
        XCTAssertTrue(store.isPlatformCapable("anthropic"))
    }

    func testOpenAIIsManagedCapable() {
        XCTAssertTrue(store.isPlatformCapable("openai"))
    }

    func testGeminiIsManagedCapable() {
        XCTAssertTrue(store.isPlatformCapable("gemini"))
    }

    func testOllamaIsNotManagedCapable() {
        XCTAssertFalse(store.isPlatformCapable("ollama"))
    }

    func testFireworksIsManagedCapable() {
        XCTAssertTrue(store.isPlatformCapable("fireworks"))
    }

    func testOpenRouterIsNotManagedCapable() {
        XCTAssertFalse(store.isPlatformCapable("openrouter"))
    }

    func testUnknownProviderIsNotManagedCapable() {
        XCTAssertFalse(store.isPlatformCapable("unknown-provider"))
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

    // MARK: - platformCapableProviders

    func testManagedCapableProvidersContainsExpectedEntries() {
        let ids = store.platformCapableProviders.map(\.id)
        XCTAssertTrue(ids.contains("anthropic"), "expected anthropic in managed-capable providers")
        XCTAssertTrue(ids.contains("openai"), "expected openai in managed-capable providers")
        XCTAssertTrue(ids.contains("gemini"), "expected gemini in managed-capable providers")
        XCTAssertTrue(ids.contains("fireworks"), "expected fireworks in managed-capable providers")
    }

    func testManagedCapableProvidersExcludesNonManagedEntries() {
        let ids = store.platformCapableProviders.map(\.id)
        XCTAssertFalse(ids.contains("ollama"), "ollama should not be in managed-capable providers")
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

        // Simulate selecting OpenAI as the inference provider
        testStore.selectedInferenceProvider = "openai"

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

    func testManagedWebSearchModeRestoresProviderNativePreference() {
        let mockClient = MockSettingsClient()
        mockClient.patchConfigResponse = true
        let testStore = SettingsStore(settingsClient: mockClient)
        testStore.webSearchMode = "your-own"
        testStore.webSearchProvider = "brave"

        _ = testStore.setWebSearchMode("managed")

        XCTAssertEqual(testStore.webSearchMode, "managed")
        XCTAssertEqual(testStore.webSearchProvider, "inference-provider-native")

        let predicate = NSPredicate { _, _ in
            mockClient.patchConfigCalls.count >= 1
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        let webSearchPatches = mockClient.patchConfigCalls.compactMap { call -> [String: String]? in
            guard let services = call["services"] as? [String: Any],
                  let webSearch = services["web-search"] as? [String: String] else {
                return nil
            }
            return webSearch
        }
        XCTAssertTrue(
            webSearchPatches.contains([
                "mode": "managed",
                "provider": "inference-provider-native",
            ]),
            "expected managed web search save to restore provider-native preference, got: \(webSearchPatches)"
        )
    }

    // MARK: - Managed Provider + Native Web Search Capability Gating

    func testManagedOpenAIPlusProviderNativeIsValid() {
        // OpenAI is both managed-capable and native-web-search-capable,
        // so managed inference + inference-provider-native should be allowed.
        XCTAssertTrue(store.isPlatformCapable("openai"))
        XCTAssertTrue(store.isNativeWebSearchCapable("openai", model: "gpt-5"))
    }

    func testManagedAnthropicPlusProviderNativeIsValid() {
        // Anthropic is both managed-capable and native-web-search-capable.
        XCTAssertTrue(store.isPlatformCapable("anthropic"))
        XCTAssertTrue(store.isNativeWebSearchCapable("anthropic", model: "claude-opus-4.7"))
    }

    func testManagedGeminiPlusProviderNativeUsesAppExecutedFallback() {
        // Gemini is managed-capable but NOT native-web-search-capable. Managed
        // mode can still provide web search through the app-executed platform
        // search proxy instead of requiring a BYOK search provider.
        XCTAssertTrue(store.isPlatformCapable("gemini"))
        XCTAssertFalse(store.isNativeWebSearchCapable("gemini", model: "gemini-2.5-pro"))
    }

    func testManagedFireworksKimiPlusProviderNativeUsesAppExecutedFallback() {
        // Fireworks/Kimi is managed-capable but not native-web-search-capable.
        // That distinction means the daemon should keep the custom web_search
        // tool available and execute it through managed Brave in managed mode.
        XCTAssertTrue(store.isPlatformCapable("fireworks"))
        XCTAssertFalse(store.isNativeWebSearchCapable("fireworks", model: "accounts/fireworks/models/kimi-k2p6"))
    }

    func testManagedOpenAIProviderNativeWebSearchCanBePersisted() {
        let mockClient = MockSettingsClient()
        mockClient.patchConfigResponse = true
        let testStore = SettingsStore(settingsClient: mockClient)

        // Configure OpenAI inference + provider-native web search
        testStore.selectedInferenceProvider = "openai"
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

    func testNonNativeWebSearchCapabilityDoesNotMeanManagedWebSearchUnavailable() {
        // Native capability only describes provider-hosted web search. Managed
        // platform-capable providers can still use app-executed managed search.
        XCTAssertFalse(store.isNativeWebSearchCapable("gemini", model: "gemini-2.5-pro"))
        XCTAssertFalse(store.isNativeWebSearchCapable("ollama", model: "llama3"))
        XCTAssertFalse(store.isNativeWebSearchCapable("fireworks", model: "accounts/fireworks/models/kimi-k2"))
        // OpenRouter with a non-anthropic model is not native-web-search-capable.
        XCTAssertFalse(store.isNativeWebSearchCapable("openrouter", model: "openai/gpt-5"))
        XCTAssertTrue(store.isPlatformCapable("gemini"))
        XCTAssertTrue(store.isPlatformCapable("fireworks"))
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
