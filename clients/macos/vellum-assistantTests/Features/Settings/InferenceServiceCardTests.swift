import SwiftUI
import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Structural tests for `InferenceServiceCard`. Exercises the bindings the
/// card surfaces — Active Profile selection routing through
/// `store.setActiveProfile`, the Manage Profiles sheet toggle, and the Save
/// path no longer writing `llm.default.model`. Mirrors the `InferenceProfilesSheetTests`
/// pattern: build the SwiftUI tree without rendering, drive store-backed
/// invariants directly, and assert the patches captured by
/// `MockSettingsClient`.
@MainActor
final class InferenceServiceCardTests: XCTestCase {

    private var mockSettingsClient: MockSettingsClient!
    private var store: SettingsStore!
    private var authManager: AuthManager!
    private var apiKeyTextBox: ApiKeyTextBox!

    override func setUp() {
        super.setUp()
        mockSettingsClient = MockSettingsClient()
        mockSettingsClient.patchConfigResponse = true
        store = SettingsStore(settingsClient: mockSettingsClient)
        authManager = AuthManager()
        apiKeyTextBox = ApiKeyTextBox()
        // Tiny deterministic catalog so provider/model lookups are stable.
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
                apiKeyPlaceholder: "sk-ant-..."
            ),
            ProviderCatalogEntry(
                id: "openai",
                displayName: "OpenAI",
                models: [
                    CatalogModel(id: "gpt-5", displayName: "GPT-5"),
                ],
                defaultModel: "gpt-5",
                apiKeyUrl: nil,
                apiKeyPlaceholder: "sk-..."
            ),
        ]
        // Seed three built-in profiles so the Active Profile dropdown has
        // real options in tests.
        store.loadInferenceProfiles(config: [
            "llm": [
                "activeProfile": "balanced",
                "profiles": [
                    "balanced": [
                        "provider": "anthropic",
                        "model": "claude-sonnet-4-6",
                    ],
                    "quality-optimized": [
                        "provider": "anthropic",
                        "model": "claude-opus-4-7",
                    ],
                    "cost-optimized": [
                        "provider": "anthropic",
                        "model": "claude-sonnet-4-6",
                    ],
                ],
            ]
        ])
    }

    override func tearDown() {
        store = nil
        mockSettingsClient = nil
        authManager = nil
        apiKeyTextBox = nil
        super.tearDown()
    }

    // MARK: - Helpers

    /// Reference-typed shim so a `@Binding<String>` constructed from get/set
    /// closures can mutate state across calls. Mirrors the pattern in
    /// `InferenceProfileEditorTests` so we don't need a rendered view tree.
    @MainActor
    private final class ApiKeyTextBox {
        var text: String = ""
    }

    private func makeCard() -> InferenceServiceCard {
        InferenceServiceCard(
            store: store,
            authManager: authManager,
            apiKeyText: Binding(
                get: { self.apiKeyTextBox.text },
                set: { self.apiKeyTextBox.text = $0 }
            ),
            showToast: { _, _ in }
        )
    }

    /// Returns the most recent `llm.activeProfile` value captured by the
    /// mock client, or `nil` if no such patch has been emitted.
    private func lastActiveProfilePatch() -> String? {
        for payload in mockSettingsClient.patchConfigCalls.reversed() {
            if let llm = payload["llm"] as? [String: Any],
               let active = llm["activeProfile"] as? String {
                return active
            }
        }
        return nil
    }

    /// True when any captured `llm.default` patch has touched `model`. Used
    /// to assert the card's Save path no longer writes the model leaf.
    private func anyPatchWroteLLMDefaultModel() -> Bool {
        for payload in mockSettingsClient.patchConfigCalls {
            guard let llm = payload["llm"] as? [String: Any],
                  let llmDefault = llm["default"] as? [String: Any] else { continue }
            if llmDefault.keys.contains("model") {
                return true
            }
        }
        return false
    }

    // MARK: - Body construction

    func testCardBuildsWithDefaultStore() {
        let card = makeCard()
        XCTAssertNotNil(card.body, "Body must be constructible against the seeded store")
    }

    func testCardBuildsWhenProfileListIsEmpty() {
        // Drop all profiles and confirm the dropdown still renders. The
        // empty list is a valid state on first launch before migration 052
        // seeds the built-ins.
        store.profiles = []
        let card = makeCard()
        XCTAssertNotNil(card.body)
    }

    // MARK: - Active Profile selection

    /// Selecting a different profile in the dropdown must route through
    /// `store.setActiveProfile`, which patches `llm.activeProfile` only.
    func testSelectingActiveProfilePatchesActiveProfileOnly() async {
        XCTAssertEqual(store.activeProfile, "balanced")
        // Drive the store path the dropdown's `set:` closure invokes — the
        // card constructs the binding inline so we exercise the same
        // setActiveProfile entry point directly. This keeps the test free
        // of a view-rendering harness while preserving the contract.
        let success = await store.setActiveProfile("quality-optimized")
        XCTAssertTrue(success)
        XCTAssertEqual(store.activeProfile, "quality-optimized")

        let lastActive = lastActiveProfilePatch()
        XCTAssertEqual(lastActive, "quality-optimized")

        // The patch must touch `activeProfile` — and nothing else under
        // `llm.default`. This is the central invariant of PR 14: the
        // active profile setter is its own path, distinct from
        // `llm.default.{provider,model}`.
        XCTAssertFalse(
            anyPatchWroteLLMDefaultModel(),
            "Active Profile selection must not write llm.default.model"
        )
    }

    func testSettingActiveProfileMultipleTimesCapturesEachPatch() async {
        _ = await store.setActiveProfile("quality-optimized")
        _ = await store.setActiveProfile("cost-optimized")

        let activePatches = mockSettingsClient.patchConfigCalls.compactMap { payload -> String? in
            guard let llm = payload["llm"] as? [String: Any],
                  let active = llm["activeProfile"] as? String else { return nil }
            return active
        }
        XCTAssertEqual(activePatches, ["quality-optimized", "cost-optimized"])
    }

    // MARK: - Manage Profiles sheet

    /// The "Manage Profiles…" button toggles a local `@State` that drives a
    /// `.sheet(isPresented:)` modifier on the card, which presents
    /// `InferenceProfilesSheet`. Constructing both views without rendering
    /// confirms the wiring compiles and the sheet is reachable.
    func testManageProfilesSheetIsConstructible() {
        let card = makeCard()
        // Body construction validates the sheet modifier compiles against
        // the shared store.
        XCTAssertNotNil(card.body)

        // Confirm the sheet itself can be built directly with the same
        // store the card hands it. This catches API drift in
        // `InferenceProfilesSheet`'s init (its presentation API is the
        // contract PR 14 depends on).
        let isPresented = Binding<Bool>(get: { true }, set: { _ in })
        let sheet = InferenceProfilesSheet(store: store, isPresented: isPresented)
        XCTAssertNotNil(sheet.body)
    }

    // MARK: - Save flow no longer writes llm.default.model

    /// Persisting a provider change writes `llm.default.provider` only.
    /// This is the second central invariant of PR 14: Save no longer
    /// touches `llm.default.model`.
    func testProviderOnlySetterPatchesProviderWithoutModel() async {
        let task = store.setLLMDefaultProvider("openai")
        _ = await task.value

        // Find the captured provider patch.
        let providerPatches = mockSettingsClient.patchConfigCalls.compactMap { payload -> [String: Any]? in
            guard let llm = payload["llm"] as? [String: Any],
                  let llmDefault = llm["default"] as? [String: Any] else { return nil }
            return llmDefault
        }
        XCTAssertEqual(providerPatches.count, 1, "Provider-only setter must emit exactly one patch")
        XCTAssertEqual(providerPatches.first?["provider"] as? String, "openai")
        XCTAssertNil(
            providerPatches.first?["model"],
            "Provider-only setter must not include the model leaf"
        )

        XCTAssertFalse(
            anyPatchWroteLLMDefaultModel(),
            "PR 14 invariant: the inference card's Save path never writes llm.default.model"
        )
    }

    // MARK: - Profiles list flows through to dropdown options

    /// The dropdown options come from `store.profiles.map { $0.name }` —
    /// loading new profiles into the store must surface them as picker
    /// options. We assert the underlying contract here so a future refactor
    /// of the card's options-builder cannot silently desync from the store.
    func testProfileListSurfacesAlphabeticallyForDropdown() {
        let names = store.profiles.map(\.name)
        XCTAssertEqual(names, names.sorted(), "Store sorts profiles alphabetically")
        XCTAssertEqual(Set(names), ["balanced", "cost-optimized", "quality-optimized"])
    }
}
