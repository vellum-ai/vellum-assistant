import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Verifies that `SettingsStore` reads inference provider/model from the
/// unified `llm.default.*` keys (with a fallback to `services.inference.*`
/// for unmigrated configs) and writes through the new
/// `setLLMDefaultProvider` / `setLLMDefaultModel` APIs.
@MainActor
final class SettingsStoreInferenceTests: XCTestCase {

    private var mockSettingsClient: MockSettingsClient!
    private var store: SettingsStore!

    override func setUp() {
        super.setUp()
        mockSettingsClient = MockSettingsClient()
        mockSettingsClient.patchConfigResponse = true
        store = SettingsStore(settingsClient: mockSettingsClient)
    }

    override func tearDown() {
        store = nil
        mockSettingsClient = nil
        super.tearDown()
    }

    // MARK: - Helpers

    /// Returns the most recent `llm.default` patch payload captured by the
    /// mock client, or `nil` if no such patch has been emitted.
    private func lastLLMDefaultPatch() -> [String: Any]? {
        for payload in mockSettingsClient.patchConfigCalls.reversed() {
            if let llm = payload["llm"] as? [String: Any],
               let defaultBlock = llm["default"] as? [String: Any] {
                return defaultBlock
            }
        }
        return nil
    }

    /// Returns the most recent `services.inference` patch payload captured
    /// by the mock client, or `nil` if no such patch has been emitted.
    private func lastServicesInferencePatch() -> [String: Any]? {
        for payload in mockSettingsClient.patchConfigCalls.reversed() {
            if let services = payload["services"] as? [String: Any],
               let inference = services["inference"] as? [String: Any] {
                return inference
            }
        }
        return nil
    }

    /// Waits for the background `Task` started by a store helper to flush
    /// its patch into the mock client.
    private func waitForPatchCount(_ expected: Int, timeout: TimeInterval = 2.0) {
        let predicate = NSPredicate { _, _ in
            self.mockSettingsClient.patchConfigCalls.count >= expected
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: timeout)
    }

    // MARK: - Read path: prefer llm.default.*

    /// When both `llm.default.*` and `services.inference.*` are present, the
    /// store must prefer `llm.default.*` — that is the canonical post-PR-4
    /// location and the one PR 19 will keep.
    func testLoadServiceModesPrefersLLMDefaultWhenBothPresent() {
        let config: [String: Any] = [
            "llm": [
                "default": [
                    "provider": "openai",
                    "model": "gpt-4.1"
                ]
            ],
            "services": [
                "inference": [
                    "provider": "anthropic",
                    "model": "claude-opus-4-6",
                    "mode": "your-own"
                ]
            ]
        ]

        store.loadServiceModes(config: config)

        XCTAssertEqual(
            store.selectedInferenceProvider,
            "openai",
            "loadServiceModes must prefer llm.default.provider over services.inference.provider"
        )
        XCTAssertEqual(
            store.selectedModel,
            "gpt-4.1",
            "loadServiceModes must prefer llm.default.model over services.inference.model"
        )
        XCTAssertEqual(
            store.inferenceMode,
            "your-own",
            "loadServiceModes must continue to read inferenceMode from services.inference.mode"
        )
    }

    /// When only `services.inference.*` is present (unmigrated config), the
    /// read path must fall back to it. The PR 4 workspace migration should
    /// have backfilled `llm.default.*` for existing users, but this fallback
    /// guards against the early-return cases (missing config.json, malformed
    /// JSON, fresh installs that missed the migration window).
    func testLoadServiceModesFallsBackToServicesInferenceWhenLLMDefaultAbsent() {
        let config: [String: Any] = [
            "services": [
                "inference": [
                    "provider": "anthropic",
                    "model": "claude-opus-4-6",
                    "mode": "managed"
                ]
            ]
        ]

        store.loadServiceModes(config: config)

        XCTAssertEqual(
            store.selectedInferenceProvider,
            "anthropic",
            "loadServiceModes must fall back to services.inference.provider when llm.default is absent"
        )
        XCTAssertEqual(
            store.selectedModel,
            "claude-opus-4-6",
            "loadServiceModes must fall back to services.inference.model when llm.default is absent"
        )
        XCTAssertEqual(
            store.inferenceMode,
            "managed",
            "loadServiceModes must read inferenceMode from services.inference.mode"
        )
    }

    /// When `llm.default` is partial (only provider, no model), the store
    /// should take provider from `llm.default` and fall back to
    /// `services.inference` for the missing model.
    func testLoadServiceModesMixesLLMDefaultProviderWithServicesInferenceModel() {
        let config: [String: Any] = [
            "llm": [
                "default": [
                    "provider": "openai"
                ]
            ],
            "services": [
                "inference": [
                    "provider": "anthropic",
                    "model": "claude-opus-4-6"
                ]
            ]
        ]

        store.loadServiceModes(config: config)

        XCTAssertEqual(store.selectedInferenceProvider, "openai")
        XCTAssertEqual(store.selectedModel, "claude-opus-4-6")
    }

    // MARK: - Write path: setLLMDefaultProvider

    func testSetLLMDefaultProviderEmitsExpectedPatch() {
        store.setLLMDefaultProvider("openai")
        waitForPatchCount(1)

        let patch = lastLLMDefaultPatch()
        XCTAssertNotNil(patch, "expected an llm.default patch payload")
        XCTAssertEqual(patch?["provider"] as? String, "openai")
        XCTAssertNil(
            patch?["model"],
            "setLLMDefaultProvider must not write a model field"
        )
    }

    func testSetLLMDefaultProviderDoesNotEmitServicesInferencePatch() {
        store.setLLMDefaultProvider("openai")
        waitForPatchCount(1)

        XCTAssertNil(
            lastServicesInferencePatch(),
            "setLLMDefaultProvider must not write to services.inference.*"
        )
    }

    func testSetLLMDefaultProviderUpdatesSelectedInferenceProvider() {
        store.setLLMDefaultProvider("openai")
        waitForPatchCount(1)

        XCTAssertEqual(store.selectedInferenceProvider, "openai")
    }

    // MARK: - Write path: setLLMDefaultModel

    func testSetLLMDefaultModelEmitsExpectedPatch() {
        _ = store.setLLMDefaultModel("gpt-4.1", provider: "openai", force: true)
        waitForPatchCount(1)

        let patch = lastLLMDefaultPatch()
        XCTAssertNotNil(patch, "expected an llm.default patch payload")
        XCTAssertEqual(patch?["provider"] as? String, "openai")
        XCTAssertEqual(patch?["model"] as? String, "gpt-4.1")
    }

    func testSetLLMDefaultModelDoesNotEmitServicesInferencePatch() {
        _ = store.setLLMDefaultModel("gpt-4.1", provider: "openai", force: true)
        waitForPatchCount(1)

        XCTAssertNil(
            lastServicesInferencePatch(),
            "setLLMDefaultModel must not write to services.inference.*"
        )
    }

    func testSetLLMDefaultModelUpdatesSelectedState() {
        _ = store.setLLMDefaultModel("gpt-4.1", provider: "openai", force: true)
        waitForPatchCount(1)

        XCTAssertEqual(store.selectedModel, "gpt-4.1")
        XCTAssertEqual(store.selectedInferenceProvider, "openai")
    }

    // MARK: - Legacy setInferenceMode is preserved

    /// `setInferenceMode` continues to write to `services.inference.mode` —
    /// the mode toggle is an inference-delivery setting, not part of the
    /// LLM model config, so it stays under `services.inference`.
    func testSetInferenceModeStillWritesToServicesInference() {
        _ = store.setInferenceMode("managed")
        waitForPatchCount(1)

        let patch = lastServicesInferencePatch()
        XCTAssertNotNil(patch, "expected a services.inference patch payload")
        XCTAssertEqual(patch?["mode"] as? String, "managed")
        XCTAssertNil(
            lastLLMDefaultPatch(),
            "setInferenceMode must not write to llm.default.*"
        )
    }
}
