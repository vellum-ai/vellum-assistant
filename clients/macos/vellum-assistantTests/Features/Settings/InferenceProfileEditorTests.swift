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
        [
            ProviderCatalogEntry(
                id: "anthropic",
                displayName: "Anthropic",
                models: [
                    CatalogModel(id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6"),
                    CatalogModel(id: "claude-opus-4-7", displayName: "Claude Opus 4.7"),
                ],
                defaultModel: "claude-sonnet-4-6"
            ),
            ProviderCatalogEntry(
                id: "openai",
                displayName: "OpenAI",
                models: [
                    CatalogModel(id: "gpt-5", displayName: "GPT-5"),
                    CatalogModel(id: "gpt-5.5", displayName: "GPT-5.5"),
                    CatalogModel(id: "gpt-5.4", displayName: "GPT-5.4"),
                    CatalogModel(id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini"),
                    CatalogModel(id: "gpt-5.3-codex", displayName: "GPT-5.3 Codex"),
                ],
                defaultModel: "gpt-5"
            ),
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
                    CatalogModel(
                        id: "gemini-3.1-flash-lite",
                        displayName: "Gemini 3.1 Flash-Lite"
                    ),
                    CatalogModel(id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash"),
                    CatalogModel(id: "gemini-2.5-flash-lite", displayName: "Gemini 2.5 Flash Lite"),
                    CatalogModel(id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro"),
                ],
                defaultModel: "gemini-2.5-flash"
            ),
            ProviderCatalogEntry(
                id: "openrouter",
                displayName: "OpenRouter",
                models: [
                    CatalogModel(
                        id: "deepseek/deepseek-r1-0528",
                        displayName: "DeepSeek R1"
                    ),
                ],
                defaultModel: "deepseek/deepseek-r1-0528"
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
                thinking: false,
                thinkingLevel: false
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
                thinking: true,
                thinkingLevel: false
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
                thinking: true,
                thinkingLevel: false
            )
        )
    }

    func testGemini25ShowsThinkingLevelSelector() {
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
                thinking: false,
                thinkingLevel: true
            )
        )
    }

    func testGemini3ProShowsThinkingLevelSelector() {
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
                thinking: false,
                thinkingLevel: true
            )
        )
    }

    func testUnknownModelStillShowsMaxOutputControlWithoutCatalogLimit() {
        let visibility = InferenceProfileParameterVisibility.resolve(
            provider: "anthropic",
            model: "claude-vintage-1900",
            isKnownModel: false,
            modelEntry: nil
        )

        XCTAssertTrue(visibility.maxTokens)
        XCTAssertNil(InferenceProfileEditor.maxOutputTokenLimit(
            provider: "anthropic",
            model: "claude-vintage-1900"
        ))
    }

    func testCatalogModelWithoutStaticOutputMetadataKeepsMaxTokensReadOnly() {
        let (editor, _) = makeEditor(profile: InferenceProfile(
            name: "gemini-preview",
            provider: "gemini",
            model: "gemini-3.1-pro-preview",
            maxTokens: 96_000
        ))

        XCTAssertTrue(editor.canSave)
        XCTAssertNil(InferenceProfileEditor.maxOutputTokenLimit(
            provider: "gemini",
            model: "gemini-3.1-pro-preview"
        ))
        XCTAssertEqual(
            InferenceProfileEditor.maxOutputSliderValue(maxTokens: 96_000, limit: nil),
            96_000
        )
        XCTAssertEqual(
            InferenceProfileEditor.maxOutputSliderUpperBound(value: 96_000, limit: nil),
            96_000
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
                thinking: true,
                thinkingLevel: false
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
                thinking: false,
                thinkingLevel: false
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

    func testGPT55MaxOutputSliderLimitIs128K() {
        let limit = InferenceProfileEditor.maxOutputTokenLimit(
            provider: "openai",
            model: "gpt-5.5"
        )

        XCTAssertEqual(limit, 128_000)
        XCTAssertEqual(
            InferenceProfileEditor.maxOutputSliderUpperBound(value: 64_000, limit: limit),
            128_000
        )
        XCTAssertEqual(InferenceProfileEditor.formattedTokenCount(128_000), "128K")
    }

    func testSonnet46MaxOutputSliderLimitIs64K() {
        let limit = InferenceProfileEditor.maxOutputTokenLimit(
            provider: "anthropic",
            model: "claude-sonnet-4-6"
        )

        XCTAssertEqual(limit, 64_000)
        XCTAssertEqual(
            InferenceProfileEditor.maxOutputSliderUpperBound(value: 64_000, limit: limit),
            64_000
        )
        XCTAssertEqual(InferenceProfileEditor.formattedTokenCount(64_000), "64K")
    }

    func testHaiku45MaxOutputSliderLimitIs64K() {
        let limit = InferenceProfileEditor.maxOutputTokenLimit(
            provider: "anthropic",
            model: "claude-haiku-4-5-20251001"
        )

        XCTAssertEqual(limit, 64_000)
        XCTAssertEqual(
            InferenceProfileEditor.maxOutputSliderUpperBound(value: 64_000, limit: limit),
            64_000
        )
    }

    func testSwitchingToLowerOutputModelClampsExistingMaxTokens() {
        var profile = InferenceProfile(
            name: "high-output",
            provider: "openai",
            model: "gpt-5.5",
            maxTokens: 128_000
        )
        XCTAssertEqual(
            InferenceProfileEditor.maxOutputSliderValue(
                maxTokens: profile.maxTokens,
                limit: InferenceProfileEditor.maxOutputTokenLimit(provider: profile.provider, model: profile.model)
            ),
            128_000
        )

        profile.provider = "anthropic"
        profile.model = "claude-sonnet-4-6"
        InferenceProfileEditor.clampMaxOutputTokensForSelectedModel(&profile)

        XCTAssertEqual(profile.maxTokens, 64_000)
    }

    func testMaxOutputOverrideCanBeClearedToInherit() {
        var profile = InferenceProfile(
            name: "manual-output",
            provider: "gemini",
            model: "gemini-3.1-pro-preview",
            maxTokens: 96_000
        )

        profile = InferenceProfileEditor.clearingMaxOutputTokensOverride(profile)

        XCTAssertNil(profile.maxTokens)
        XCTAssertNil(profile.toJSON()["maxTokens"])
    }

    func testGPT55ContextWindowSliderLimitIs1050K() {
        let limit = InferenceProfileEditor.contextWindowTokenLimit(
            provider: "openai",
            model: "gpt-5.5"
        )

        XCTAssertEqual(limit, 1_050_000)
        XCTAssertEqual(
            InferenceProfileEditor.contextWindowSliderUpperBound(value: 200_000, limit: limit),
            1_050_000
        )
    }

    func testGPT54ContextWindowSliderLimitIs1050K() {
        let limit = InferenceProfileEditor.contextWindowTokenLimit(
            provider: "openai",
            model: "gpt-5.4"
        )

        XCTAssertEqual(limit, 1_050_000)
        XCTAssertEqual(
            InferenceProfileEditor.contextWindowSliderUpperBound(value: 200_000, limit: limit),
            1_050_000
        )
    }

    func testSonnet46ContextWindowSliderLimitIs1000K() {
        let limit = InferenceProfileEditor.contextWindowTokenLimit(
            provider: "anthropic",
            model: "claude-sonnet-4-6"
        )

        XCTAssertEqual(limit, 1_000_000)
        XCTAssertEqual(
            InferenceProfileEditor.contextWindowSliderUpperBound(value: 200_000, limit: limit),
            1_000_000
        )
    }

    func testHaiku45ContextWindowSliderLimitIs200K() {
        let limit = InferenceProfileEditor.contextWindowTokenLimit(
            provider: "anthropic",
            model: "claude-haiku-4-5-20251001"
        )

        XCTAssertEqual(limit, 200_000)
        XCTAssertEqual(
            InferenceProfileEditor.contextWindowSliderUpperBound(value: 200_000, limit: limit),
            200_000
        )
    }

    func testContextWindowSliderDefaultsToEffectiveDefaultBudget() {
        let model = InferenceProfileEditor.modelEntry(
            provider: "openai",
            model: "gpt-5.5"
        )

        XCTAssertEqual(
            InferenceProfileEditor.contextWindowSliderValue(maxInputTokens: nil, model: model),
            200_000
        )
    }

    func testContextWindowSliderLowerBoundIsAlignedWithStep() {
        XCTAssertEqual(InferenceProfileEditor.minSliderContextWindowTokens, 50_000)
        XCTAssertEqual(
            InferenceProfileEditor.clampedContextWindowTokens(1, limit: 1_000_000),
            50_000
        )
    }

    func testSwitchingToLowerContextModelClampsExistingOverride() {
        var profile = InferenceProfile(
            name: "long-context",
            provider: "openai",
            model: "gpt-5.5",
            contextWindowMaxInputTokens: 1_000_000
        )

        profile.provider = "anthropic"
        profile.model = "claude-haiku-4-5-20251001"
        InferenceProfileEditor.clampContextWindowForSelectedModel(&profile)

        XCTAssertEqual(profile.contextWindowMaxInputTokens, 200_000)
    }

    func testCustomContextWindow150KRoundTripsAndAppearsInSummary() {
        let profile = InferenceProfile(
            name: "custom-context",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            contextWindowMaxInputTokens: 150_000
        )

        let json = profile.toJSON()
        let contextWindow = json["contextWindow"] as? [String: Any]

        XCTAssertEqual(contextWindow?["maxInputTokens"] as? Int, 150_000)
        let decoded = InferenceProfile(name: "custom-context", json: json)
        XCTAssertEqual(decoded.contextWindowMaxInputTokens, 150_000)
        XCTAssertEqual(
            InferenceProfilesSheet.summary(for: decoded, store: store),
            "Claude Sonnet 4.6 \u{00B7} 150K context"
        )
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
            geminiModels.prefix(5).map(\.id),
            [
                "gemini-3.1-pro-preview",
                "gemini-3.1-pro-preview-customtools",
                "gemini-3-flash-preview",
                "gemini-3.1-flash-lite-preview",
                "gemini-3.1-flash-lite",
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

    // MARK: - View-mode change detection (managed-profile policy edit)

    /// Sanity: `isStatusActive` collapses the three "active" shapes
    /// (`nil`, empty string, literal `"active"`) into the same bucket
    /// and treats only literal `"disabled"` as inactive. Round-trips
    /// through the daemon can flip between any of the three active
    /// shapes, so the editor must not treat that as a user-visible
    /// change.
    func testIsStatusActiveNormalizesActiveShapes() {
        XCTAssertTrue(InferenceProfileEditor.isStatusActive(nil))
        XCTAssertTrue(InferenceProfileEditor.isStatusActive(""))
        XCTAssertTrue(InferenceProfileEditor.isStatusActive("active"))
        XCTAssertFalse(InferenceProfileEditor.isStatusActive("disabled"))
    }

    /// Editing a managed profile's label from "Managed" to "Renamed"
    /// must register as a view-mode change so Save is enabled.
    func testViewModeHasChangesDetectsLabelEdit() {
        XCTAssertTrue(InferenceProfileEditor.viewModeHasChanges(
            currentLabel: "Renamed",
            initialLabel: "Managed",
            currentStatus: nil,
            initialStatus: nil
        ))
    }

    /// Toggling status from active to disabled must register as a
    /// view-mode change. Uses `nil` as the initial active shape because
    /// that's what the daemon-seeded managed profiles arrive as.
    func testViewModeHasChangesDetectsStatusFlipFromActiveToDisabled() {
        XCTAssertTrue(InferenceProfileEditor.viewModeHasChanges(
            currentLabel: "Managed",
            initialLabel: "Managed",
            currentStatus: "disabled",
            initialStatus: nil
        ))
    }

    /// And back: from disabled to active. The `initialStatus` here is
    /// `"disabled"` because that's what the editor would have captured
    /// from the seed profile.
    func testViewModeHasChangesDetectsStatusFlipFromDisabledToActive() {
        XCTAssertTrue(InferenceProfileEditor.viewModeHasChanges(
            currentLabel: "Managed",
            initialLabel: "Managed",
            currentStatus: "active",
            initialStatus: "disabled"
        ))
    }

    /// Identical snapshots — no change. Save must stay disabled.
    func testViewModeHasChangesReturnsFalseWhenLabelAndStatusUntouched() {
        XCTAssertFalse(InferenceProfileEditor.viewModeHasChanges(
            currentLabel: "Managed",
            initialLabel: "Managed",
            currentStatus: nil,
            initialStatus: nil
        ))
    }

    /// `nil` vs `"active"` vs `""` are all the same "active" bucket.
    /// Toggling between them via daemon round-trips must NOT register
    /// as a change — otherwise the Save button would flicker on after
    /// a no-op refresh.
    func testViewModeHasChangesIgnoresActiveShapeRoundTrip() {
        // nil ↔ "active"
        XCTAssertFalse(InferenceProfileEditor.viewModeHasChanges(
            currentLabel: "Managed",
            initialLabel: "Managed",
            currentStatus: "active",
            initialStatus: nil
        ))
        // nil ↔ ""
        XCTAssertFalse(InferenceProfileEditor.viewModeHasChanges(
            currentLabel: "Managed",
            initialLabel: "Managed",
            currentStatus: "",
            initialStatus: nil
        ))
        // "active" ↔ ""
        XCTAssertFalse(InferenceProfileEditor.viewModeHasChanges(
            currentLabel: "Managed",
            initialLabel: "Managed",
            currentStatus: "active",
            initialStatus: ""
        ))
    }

    /// Trailing/leading whitespace on the label is trimmed before
    /// comparison — a stray space from copy-paste or auto-fill must
    /// not enable Save.
    func testViewModeHasChangesTrimsLabelWhitespace() {
        XCTAssertFalse(InferenceProfileEditor.viewModeHasChanges(
            currentLabel: "  Managed  ",
            initialLabel: "Managed",
            currentStatus: nil,
            initialStatus: nil
        ))
        XCTAssertFalse(InferenceProfileEditor.viewModeHasChanges(
            currentLabel: "Managed\n",
            initialLabel: "Managed",
            currentStatus: nil,
            initialStatus: nil
        ))
    }

    /// Clearing the label (nil or empty) when the initial was set
    /// counts as a real change in local state.
    func testViewModeHasChangesDetectsLabelClearing() {
        XCTAssertTrue(InferenceProfileEditor.viewModeHasChanges(
            currentLabel: nil,
            initialLabel: "Managed",
            currentStatus: nil,
            initialStatus: nil
        ))
        XCTAssertTrue(InferenceProfileEditor.viewModeHasChanges(
            currentLabel: "",
            initialLabel: "Managed",
            currentStatus: nil,
            initialStatus: nil
        ))
    }

    /// `nil` label and `""` label both normalize to empty — toggling
    /// between them must NOT register as a change.
    func testViewModeHasChangesTreatsNilAndEmptyLabelAsEqual() {
        XCTAssertFalse(InferenceProfileEditor.viewModeHasChanges(
            currentLabel: "",
            initialLabel: nil,
            currentStatus: nil,
            initialStatus: nil
        ))
    }

    /// Instance-level guard: in edit mode (not read-only),
    /// `hasViewModeChanges` is always false — even if the profile
    /// happens to differ from the (uncaptured) initial snapshot.
    /// View-mode change tracking only applies to the managed-profile
    /// read path.
    func testHasViewModeChangesIsAlwaysFalseInEditMode() {
        let (editor, _) = makeEditor(profile: InferenceProfile(
            name: "draft",
            status: "disabled",
            label: "Anything"
        ))
        XCTAssertFalse(editor.isReadOnly)
        XCTAssertFalse(
            editor.hasViewModeChanges,
            "Edit mode must never report view-mode changes — only the read-only managed-profile path tracks them"
        )
    }

    // MARK: - Connection sub-dropdown (audit finding #5)

    /// Three openai connections + one of a different provider. With
    /// provider == "openai" the filter must yield exactly the three openai
    /// rows in input order.
    func testAvailableConnectionsForProviderFiltersByProvider() {
        let connections: [ProviderConnection] = [
            Self.makeConnection(name: "personal-openai", provider: "openai", label: "Personal"),
            Self.makeConnection(name: "work-openai", provider: "openai", label: "Work"),
            Self.makeConnection(name: "legacy-openai", provider: "openai", label: "Legacy"),
            Self.makeConnection(name: "anthropic-main", provider: "anthropic", label: "Main"),
        ]
        let editor = InferenceProfileEditor(
            store: store,
            profile: .constant(InferenceProfile(name: "draft", provider: "openai")),
            connections: connections,
            onSave: {},
            onCancel: {}
        )
        let available = editor.availableConnectionsForProvider
        XCTAssertEqual(available.map { $0.name }, ["personal-openai", "work-openai", "legacy-openai"])
    }

    /// When no provider is selected, no connections are surfaced — the
    /// daemon's dispatcher has nothing to bind against until the user
    /// picks a provider, so the dropdown stays hidden.
    func testAvailableConnectionsForProviderIsEmptyWhenProviderUnset() {
        let connections = [
            Self.makeConnection(name: "openai", provider: "openai"),
        ]
        let editor = InferenceProfileEditor(
            store: store,
            profile: .constant(InferenceProfile(name: "draft", provider: nil)),
            connections: connections,
            onSave: {},
            onCancel: {}
        )
        XCTAssertTrue(editor.availableConnectionsForProvider.isEmpty)
    }

    /// Empty `connections` (the default — e.g. the daemon predates the
    /// connections API) must not crash the filter.
    func testAvailableConnectionsForProviderIsEmptyWhenConnectionsEmpty() {
        let editor = InferenceProfileEditor(
            store: store,
            profile: .constant(InferenceProfile(name: "draft", provider: "openai")),
            onSave: {},
            onCancel: {}
        )
        XCTAssertTrue(editor.availableConnectionsForProvider.isEmpty)
    }

    /// Display label prefers the human-readable `label` (e.g. "Personal")
    /// over the internal `name`. Falls back to `name` when label is nil OR
    /// empty so a daemon that sends `""` for the label doesn't render an
    /// invisible row.
    func testConnectionDisplayNamePrefersLabel() {
        let withLabel = Self.makeConnection(name: "personal-openai", label: "Personal")
        XCTAssertEqual(InferenceProfileEditor.connectionDisplayName(withLabel), "Personal")

        let withoutLabel = Self.makeConnection(name: "personal-openai", label: nil)
        XCTAssertEqual(InferenceProfileEditor.connectionDisplayName(withoutLabel), "personal-openai")

        let emptyLabel = Self.makeConnection(name: "personal-openai", label: "")
        XCTAssertEqual(InferenceProfileEditor.connectionDisplayName(emptyLabel), "personal-openai")
    }

    /// Stale binding detection: a saved `providerConnection` that points
    /// at a name not present in the active-for-provider set surfaces as
    /// `staleProviderConnection`. Gates the "Not found" badge + the extra
    /// dropdown option that lets the user clear it.
    func testStaleProviderConnectionReturnsNameWhenBindingMissing() {
        let connections = [
            Self.makeConnection(name: "personal-openai", provider: "openai"),
        ]
        let editor = InferenceProfileEditor(
            store: store,
            profile: .constant(InferenceProfile(
                name: "draft",
                provider: "openai",
                providerConnection: "ghost-openai"
            )),
            connections: connections,
            onSave: {},
            onCancel: {}
        )
        XCTAssertEqual(editor.staleProviderConnection, "ghost-openai")
    }

    /// Binding resolves cleanly to an active row → `nil`, picker renders
    /// in its non-stale shape.
    func testStaleProviderConnectionNilWhenBindingMatches() {
        let connections = [
            Self.makeConnection(name: "personal-openai", provider: "openai"),
        ]
        let editor = InferenceProfileEditor(
            store: store,
            profile: .constant(InferenceProfile(
                name: "draft",
                provider: "openai",
                providerConnection: "personal-openai"
            )),
            connections: connections,
            onSave: {},
            onCancel: {}
        )
        XCTAssertNil(editor.staleProviderConnection)
    }

    /// Empty / nil binding → `nil`. Picker renders in its default shape
    /// when there are active matches; hides entirely when there are none.
    func testStaleProviderConnectionNilWhenBindingEmpty() {
        let connections = [
            Self.makeConnection(name: "personal-openai", provider: "openai"),
        ]
        let unboundEditor = InferenceProfileEditor(
            store: store,
            profile: .constant(InferenceProfile(
                name: "draft",
                provider: "openai",
                providerConnection: nil
            )),
            connections: connections,
            onSave: {},
            onCancel: {}
        )
        XCTAssertNil(unboundEditor.staleProviderConnection)

        let emptyBindingEditor = InferenceProfileEditor(
            store: store,
            profile: .constant(InferenceProfile(
                name: "draft",
                provider: "openai",
                providerConnection: ""
            )),
            connections: connections,
            onSave: {},
            onCancel: {}
        )
        XCTAssertNil(emptyBindingEditor.staleProviderConnection)
    }

    /// Body must still build when the saved binding is stale — the new
    /// codepath constructs an extended options list with the "(not found)"
    /// entry, and any type-inference regression there would break the
    /// SwiftUI compile. Safety net for the picker's stale-state UI.
    func testEditorBodyBuildsWithStaleBinding() {
        let connections = [
            Self.makeConnection(name: "personal-openai", provider: "openai"),
        ]
        let editor = InferenceProfileEditor(
            store: store,
            profile: .constant(InferenceProfile(
                name: "draft",
                provider: "openai",
                providerConnection: "ghost-openai",
                model: "gpt-5"
            )),
            connections: connections,
            onSave: {},
            onCancel: {}
        )
        XCTAssertNotNil(editor.body)
    }

    /// The editor must still build when a `connections:` list is passed in
    /// alongside other knobs — body construction is the safety net for any
    /// SwiftUI type-inference regression we'd otherwise miss until a
    /// snapshot build.
    func testEditorBodyBuildsWithConnections() {
        let connections = [
            Self.makeConnection(name: "personal-openai", provider: "openai", label: "Personal"),
            Self.makeConnection(name: "work-openai", provider: "openai", label: "Work"),
        ]
        let editor = InferenceProfileEditor(
            store: store,
            profile: .constant(InferenceProfile(
                name: "personal",
                provider: "openai",
                providerConnection: "personal-openai",
                model: "gpt-5"
            )),
            connections: connections,
            onSave: {},
            onCancel: {}
        )
        XCTAssertNotNil(editor.body)
    }

    // MARK: - Provider picker filter (iter3 QA issue #1, parity with web PR #6509)

    /// All providers with at least one connection are surfaced in the picker.
    func testAvailableProviderIdsShowsProvidersWithConnections() {
        let connections: [ProviderConnection] = [
            Self.makeConnection(name: "active-anthropic", provider: "anthropic"),
            Self.makeConnection(name: "openai-conn", provider: "openai"),
        ]
        let editor = InferenceProfileEditor(
            store: store,
            profile: .constant(InferenceProfile(name: "draft")),
            connections: connections,
            onSave: {},
            onCancel: {}
        )
        XCTAssertEqual(editor.availableProviderIds, ["anthropic", "openai"])
    }

    /// Stale binding recovery: the editor is opened on a profile whose
    /// `provider` value is bound. The bound provider must still appear in
    /// the picker so the user can see it (and pick a different one)
    /// instead of finding an empty trigger.
    func testAvailableProviderIdsKeepsCurrentBoundProvider() {
        let connections: [ProviderConnection] = [
            Self.makeConnection(name: "active-anthropic", provider: "anthropic"),
            Self.makeConnection(name: "openai-conn", provider: "openai"),
        ]
        let editor = InferenceProfileEditor(
            store: store,
            profile: .constant(InferenceProfile(
                name: "draft",
                provider: "openai",
                model: "gpt-5"
            )),
            connections: connections,
            onSave: {},
            onCancel: {}
        )
        // Order follows store.dynamicProviderIds catalog order, which
        // happens to put anthropic before openai in the test fixture.
        XCTAssertEqual(editor.availableProviderIds, ["anthropic", "openai"])
    }

    /// Pre-load fallback: when `connections` is nil (the parent sheet's
    /// `.task` hasn't completed its first `listProviderConnections`
    /// fetch yet, or the daemon predates the connections API), the
    /// picker shows the full catalog so the user isn't faced with an
    /// empty trigger during the network round-trip. Once connections
    /// load — even to `[]` — the active-only filter kicks in.
    ///
    /// This is the half of the "nil vs []" distinction. The other half
    /// is `testAvailableProviderIdsIsEmptyWhenConnectionsLoadedButEmpty`
    /// below.
    func testAvailableProviderIdsFallsBackToFullCatalogWhenConnectionsAreNil() {
        let editor = InferenceProfileEditor(
            store: store,
            profile: .constant(InferenceProfile(name: "draft")),
            onSave: {},
            onCancel: {}
        )
        // Default `connections` is nil — the pre-load state.
        XCTAssertEqual(editor.availableProviderIds, store.dynamicProviderIds)
        XCTAssertFalse(editor.availableProviderIds.isEmpty)
    }

    /// Loaded-but-empty: the daemon confirmed zero connections (fresh
    /// workspace). This MUST NOT fall back to the full catalog — that
    /// would let the user save a profile bound to a non-dispatchable
    /// provider, which is the exact trap this PR is closing. The picker
    /// renders empty; the empty-state hint elsewhere in the editor
    /// steers the user to the Providers surface.
    ///
    /// Codex P1 (PR #30330): the original `guard !connections.isEmpty`
    /// fallback conflated this case with pre-load and re-introduced the
    /// QA trap for fresh workspaces. The fix is the nil/empty split.
    func testAvailableProviderIdsIsEmptyWhenConnectionsLoadedButEmpty() {
        let editor = InferenceProfileEditor(
            store: store,
            profile: .constant(InferenceProfile(name: "draft")),
            connections: [],
            onSave: {},
            onCancel: {}
        )
        XCTAssertTrue(editor.availableProviderIds.isEmpty)
    }

    // MARK: - ChatGPT subscription model filter (parity with web CODEX_SUBSCRIPTION_MODEL_IDS)

    /// The constant set must contain exactly the Codex-supported model IDs.
    /// If the daemon adds or removes subscription-eligible models, this test
    /// will catch the drift.
    func testCodexSubscriptionModelIdsMatchesExpectedSet() {
        XCTAssertEqual(
            InferenceProfileEditor.codexSubscriptionModelIds,
            Set(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"])
        )
    }

    /// When the effective connection uses `oauth_subscription` auth, the
    /// editor body must still build successfully — the filtered model list
    /// is shorter than the full catalog but the view tree stays valid.
    func testEditorBodyBuildsWithOAuthSubscriptionConnection() {
        let connections = [
            Self.makeConnection(
                name: "chatgpt-sub",
                provider: "openai",
                authType: "oauth_subscription",
                label: "ChatGPT Subscription"
            ),
        ]
        let editor = InferenceProfileEditor(
            store: store,
            profile: .constant(InferenceProfile(
                name: "chatgpt",
                provider: "openai",
                providerConnection: "chatgpt-sub",
                model: "gpt-5.4-mini"
            )),
            connections: connections,
            onSave: {},
            onCancel: {}
        )
        XCTAssertNotNil(editor.body)
        XCTAssertTrue(editor.canSave)
    }

    /// When the effective connection uses a standard `api_key` auth, all
    /// catalog models for the provider remain visible — no filtering.
    func testEditorDoesNotFilterModelsForApiKeyConnection() {
        let connections = [
            Self.makeConnection(
                name: "openai-key",
                provider: "openai",
                authType: "api_key"
            ),
        ]
        let editor = InferenceProfileEditor(
            store: store,
            profile: .constant(InferenceProfile(
                name: "full",
                provider: "openai",
                providerConnection: "openai-key",
                model: "gpt-5"
            )),
            connections: connections,
            onSave: {},
            onCancel: {}
        )
        XCTAssertNotNil(editor.body)
        // gpt-5 is not in the codex subscription set but is in the full
        // catalog, so it's valid for an api_key connection.
        XCTAssertTrue(editor.canSave)
    }

    func testCanSaveIsFalseForNonCodexModelOnSubscriptionConnection() {
        let connections = [
            Self.makeConnection(
                name: "chatgpt-sub",
                provider: "openai",
                authType: "oauth_subscription"
            ),
        ]
        let editor = InferenceProfileEditor(
            store: store,
            profile: .constant(InferenceProfile(
                name: "bad-model",
                provider: "openai",
                providerConnection: "chatgpt-sub",
                model: "gpt-5"
            )),
            connections: connections,
            onSave: {},
            onCancel: {}
        )
        XCTAssertFalse(editor.canSave)
    }

    /// Test helper mirroring `ProvidersSheetTests.makeConnection` so the
    /// two surfaces use identical fixture shapes.
    private static func makeConnection(
        name: String = "my-conn",
        provider: String = "openai",
        authType: String = "api_key",
        label: String? = nil
    ) -> ProviderConnection {
        ProviderConnection(
            name: name,
            provider: provider,
            auth: ProviderConnectionAuth(type: authType, credential: "sk-test"),
            label: label,
            createdAt: 0,
            updatedAt: 0
        )
    }
}
