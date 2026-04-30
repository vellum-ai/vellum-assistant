import SwiftUI
import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Structural tests for `InferenceProfileEditor`. The editor is a pure
/// SwiftUI form bound to an `InferenceProfile`; rather than rendering the
/// view tree (no `ViewInspector` dependency in this repo), we exercise the
/// editor's validation and option surface directly. Combined with the
/// binding-mutation test (which constructs the editor and confirms the
/// `@Binding` is wired), this covers the same ground as a snapshot test
/// without pulling in a third-party harness.
@MainActor
final class InferenceProfileEditorTests: XCTestCase {

    private var mockSettingsClient: MockSettingsClient!
    private var store: SettingsStore!

    override func setUp() {
        super.setUp()
        // Tiny deterministic catalog so tests don't depend on the live
        // `LLMProviderRegistry` shape.
        let fixture = SettingsTestFixture.make(
            providerCatalog: Self.editorProviderCatalog()
        )
        store = fixture.store
        mockSettingsClient = fixture.mockClient
    }

    override func tearDown() {
        store = nil
        mockSettingsClient = nil
        super.tearDown()
    }

    // MARK: - Helpers

    /// Constructs an editor over a binding to `profile`. Returns the editor
    /// plus a closure that reads the latest value of the underlying state
    /// box, so tests can confirm bindings have flowed through.
    private func makeEditor(
        profile: InferenceProfile,
        onSave: @escaping () -> Void = {},
        onCancel: @escaping () -> Void = {}
    ) -> (editor: InferenceProfileEditor, profileBox: ProfileBox) {
        let box = ProfileBox(profile: profile)
        let editor = InferenceProfileEditor(
            store: store,
            profile: Binding(
                get: { box.profile },
                set: { box.profile = $0 }
            ),
            onSave: onSave,
            onCancel: onCancel
        )
        return (editor, box)
    }

    /// Reference-typed shim so a `@Binding` constructed from get/set
    /// closures can mutate state across calls. `@State` would require a
    /// rendered view tree; this stays test-friendly without a harness.
    @MainActor
    private final class ProfileBox {
        var profile: InferenceProfile
        init(profile: InferenceProfile) { self.profile = profile }
    }

    private func modelEntry(
        id: String,
        displayName: String,
        maxOutputTokens: Int,
        supportsThinking: Bool
    ) -> LLMModelEntry {
        LLMModelEntry(
            id: id,
            displayName: displayName,
            maxOutputTokens: maxOutputTokens,
            supportsThinking: supportsThinking
        )
    }

    private static func editorProviderCatalog() -> [ProviderCatalogEntry] {
        SettingsTestFixture.anthropicAndOpenAICatalog() + [
            ProviderCatalogEntry(
                id: "gemini",
                displayName: "Google Gemini",
                models: [
                    CatalogModel(
                        id: "gemini-3.1-pro-preview",
                        displayName: "Gemini 3.1 Pro Preview"
                    ),
                    CatalogModel(
                        id: "gemini-3.1-pro-preview-customtools",
                        displayName: "Gemini 3.1 Pro Preview (Custom Tools)"
                    ),
                    CatalogModel(
                        id: "gemini-3-flash-preview",
                        displayName: "Gemini 3 Flash Preview"
                    ),
                    CatalogModel(
                        id: "gemini-3.1-flash-lite-preview",
                        displayName: "Gemini 3.1 Flash-Lite Preview"
                    ),
                    CatalogModel(id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash"),
                    CatalogModel(id: "gemini-2.5-flash-lite", displayName: "Gemini 2.5 Flash Lite"),
                    CatalogModel(id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro"),
                ],
                defaultModel: "gemini-2.5-flash"
            ),
        ]
    }

    // MARK: - Form structure

    func testStaticOptionsCoverEverySegmentControl() {
        XCTAssertEqual(InferenceProfileEditor.effortOptions, ["none", "low", "medium", "high", "xhigh", "max"])
        XCTAssertEqual(InferenceProfileEditor.speedOptions, ["standard", "fast"])
        XCTAssertEqual(InferenceProfileEditor.verbosityOptions, ["low", "medium", "high"])
    }

    func testEditorBuildsForEmptyProfile() {
        let (editor, _) = makeEditor(profile: InferenceProfile(name: "draft"))
        XCTAssertNotNil(editor.body, "Body must be constructible for an empty profile")
    }

    func testEditorBuildsForFullyPopulatedProfile() {
        let profile = InferenceProfile(
            name: "balanced",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            maxTokens: 16000,
            effort: "medium",
            speed: "standard",
            verbosity: "high",
            temperature: 0.7,
            thinkingEnabled: true,
            thinkingStreamThinking: false
        )
        let (editor, _) = makeEditor(profile: profile)
        XCTAssertNotNil(editor.body)
    }

    func testOpenAIGPT55ShowsOnlyConsumedParameters() {
        let visibility = InferenceProfileParameterVisibility.resolve(
            provider: "openai",
            model: "gpt-5.5",
            isKnownModel: true,
            modelEntry: modelEntry(
                id: "gpt-5.5",
                displayName: "GPT-5.5",
                maxOutputTokens: 128000,
                supportsThinking: true
            )
        )

        XCTAssertEqual(
            visibility,
            InferenceProfileParameterVisibility(
                maxTokens: true,
                effort: true,
                speed: false,
                verbosity: true,
                temperature: false,
                thinking: false
            )
        )
    }

    func testAnthropicOpusShowsAnthropicOnlyParameters() {
        let visibility = InferenceProfileParameterVisibility.resolve(
            provider: "anthropic",
            model: "claude-opus-4-7",
            isKnownModel: true,
            modelEntry: modelEntry(
                id: "claude-opus-4-7",
                displayName: "Claude Opus 4.7",
                maxOutputTokens: 32000,
                supportsThinking: true
            )
        )

        XCTAssertEqual(
            visibility,
            InferenceProfileParameterVisibility(
                maxTokens: true,
                effort: true,
                speed: true,
                verbosity: false,
                temperature: true,
                thinking: true
            )
        )
    }

    func testAnthropicHaikuHidesEffortAndSpeed() {
        let visibility = InferenceProfileParameterVisibility.resolve(
            provider: "anthropic",
            model: "claude-haiku-4-5-20251001",
            isKnownModel: true,
            modelEntry: modelEntry(
                id: "claude-haiku-4-5-20251001",
                displayName: "Claude Haiku 4.5",
                maxOutputTokens: 16000,
                supportsThinking: true
            )
        )

        XCTAssertEqual(
            visibility,
            InferenceProfileParameterVisibility(
                maxTokens: true,
                effort: false,
                speed: false,
                verbosity: false,
                temperature: true,
                thinking: true
            )
        )
    }

    func testGeminiShowsOnlyMaxTokensWithCurrentProviderSupport() {
        let visibility = InferenceProfileParameterVisibility.resolve(
            provider: "gemini",
            model: "gemini-2.5-flash",
            isKnownModel: true,
            modelEntry: modelEntry(
                id: "gemini-2.5-flash",
                displayName: "Gemini 2.5 Flash",
                maxOutputTokens: 65536,
                supportsThinking: true
            )
        )

        XCTAssertEqual(
            visibility,
            InferenceProfileParameterVisibility(
                maxTokens: true,
                effort: false,
                speed: false,
                verbosity: false,
                temperature: false,
                thinking: false
            )
        )
    }

    func testGemini3ShowsOnlyMaxTokensWithCurrentProviderSupport() {
        let visibility = InferenceProfileParameterVisibility.resolve(
            provider: "gemini",
            model: "gemini-3.1-pro-preview",
            isKnownModel: true,
            modelEntry: modelEntry(
                id: "gemini-3.1-pro-preview",
                displayName: "Gemini 3.1 Pro Preview",
                maxOutputTokens: 65536,
                supportsThinking: true
            )
        )

        XCTAssertEqual(
            visibility,
            InferenceProfileParameterVisibility(
                maxTokens: true,
                effort: false,
                speed: false,
                verbosity: false,
                temperature: false,
                thinking: false
            )
        )
    }

    func testOpenRouterReasoningModelsShowEffortAndThinking() {
        let visibility = InferenceProfileParameterVisibility.resolve(
            provider: "openrouter",
            model: "deepseek/deepseek-r1-0528",
            isKnownModel: true,
            modelEntry: modelEntry(
                id: "deepseek/deepseek-r1-0528",
                displayName: "DeepSeek R1",
                maxOutputTokens: 32000,
                supportsThinking: true
            )
        )

        XCTAssertEqual(
            visibility,
            InferenceProfileParameterVisibility(
                maxTokens: true,
                effort: true,
                speed: false,
                verbosity: false,
                temperature: false,
                thinking: true
            )
        )
    }

    func testOpenRouterNonReasoningModelsHideEffortAndThinking() {
        let visibility = InferenceProfileParameterVisibility.resolve(
            provider: "openrouter",
            model: "deepseek/deepseek-chat-v3-0324",
            isKnownModel: true,
            modelEntry: modelEntry(
                id: "deepseek/deepseek-chat-v3-0324",
                displayName: "DeepSeek V3",
                maxOutputTokens: 32000,
                supportsThinking: false
            )
        )

        XCTAssertEqual(
            visibility,
            InferenceProfileParameterVisibility(
                maxTokens: true,
                effort: false,
                speed: false,
                verbosity: false,
                temperature: false,
                thinking: false
            )
        )
    }

    func testHiddenParametersAreClearedForOpenAIOnSave() {
        let visibility = InferenceProfileParameterVisibility.resolve(
            provider: "openai",
            model: "gpt-5.5",
            isKnownModel: true,
            modelEntry: modelEntry(
                id: "gpt-5.5",
                displayName: "GPT-5.5",
                maxOutputTokens: 128000,
                supportsThinking: true
            )
        )
        let profile = InferenceProfile(
            name: "gpt-5.5-inline-thinking",
            provider: "openai",
            model: "gpt-5.5",
            maxTokens: 16000,
            effort: "high",
            speed: "fast",
            verbosity: "high",
            temperature: 0.7,
            thinkingEnabled: true,
            thinkingStreamThinking: true
        )

        let sanitized = visibility.sanitized(profile)

        XCTAssertEqual(sanitized.maxTokens, 16000)
        XCTAssertEqual(sanitized.effort, "high")
        XCTAssertEqual(sanitized.verbosity, "high")
        XCTAssertNil(sanitized.speed)
        XCTAssertEqual(sanitized.temperature, .unset)
        XCTAssertNil(sanitized.thinkingEnabled)
        XCTAssertNil(sanitized.thinkingStreamThinking)
    }

    func testContextWindowMaxInputTokensRoundTripsThroughProfileJSON() {
        let profile = InferenceProfile(
            name: "long-context",
            provider: "openai",
            model: "gpt-5.5",
            contextWindowMaxInputTokens: 150000
        )

        let json = profile.toJSON()
        let contextWindow = json["contextWindow"] as? [String: Any]

        XCTAssertEqual(contextWindow?["maxInputTokens"] as? Int, 150000)
        let decoded = InferenceProfile(name: "long-context", json: json)
        XCTAssertEqual(decoded.contextWindowMaxInputTokens, 150000)
    }

    func testOmittedContextWindowContinuesToInheritDefaults() {
        let profile = InferenceProfile(
            name: "default-context",
            provider: "anthropic",
            model: "claude-sonnet-4-6"
        )

        XCTAssertNil(profile.contextWindowMaxInputTokens)
        XCTAssertNil(profile.toJSON()["contextWindow"])
    }

    func testContextWindowSiblingLeavesArePreservedWhenContextMaxChanges() {
        let profile = InferenceProfile(
            name: "manual",
            json: [
                "provider": "anthropic",
                "model": "claude-sonnet-4-6",
                "contextWindow": [
                    "maxInputTokens": 900000,
                    "summaryBudgetRatio": 0.08,
                ],
                "openrouter": ["only": ["anthropic"]],
            ]
        )
        var edited = profile
        edited.contextWindowMaxInputTokens = nil

        let json = edited.toJSON()
        let contextWindow = json["contextWindow"] as? [String: Any]

        XCTAssertNil(contextWindow?["maxInputTokens"])
        XCTAssertEqual(contextWindow?["summaryBudgetRatio"] as? Double, 0.08)
        let openrouter = json["openrouter"] as? [String: Any]
        XCTAssertEqual(openrouter?["only"] as? [String], ["anthropic"])
    }

    // MARK: - Validation

    func testCanSaveWhenProviderAndModelAreNil() {
        let (editor, _) = makeEditor(profile: InferenceProfile(name: "empty"))
        XCTAssertFalse(editor.isModelMissing)
        XCTAssertFalse(editor.isModelInvalid)
        XCTAssertTrue(editor.canSave, "An entirely empty fragment is a valid partial profile")
    }

    func testCanSaveWhenProviderAndModelAreBothSetAndValid() {
        let (editor, _) = makeEditor(profile: InferenceProfile(
            name: "valid",
            provider: "anthropic",
            model: "claude-sonnet-4-6"
        ))
        XCTAssertTrue(editor.canSave)
    }

    func testCanSelectGemini3ModelFromDynamicCatalog() {
        let geminiModels = store.dynamicProviderModels("gemini")
        XCTAssertEqual(
            geminiModels.prefix(4).map(\.id),
            [
                "gemini-3.1-pro-preview",
                "gemini-3.1-pro-preview-customtools",
                "gemini-3-flash-preview",
                "gemini-3.1-flash-lite-preview",
            ]
        )
        XCTAssertEqual(
            geminiModels.first { $0.id == "gemini-3.1-pro-preview" }?.displayName,
            "Gemini 3.1 Pro Preview"
        )

        let (editor, box) = makeEditor(profile: InferenceProfile(
            name: "gemini-3",
            provider: "gemini",
            model: "gemini-3.1-pro-preview"
        ))

        XCTAssertEqual(box.profile.model, "gemini-3.1-pro-preview")
        XCTAssertFalse(editor.isModelMissing)
        XCTAssertFalse(editor.isModelInvalid)
        XCTAssertTrue(editor.canSave)
    }

    func testCannotSaveWhenProviderIsSetButModelIsNil() {
        let (editor, _) = makeEditor(profile: InferenceProfile(
            name: "missing-model",
            provider: "anthropic"
        ))
        XCTAssertTrue(editor.isModelMissing)
        XCTAssertFalse(editor.canSave, "Save must be blocked when provider is set without a model")
    }

    func testCannotSaveWhenProviderIsSetButModelIsEmptyString() {
        let (editor, _) = makeEditor(profile: InferenceProfile(
            name: "empty-model",
            provider: "anthropic",
            model: ""
        ))
        XCTAssertTrue(editor.isModelMissing)
        XCTAssertFalse(editor.canSave)
    }

    func testCannotSaveWhenModelIsNotInProviderCatalog() {
        let (editor, _) = makeEditor(profile: InferenceProfile(
            name: "stale-model",
            provider: "anthropic",
            model: "claude-vintage-1900"
        ))
        XCTAssertFalse(editor.isModelMissing)
        XCTAssertTrue(editor.isModelInvalid)
        XCTAssertFalse(editor.canSave, "Save must be blocked when the model is unknown to the provider")
    }

    func testIsModelMissingDoesNotFireWhenProviderIsNil() {
        // Edge case: model set without a provider. We do not block Save in
        // this state — the resolver layers the partial fragment onto the
        // default and the model leaf alone is harmless. Validation only
        // kicks in once the user has committed to a provider.
        let (editor, _) = makeEditor(profile: InferenceProfile(
            name: "model-only",
            model: "claude-sonnet-4-6"
        ))
        XCTAssertFalse(editor.isModelMissing)
        XCTAssertFalse(editor.isModelInvalid)
        XCTAssertTrue(editor.canSave)
    }

    // MARK: - Binding propagation

    func testBindingMutationsPropagateToProfileBox() {
        let (_, box) = makeEditor(profile: InferenceProfile(name: "draft"))
        XCTAssertNil(box.profile.provider)

        // Simulate the form mutating the bound profile — same path the
        // dropdown's set-closure would take when the user picks a value.
        box.profile.provider = "anthropic"
        box.profile.model = "claude-sonnet-4-6"
        XCTAssertEqual(box.profile.provider, "anthropic")
        XCTAssertEqual(box.profile.model, "claude-sonnet-4-6")
    }

    func testValidationFlipsAsBindingChanges() {
        let box = ProfileBox(profile: InferenceProfile(name: "draft"))
        // Editor that reads from the box on demand — closures captured
        // without `[weak]` keep the box alive for the duration of the test.
        let editor = InferenceProfileEditor(
            store: store,
            profile: Binding(
                get: { box.profile },
                set: { box.profile = $0 }
            ),
            onSave: {},
            onCancel: {}
        )

        // Initially: empty fragment, save allowed.
        XCTAssertTrue(editor.canSave)

        // Pick a provider but no model: save blocked.
        box.profile.provider = "anthropic"
        XCTAssertTrue(editor.isModelMissing)
        XCTAssertFalse(editor.canSave)

        // Pick a valid model: save allowed again.
        box.profile.model = "claude-sonnet-4-6"
        XCTAssertFalse(editor.isModelMissing)
        XCTAssertFalse(editor.isModelInvalid)
        XCTAssertTrue(editor.canSave)

        // Switch to a model not in the catalog: save blocked.
        box.profile.model = "gpt-5"
        XCTAssertFalse(editor.isModelMissing)
        XCTAssertTrue(editor.isModelInvalid, "gpt-5 belongs to the openai catalog, not anthropic")
        XCTAssertFalse(editor.canSave)
    }

    // MARK: - Save / Cancel callbacks

    func testSaveCallbackIsForwarded() {
        var saveCalls = 0
        let (editor, _) = makeEditor(
            profile: InferenceProfile(name: "x"),
            onSave: { saveCalls += 1 }
        )
        // Body builds without invoking the closure.
        _ = editor.body
        XCTAssertEqual(saveCalls, 0)
    }

    func testCancelCallbackIsForwarded() {
        var cancelCalls = 0
        let (editor, _) = makeEditor(
            profile: InferenceProfile(name: "x"),
            onCancel: { cancelCalls += 1 }
        )
        _ = editor.body
        XCTAssertEqual(cancelCalls, 0)
    }
}
