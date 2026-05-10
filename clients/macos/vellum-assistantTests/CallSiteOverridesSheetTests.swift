import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Verifies the per-row profile picker logic in
/// `CallSiteOverrideRow` and the parent sheet's `selectProfile` flow:
/// - Rows with `{ profile: name }` render the named profile in the picker.
/// - Legacy rows with `{ provider, model }` render `"Custom"` and surface
///   the inline form so the user can keep editing the raw fragment.
/// - Switching from `Custom` to a named profile drops the legacy fragment
///   fields via `replaceCallSiteOverride`'s two-step PATCH flow: an
///   entry-level NSNull clear-PATCH followed by a SET-PATCH containing
///   only `{ profile }`.
@MainActor
final class CallSiteOverridesSheetTests: XCTestCase {

    private var mockSettingsClient: MockSettingsClient!
    private var store: SettingsStore!

    override func setUp() {
        super.setUp()
        let fixture = SettingsTestFixture.make()
        store = fixture.store
        mockSettingsClient = fixture.mockClient
    }

    override func tearDown() {
        store = nil
        mockSettingsClient = nil
        super.tearDown()
    }

    // MARK: - Helpers

    private func waitForPatchCount(_ expected: Int, timeout: TimeInterval = 2.0) {
        let predicate = NSPredicate { _, _ in
            self.mockSettingsClient.patchConfigCalls.count >= expected
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: timeout)
    }

    /// Returns the most recent `llm.callSites.<id>` SET payload (a
    /// dictionary entry) written to the mock client, paired with its
    /// index in the patch history. Walks the patch history newest-first
    /// and skips clear-PATCHes (which encode the entry as `NSNull`).
    private func lastEntryPatch(for id: String) -> (index: Int, entry: [String: Any])? {
        for (index, payload) in mockSettingsClient.patchConfigCalls.enumerated().reversed() {
            guard let llm = payload["llm"] as? [String: Any],
                  let sites = llm["callSites"] as? [String: Any],
                  let entry = sites[id] as? [String: Any] else { continue }
            return (index, entry)
        }
        return nil
    }

    /// Returns the index of the first patch that nulled
    /// `llm.callSites.<id>` at the entry level, or nil if no such patch
    /// exists. `replaceCallSiteOverride` must emit this clear-PATCH
    /// (`[id: NSNull()]`) before the set-PATCH; callers assert the
    /// returned index precedes the set-PATCH index.
    private func entryClearIndex(for id: String) -> Int? {
        for (index, payload) in mockSettingsClient.patchConfigCalls.enumerated() {
            guard let llm = payload["llm"] as? [String: Any],
                  let sites = llm["callSites"] as? [String: Any] else { continue }
            if sites[id] is NSNull { return index }
        }
        return nil
    }

    // MARK: - Profile picker value derivation

    func testProfilePickerRendersProfileNameWhenSet() {
        let row = CallSiteOverride(
            id: "memoryRetrieval",
            displayName: "Memory · Retrieval",
            domain: "memory",
            profile: "balanced"
        )
        XCTAssertEqual(
            CallSiteOverrideRow.profilePickerValue(for: row),
            "balanced",
            "A row with profile set must render the profile name in the picker"
        )
    }

    func testProfilePickerRendersCustomForLegacyProviderModelRow() {
        let row = CallSiteOverride(
            id: "memoryRetrieval",
            displayName: "Memory · Retrieval",
            domain: "memory",
            provider: "openai",
            model: "gpt-4.1"
        )
        XCTAssertEqual(
            CallSiteOverrideRow.profilePickerValue(for: row),
            CallSiteOverrideRow.customSentinel,
            "Legacy rows with provider+model and no profile must render as Custom"
        )
    }

    func testProfilePickerRendersCustomForProviderOnlyRow() {
        let row = CallSiteOverride(
            id: "memoryRetrieval",
            displayName: "Memory · Retrieval",
            domain: "memory",
            provider: "anthropic"
        )
        XCTAssertEqual(
            CallSiteOverrideRow.profilePickerValue(for: row),
            CallSiteOverrideRow.customSentinel,
            "A row with only a provider override is still Custom — partial fragments use the legacy form"
        )
    }

    func testProfilePickerRendersEmptyForUntouchedRow() {
        let row = CallSiteOverride(
            id: "memoryRetrieval",
            displayName: "Memory · Retrieval",
            domain: "memory"
        )
        XCTAssertEqual(
            CallSiteOverrideRow.profilePickerValue(for: row),
            "",
            "An untouched row inherits the default and must render empty in the picker"
        )
    }

    /// A row that has both `profile` and raw fragment fields must render
    /// as Custom — `resolveCallSiteConfig` applies fragments after profile
    /// layering, so the fragments would silently shadow the profile at
    /// runtime. Surfacing this state as Custom keeps the editor honest.
    func testProfilePickerRendersCustomForMixedProfileAndFragmentRow() {
        let row = CallSiteOverride(
            id: "memoryRetrieval",
            displayName: "Memory · Retrieval",
            domain: "memory",
            provider: "openai",
            model: "gpt-4.1",
            profile: "balanced"
        )
        XCTAssertEqual(
            CallSiteOverrideRow.profilePickerValue(for: row),
            CallSiteOverrideRow.customSentinel,
            "Mixed profile+fragment rows must render as Custom so the fragments are visible and editable"
        )
    }

    func testProfilePickerEmptyStringProfileTreatedAsUnset() {
        // Defense against config payloads that round-trip an empty string
        // through `loadCallSiteOverrides` — the loader normalizes empty
        // strings to nil but the picker logic should be robust to either
        // shape.
        let row = CallSiteOverride(
            id: "memoryRetrieval",
            displayName: "Memory · Retrieval",
            domain: "memory",
            profile: ""
        )
        XCTAssertEqual(
            CallSiteOverrideRow.profilePickerValue(for: row),
            "",
            "An empty-string profile must not be treated as a real selection"
        )
    }

    // MARK: - Profile selection clears stale fragment fields

    /// End-to-end: a row that was previously a `{provider, model}` Custom
    /// override switches to the `"balanced"` profile. `replaceCallSiteOverride`
    /// emits a two-patch sequence — first an entry-level NSNull clear that
    /// wipes any stale `provider`/`model`/`maxTokens`/etc. on the daemon,
    /// then a set-PATCH containing only the new `{ profile }` shape. The
    /// resolver then layers the profile cleanly without legacy fragments
    /// shadowing it.
    func testSelectingProfileClearsLegacyFragmentFieldsInPatch() {
        // Arrange: pre-populate a Custom-style override.
        store.loadCallSiteOverrides(config: [
            "llm": [
                "callSites": [
                    "memoryRetrieval": [
                        "provider": "openai",
                        "model": "gpt-4.1"
                    ]
                ]
            ]
        ])

        // Act: select the `balanced` profile, mirroring what the row does
        // when the user picks a profile name from the picker.
        _ = store.replaceCallSiteOverride(
            "memoryRetrieval",
            provider: nil,
            model: nil,
            profile: "balanced"
        )
        // replaceCallSiteOverride emits two patches: the initial null-clear
        // and then the final entry write.
        waitForPatchCount(2)

        // Assert: an entry-level clear-PATCH preceded the SET-PATCH, so any
        // stale fragment leaves on the daemon are deleted. The SET-PATCH
        // then contains only `{ profile }` — no NSNull leaves are needed
        // because the entry was already wiped. Order matters: a regression
        // that emits SET before CLEAR would leave the daemon in a cleared
        // state, so we assert the relative indices, not just presence.
        guard let clearIndex = entryClearIndex(for: "memoryRetrieval") else {
            XCTFail("replaceCallSiteOverride must first NSNull-clear the entry")
            return
        }
        guard let setPatch = lastEntryPatch(for: "memoryRetrieval") else {
            XCTFail("replaceCallSiteOverride must emit a SET-PATCH after the clear")
            return
        }
        XCTAssertLessThan(
            clearIndex, setPatch.index,
            "Entry-level clear-PATCH must precede the SET-PATCH"
        )
        let entry = setPatch.entry
        XCTAssertEqual(entry["profile"] as? String, "balanced")
        // SET-PATCH carries only `profile`; the entry-level clear deletes
        // all legacy fragment fields, so no NSNull leaves are needed here.
        XCTAssertNil(entry["provider"])
        XCTAssertNil(entry["model"])
        XCTAssertNil(entry["maxTokens"])
        XCTAssertNil(entry["effort"])
        XCTAssertNil(entry["thinking"])

        // Local cache reflects the new profile-only override.
        let cached = store.callSiteOverrides.first(where: { $0.id == "memoryRetrieval" })
        XCTAssertEqual(cached?.profile, "balanced")
        XCTAssertNil(cached?.provider)
        XCTAssertNil(cached?.model)
    }

    /// Selecting a profile when the row was already on a profile is a
    /// no-stale-fields case but should still produce a clean
    /// `profile: <name>` entry — the SET-PATCH carries only `profile`,
    /// preceded by the standard entry-level clear.
    func testSelectingProfileFromAnotherProfileEmitsCleanEntry() {
        store.loadCallSiteOverrides(config: [
            "llm": [
                "callSites": [
                    "mainAgent": ["profile": "fast"]
                ]
            ]
        ])

        _ = store.replaceCallSiteOverride(
            "mainAgent",
            provider: nil,
            model: nil,
            profile: "balanced"
        )
        waitForPatchCount(2)

        guard let clearIndex = entryClearIndex(for: "mainAgent") else {
            XCTFail("replaceCallSiteOverride must first NSNull-clear the entry")
            return
        }
        guard let setPatch = lastEntryPatch(for: "mainAgent") else {
            XCTFail("replaceCallSiteOverride must emit a SET-PATCH after the clear")
            return
        }
        XCTAssertLessThan(
            clearIndex, setPatch.index,
            "Entry-level clear-PATCH must precede the SET-PATCH"
        )
        XCTAssertEqual(setPatch.entry["profile"] as? String, "balanced")
        XCTAssertNil(setPatch.entry["provider"])
        XCTAssertNil(setPatch.entry["model"])
    }
}
