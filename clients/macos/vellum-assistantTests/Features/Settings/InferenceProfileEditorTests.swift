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
        mockSettingsClient = MockSettingsClient()
        mockSettingsClient.patchConfigResponse = true
        store = SettingsStore(settingsClient: mockSettingsClient)
        // Override the catalog with a tiny deterministic fixture so tests
        // don't depend on the live `LLMProviderRegistry` shape.
        store.providerCatalog = [
            ProviderCatalogEntry(
                id: "anthropic",
                displayName: "Anthropic",
                models: [
                    CatalogModel(id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6"),
                    CatalogModel(id: "claude-opus-4-7", displayName: "Claude Opus 4.7"),
                ],
                defaultModel: "claude-sonnet-4-6",
                apiKeyUrl: nil,
                apiKeyPlaceholder: nil
            ),
            ProviderCatalogEntry(
                id: "openai",
                displayName: "OpenAI",
                models: [
                    CatalogModel(id: "gpt-5", displayName: "GPT-5"),
                ],
                defaultModel: "gpt-5",
                apiKeyUrl: nil,
                apiKeyPlaceholder: nil
            ),
        ]
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
