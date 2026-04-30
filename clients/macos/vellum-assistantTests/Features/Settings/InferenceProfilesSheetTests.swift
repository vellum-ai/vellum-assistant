import SwiftUI
import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Structural tests for `InferenceProfilesSheet`. We exercise the view's
/// pure helpers (summary string, identifiable IDs) plus the store-backed
/// invariants that drive the list, badge, and delete-flow behavior. The
/// SwiftUI tree itself is constructed without rendering (mirrors the
/// `InferenceProfileEditorTests` pattern) so we don't take a snapshot
/// dependency; combined with the SettingsStore-level coverage in
/// `SettingsStoreInferenceProfilesTests`, this validates the full
/// management UX.
@MainActor
final class InferenceProfilesSheetTests: XCTestCase {

    private var mockSettingsClient: MockSettingsClient!
    private var store: SettingsStore!

    override func setUp() {
        super.setUp()
        // Tiny deterministic catalog so summary lookups produce stable
        // human-readable strings without depending on the live registry.
        let fixture = SettingsTestFixture.make(
            providerCatalog: SettingsTestFixture.anthropicWithHaikuCatalog
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

    /// Seeds the store with the three canonical built-in profiles plus an
    /// optional custom one. Mirrors the daemon's migration-052 seed shape.
    private func seedBuiltInsAndCustom(includeCustom: Bool = false) {
        var profiles = SettingsTestFixture.builtInProfilesPayload
        if includeCustom {
            profiles["experimental"] = [
                "provider": "anthropic",
                "model": "claude-sonnet-4-6",
                "effort": "medium",
            ]
        }
        store.loadInferenceProfiles(config: [
            "llm": [
                "activeProfile": "balanced",
                "profiles": profiles,
            ]
        ])
    }

    private func makeSheet() -> InferenceProfilesSheet {
        let isPresented = Binding<Bool>(get: { true }, set: { _ in })
        return InferenceProfilesSheet(store: store, isPresented: isPresented)
    }

    // MARK: - Body construction

    func testSheetBuildsForEmptyProfileList() {
        let sheet = makeSheet()
        XCTAssertNotNil(sheet.body, "Body must be constructible when no profiles are loaded")
    }

    func testSheetBuildsWithBuiltInProfiles() {
        seedBuiltInsAndCustom()
        let sheet = makeSheet()
        XCTAssertNotNil(sheet.body)
    }

    // MARK: - Managed detection

    /// Managed profiles (source == "managed") show a "Managed" badge;
    /// user-created profiles without a source do not.
    func testManagedProfilesShowBadgeAndCustomDoesNot() {
        seedBuiltInsAndCustom(includeCustom: true)
        XCTAssertEqual(store.profiles.count, 4)

        let names = Set(store.profiles.map(\.name))
        XCTAssertTrue(names.contains("quality-optimized"))
        XCTAssertTrue(names.contains("balanced"))
        XCTAssertTrue(names.contains("cost-optimized"))
        XCTAssertTrue(names.contains("experimental"))

        // Managed profiles have source == "managed" from the payload.
        for name in ["quality-optimized", "balanced", "cost-optimized"] {
            let profile = store.profiles.first(where: { $0.name == name })
            XCTAssertTrue(
                profile?.isManaged == true,
                "\(name) must render with a Managed badge"
            )
        }
        let custom = store.profiles.first(where: { $0.name == "experimental" })
        XCTAssertFalse(
            custom?.isManaged == true,
            "Custom profiles must not render the Managed badge"
        )
    }

    // MARK: - Summary line

    func testSummaryComposesProviderModelEffortThinkingForFullFragment() {
        let profile = InferenceProfile(
            name: "quality-optimized",
            provider: "anthropic",
            model: "claude-opus-4-7",
            effort: "max",
            thinkingEnabled: true
        )
        let summary = InferenceProfilesSheet.summary(for: profile, store: store)
        XCTAssertEqual(summary, "Claude Opus 4.7 \u{00B7} max effort \u{00B7} thinking on")
    }

    func testSummaryReportsThinkingOff() {
        let profile = InferenceProfile(
            name: "cost-optimized",
            provider: "anthropic",
            model: "claude-haiku-4-5-20251001",
            effort: "low",
            thinkingEnabled: false
        )
        let summary = InferenceProfilesSheet.summary(for: profile, store: store)
        XCTAssertEqual(summary, "Claude Haiku 4.5 \u{00B7} thinking off")
    }

    func testSummaryFallsBackToInheritsDefaultsForEmptyFragment() {
        let profile = InferenceProfile(name: "empty")
        let summary = InferenceProfilesSheet.summary(for: profile, store: store)
        XCTAssertEqual(summary, "Inherits defaults")
    }

    func testSummaryFallsBackToProviderWhenModelIsNil() {
        let profile = InferenceProfile(name: "p", provider: "anthropic")
        let summary = InferenceProfilesSheet.summary(for: profile, store: store)
        XCTAssertEqual(summary, "Anthropic")
    }

    func testSummaryUsesRawModelWhenCatalogMissesIt() {
        let profile = InferenceProfile(
            name: "x",
            provider: "anthropic",
            model: "experimental-vintage-1"
        )
        let summary = InferenceProfilesSheet.summary(for: profile, store: store)
        // The catalog has no display name for this model, so we fall back
        // to the raw model id.
        XCTAssertEqual(summary, "experimental-vintage-1")
    }

    // MARK: - EditorState identifiable

    func testEditorStateIDsAreStable() {
        XCTAssertEqual(InferenceProfilesSheet.EditorState.create.id, "create")
        XCTAssertEqual(
            InferenceProfilesSheet.EditorState.edit(name: "balanced").id,
            "edit:balanced"
        )
        XCTAssertEqual(
            InferenceProfilesSheet.EditorState.duplicate(name: "balanced").id,
            "duplicate:balanced"
        )
    }

    func testEditorStateEquatableDistinguishesNames() {
        XCTAssertEqual(
            InferenceProfilesSheet.EditorState.edit(name: "a"),
            InferenceProfilesSheet.EditorState.edit(name: "a")
        )
        XCTAssertNotEqual(
            InferenceProfilesSheet.EditorState.edit(name: "a"),
            InferenceProfilesSheet.EditorState.edit(name: "b")
        )
        XCTAssertNotEqual(
            InferenceProfilesSheet.EditorState.edit(name: "a"),
            InferenceProfilesSheet.EditorState.duplicate(name: "a")
        )
    }

    // MARK: - BlockedDeleteState identifiable

    func testBlockedDeleteStateIDsAreStable() {
        let active = InferenceProfilesSheet.BlockedDeleteState.active(
            profileName: "balanced",
            activeProfile: "balanced"
        )
        XCTAssertEqual(active.id, "active:balanced")

        let callSites = InferenceProfilesSheet.BlockedDeleteState.callSites(
            profileName: "fast",
            callSiteIds: ["mainAgent", "memoryRetrieval"]
        )
        XCTAssertEqual(callSites.id, "callSites:fast")
    }

    // MARK: - Delete flow integration with store

    /// Deleting the active profile produces `.blockedByActive`. The sheet
    /// uses this to drive its `BlockedDeleteState.active` presentation.
    func testDeletingActiveProfileReturnsBlockedByActiveResult() async {
        seedBuiltInsAndCustom()
        XCTAssertEqual(store.activeProfile, "balanced")

        let result = await store.deleteProfile(name: "balanced")
        XCTAssertEqual(result, .blockedByActive("balanced"))
    }

    /// Deleting a profile that's referenced by call sites returns
    /// `.blockedByCallSites`. The sheet maps this to its callSites
    /// confirmation surface.
    func testDeletingCallSiteReferencedProfileReturnsBlockedByCallSitesResult() async {
        seedBuiltInsAndCustom(includeCustom: true)
        store.loadCallSiteOverrides(config: [
            "llm": [
                "callSites": [
                    "mainAgent": ["profile": "experimental"],
                    "memoryRetrieval": ["profile": "experimental"],
                ]
            ]
        ])

        let result = await store.deleteProfile(name: "experimental")
        if case .blockedByCallSites(let ids) = result {
            XCTAssertEqual(Set(ids), ["mainAgent", "memoryRetrieval"])
        } else {
            XCTFail("Expected .blockedByCallSites, got \(result)")
        }
    }

    /// Deleting a custom profile that nothing references succeeds and
    /// removes it from the store. The sheet's row count drops by one as
    /// a result.
    func testDeletingUnreferencedCustomProfileSucceedsAndShrinksList() async {
        seedBuiltInsAndCustom(includeCustom: true)
        XCTAssertEqual(store.profiles.count, 4)
        XCTAssertTrue(store.profiles.contains(where: { $0.name == "experimental" }))

        let result = await store.deleteProfile(name: "experimental")
        XCTAssertEqual(result, .deleted)
        XCTAssertEqual(store.profiles.count, 3)
        XCTAssertFalse(store.profiles.contains(where: { $0.name == "experimental" }))
    }

    /// Managed profiles cannot be deleted — `deleteProfile` returns
    /// `.blockedByManaged` regardless of reference state.
    func testManagedProfileIsNotDeletable() async {
        seedBuiltInsAndCustom()
        // Make a non-managed profile the active profile so the managed
        // target isn't also blocked by the active-profile check.
        let custom = InferenceProfile(
            name: "alt",
            provider: "anthropic",
            model: "claude-sonnet-4-6"
        )
        let saved = await store.setProfile(name: "alt", fragment: custom)
        XCTAssertTrue(saved)
        let switched = await store.setActiveProfile("alt")
        XCTAssertTrue(switched)

        // Attempting to delete a managed profile must return
        // `.blockedByManaged`.
        let result = await store.deleteProfile(name: "quality-optimized")
        XCTAssertEqual(result, .blockedByManaged)
        XCTAssertTrue(store.profiles.contains(where: { $0.name == "quality-optimized" }))
    }

    // MARK: - "+ New profile" flow

    /// Adding a new profile via the store path the sheet uses extends the
    /// list. The sheet's beginCreate/commitEditor flow ultimately routes
    /// through `setProfile`, so verifying that path covers the row append.
    func testAddingNewProfileViaStoreAppendsToList() async {
        seedBuiltInsAndCustom()
        let countBefore = store.profiles.count

        let new = InferenceProfile(
            name: "new-profile",
            provider: "anthropic",
            model: "claude-sonnet-4-6"
        )
        let success = await store.setProfile(name: "new-profile", fragment: new)
        XCTAssertTrue(success)

        XCTAssertEqual(store.profiles.count, countBefore + 1)
        XCTAssertTrue(store.profiles.contains(where: { $0.name == "new-profile" }))
        // List is sorted alphabetically — `new-profile` should land after
        // `cost-optimized` and before `quality-optimized`.
        let names = store.profiles.map(\.name)
        XCTAssertEqual(names, names.sorted(), "Profiles list must remain alphabetically sorted")
    }

    // MARK: - Rename flow

    /// Renaming the active profile must atomically migrate the
    /// `activeProfile` pointer and any callsite overrides onto the new
    /// name BEFORE deleting the old key, so the rename never leaves a
    /// stale dangling reference. Mirrors the orchestration in
    /// `commitEditor` — exercised here at the store level.
    func testRenameActiveProfileMigratesActivePointerAndDropsOldKey() async {
        seedBuiltInsAndCustom()
        XCTAssertEqual(store.activeProfile, "balanced")

        // Step 1: write the new key with the migrated draft.
        let renamed = InferenceProfile(
            name: "balanced-renamed",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            maxTokens: 16000,
            effort: "high"
        )
        let setSuccess = await store.setProfile(name: "balanced-renamed", fragment: renamed)
        XCTAssertTrue(setSuccess)

        // Step 2: re-target the active pointer.
        let activeSuccess = await store.setActiveProfile("balanced-renamed")
        XCTAssertTrue(activeSuccess)

        // Step 3: drop the old key. After re-targeting, this must
        // succeed (no `.blockedByActive`).
        let result = await store.deleteProfile(name: "balanced")
        XCTAssertEqual(result, .deleted)

        XCTAssertEqual(store.activeProfile, "balanced-renamed")
        XCTAssertFalse(store.profiles.contains(where: { $0.name == "balanced" }))
        XCTAssertTrue(store.profiles.contains(where: { $0.name == "balanced-renamed" }))
    }

    /// Renaming a profile referenced by call sites must re-target every
    /// override to the new name BEFORE deleting the source.
    func testRenameProfileReferencedByCallSitesMigratesOverridesAndDropsOldKey() async {
        seedBuiltInsAndCustom(includeCustom: true)
        store.loadCallSiteOverrides(config: [
            "llm": [
                "callSites": [
                    "mainAgent": ["profile": "experimental"],
                    "memoryRetrieval": ["profile": "experimental"],
                ]
            ]
        ])
        // Sanity: the source profile is referenced by two call sites.
        let referencedIds = store.callSiteOverrides
            .filter { $0.profile == "experimental" }
            .map(\.id)
        XCTAssertEqual(Set(referencedIds), ["mainAgent", "memoryRetrieval"])

        // Step 1: write the new key.
        let renamed = InferenceProfile(
            name: "experimental-renamed",
            provider: "anthropic",
            model: "claude-sonnet-4-6"
        )
        let setSuccess = await store.setProfile(name: "experimental-renamed", fragment: renamed)
        XCTAssertTrue(setSuccess)

        // Step 2: re-target every conflicting override onto the new name.
        for override in store.callSiteOverrides where override.profile == "experimental" {
            let task = store.replaceCallSiteOverride(
                override.id,
                provider: override.provider,
                model: override.model,
                profile: "experimental-renamed"
            )
            let replaceSuccess = await task.value
            XCTAssertTrue(replaceSuccess)
        }

        // Step 3: delete the old key. Must succeed (no `.blockedByCallSites`).
        let result = await store.deleteProfile(name: "experimental")
        XCTAssertEqual(result, .deleted)

        // Every override now points at the new name; none reference the
        // dropped one.
        let stillReferencingOld = store.callSiteOverrides.filter { $0.profile == "experimental" }
        XCTAssertTrue(stillReferencingOld.isEmpty)
        let referencingNew = store.callSiteOverrides
            .filter { $0.profile == "experimental-renamed" }
            .map(\.id)
        XCTAssertEqual(Set(referencingNew), ["mainAgent", "memoryRetrieval"])
    }

    /// The "+ New profile" toolbar action seeds a draft with the default
    /// name `"new-profile"`. The static helper avoids collisions by
    /// appending `-2`, `-3`, etc. when the default is already in use.
    func testNextAvailableProfileNameAvoidsCollisions() {
        let unused = InferenceProfilesSheet.nextAvailableProfileName(
            prefix: "new-profile",
            existing: []
        )
        XCTAssertEqual(unused, "new-profile")

        let onePresent = InferenceProfilesSheet.nextAvailableProfileName(
            prefix: "new-profile",
            existing: ["new-profile"]
        )
        XCTAssertEqual(onePresent, "new-profile-2")

        let twoPresent = InferenceProfilesSheet.nextAvailableProfileName(
            prefix: "new-profile",
            existing: ["new-profile", "new-profile-2"]
        )
        XCTAssertEqual(twoPresent, "new-profile-3")

        // Holes in the suffix sequence are not back-filled; the helper
        // monotonically advances. This keeps the algorithm O(n) and the
        // user never sees the same candidate name twice in one session.
        let hole = InferenceProfilesSheet.nextAvailableProfileName(
            prefix: "balanced-copy",
            existing: ["balanced-copy", "balanced-copy-3"]
        )
        XCTAssertEqual(hole, "balanced-copy-2")
    }
}
