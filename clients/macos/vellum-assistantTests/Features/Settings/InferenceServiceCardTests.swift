import SwiftUI
import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Structural tests for `InferenceServiceCard`. Exercises the bindings the
/// card surfaces — Active Profile selection routing through
/// `store.setActiveProfile` and the management sheet toggles. Mirrors the
/// `InferenceProfilesSheetTests` pattern: build the SwiftUI tree without
/// rendering, drive store-backed invariants directly, and assert the
/// patches captured by `MockSettingsClient`.
@MainActor
final class InferenceServiceCardTests: XCTestCase {

    private var mockSettingsClient: MockSettingsClient!
    private var store: SettingsStore!

    override func setUp() {
        super.setUp()
        // Tiny deterministic catalog so provider/model lookups are stable.
        let fixture = SettingsTestFixture.make(
            providerCatalog: SettingsTestFixture.anthropicAndOpenAICatalog(
                anthropicApiKeyPlaceholder: "sk-ant-...",
                openaiApiKeyPlaceholder: "sk-..."
            )
        )
        store = fixture.store
        mockSettingsClient = fixture.mockClient
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
        super.tearDown()
    }

    // MARK: - Helpers

    private func makeCard() -> InferenceServiceCard {
        InferenceServiceCard(
            store: store,
            assistantFeatureFlagStore: AssistantFeatureFlagStore(),
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
    /// to assert that flows driven from this card never mutate the model
    /// leaf — model selection lives inside inference profiles.
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
        // `llm.default`. The active profile setter is its own path,
        // distinct from `llm.default.{provider,model}`.
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
        XCTAssertNotNil(card.body)

        let isPresented = Binding<Bool>(get: { true }, set: { _ in })
        let sheet = InferenceProfilesSheet(store: store, isPresented: isPresented)
        XCTAssertNotNil(sheet.body)
    }

    // MARK: - Providers sheet

    /// The "Providers" button in `secondaryActionsRow` toggles `showProvidersSheet`
    /// which presents `ProvidersSheet`. Verify both views build with the shared store.
    func testProvidersSheetIsConstructible() {
        let card = makeCard()
        XCTAssertNotNil(card.body)

        let isPresented = Binding<Bool>(get: { true }, set: { _ in })
        let sheet = ProvidersSheet(store: store, isPresented: isPresented)
        XCTAssertNotNil(sheet.body, "ProvidersSheet must be constructible with the card's store")
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
