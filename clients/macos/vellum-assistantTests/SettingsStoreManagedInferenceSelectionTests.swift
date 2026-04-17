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
        XCTAssertTrue(store.isNativeWebSearchCapable("anthropic"))
    }

    func testOpenAIIsNativeWebSearchCapable() {
        XCTAssertTrue(store.isNativeWebSearchCapable("openai"))
    }

    func testGeminiIsNotNativeWebSearchCapable() {
        XCTAssertFalse(store.isNativeWebSearchCapable("gemini"))
    }

    func testOllamaIsNotNativeWebSearchCapable() {
        XCTAssertFalse(store.isNativeWebSearchCapable("ollama"))
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
        _ = testStore.setInferenceProvider("openai")

        // Wait for the async patch to be captured
        let predicate = NSPredicate { _, _ in
            mockClient.patchConfigCalls.count >= 1
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        // Verify the patched provider is "openai", not "anthropic"
        let providerPatches = mockClient.patchConfigCalls.compactMap { call -> String? in
            guard let services = call["services"] as? [String: Any],
                  let inference = services["inference"] as? [String: Any],
                  let provider = inference["provider"] as? String else {
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
        _ = testStore.setInferenceProvider("gemini")

        let predicate = NSPredicate { _, _ in
            mockClient.patchConfigCalls.count >= 1
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: 2.0)

        let providerPatches = mockClient.patchConfigCalls.compactMap { call -> String? in
            guard let services = call["services"] as? [String: Any],
                  let inference = services["inference"] as? [String: Any],
                  let provider = inference["provider"] as? String else {
                return nil
            }
            return provider
        }
        XCTAssertTrue(providerPatches.contains("gemini"),
                       "expected gemini to be persisted as the inference provider, got: \(providerPatches)")
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
