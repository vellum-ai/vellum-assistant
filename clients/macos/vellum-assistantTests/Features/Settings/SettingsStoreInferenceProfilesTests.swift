import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Verifies the inference-profile state and CRUD APIs on `SettingsStore`:
/// daemon-push parsing into `profiles` / `activeProfile`, profile create/
/// update via `setProfile`, active selection via `setActiveProfile`,
/// reference-aware deletion via `deleteProfile`, and the
/// `replaceCallSiteOverride` adjustment that clears stale fragment
/// fields when assigning a profile.
@MainActor
final class SettingsStoreInferenceProfilesTests: XCTestCase {

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

    /// Returns the most recent `llm.profiles` patch payload captured by
    /// the mock client, or `nil` if no such patch has been emitted.
    private func lastProfilesPatch() -> [String: Any]? {
        for payload in mockSettingsClient.patchConfigCalls.reversed() {
            if let llm = payload["llm"] as? [String: Any],
               let profiles = llm["profiles"] as? [String: Any] {
                return profiles
            }
        }
        return nil
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

    // MARK: - Initial state

    func testInitialStateSeedsBalancedActiveProfile() {
        XCTAssertEqual(store.activeProfile, "balanced")
        XCTAssertTrue(store.profiles.isEmpty)
    }

    // MARK: - Daemon push parsing

    func testLoadInferenceProfilesPopulatesPublishedState() {
        let config: [String: Any] = [
            "llm": [
                "activeProfile": "quality-optimized",
                "profiles": [
                    "balanced": [
                        "provider": "anthropic",
                        "model": "claude-sonnet-4-6",
                        "maxTokens": 16000,
                        "effort": "high",
                        "thinking": ["enabled": true, "streamThinking": true],
                    ],
                    "quality-optimized": [
                        "provider": "anthropic",
                        "model": "claude-opus-4-7",
                        "maxTokens": 32000,
                        "effort": "max",
                        "thinking": ["enabled": true, "streamThinking": true],
                    ],
                    "cost-optimized": [
                        "provider": "anthropic",
                        "model": "claude-haiku-4-5-20251001",
                        "maxTokens": 8192,
                        "effort": "low",
                        "thinking": ["enabled": false, "streamThinking": false],
                    ],
                ],
            ]
        ]

        store.loadInferenceProfiles(config: config)

        XCTAssertEqual(store.activeProfile, "quality-optimized")
        XCTAssertEqual(store.profiles.count, 3)

        // Profiles render in alphabetical order so the UI list is stable
        // across config refreshes.
        XCTAssertEqual(store.profiles.map(\.name), ["balanced", "cost-optimized", "quality-optimized"])

        let balanced = store.profiles.first(where: { $0.name == "balanced" })
        XCTAssertEqual(balanced?.provider, "anthropic")
        XCTAssertEqual(balanced?.model, "claude-sonnet-4-6")
        XCTAssertEqual(balanced?.maxTokens, 16000)
        XCTAssertEqual(balanced?.effort, "high")
        XCTAssertEqual(balanced?.thinkingEnabled, true)
        XCTAssertEqual(balanced?.thinkingStreamThinking, true)
    }

    func testLoadInferenceProfilesEmptyConfigKeepsDefaultActiveProfile() {
        store.loadInferenceProfiles(config: [:])
        XCTAssertEqual(store.activeProfile, "balanced", "Empty config must not clobber the seeded default")
        XCTAssertTrue(store.profiles.isEmpty)
    }

    func testLoadInferenceProfilesReplacesPriorState() {
        store.loadInferenceProfiles(config: [
            "llm": [
                "activeProfile": "fast",
                "profiles": ["fast": ["model": "claude-haiku-4-5"]],
            ]
        ])
        XCTAssertEqual(store.activeProfile, "fast")
        XCTAssertEqual(store.profiles.map(\.name), ["fast"])

        // Reload against a config with different profiles — old entries
        // must be evicted, not merged.
        store.loadInferenceProfiles(config: [
            "llm": [
                "activeProfile": "balanced",
                "profiles": ["balanced": ["model": "claude-sonnet-4-6"]],
            ]
        ])
        XCTAssertEqual(store.activeProfile, "balanced")
        XCTAssertEqual(store.profiles.map(\.name), ["balanced"])
    }

    // MARK: - setActiveProfile

    func testSetActiveProfileRoundTrips() async {
        let success = await store.setActiveProfile("quality-optimized")
        XCTAssertTrue(success)
        XCTAssertEqual(store.activeProfile, "quality-optimized")
        XCTAssertEqual(lastActiveProfilePatch(), "quality-optimized")
    }

    func testSetActiveProfileFailureLeavesLocalStateUntouched() async {
        mockSettingsClient.patchConfigResponse = false
        let success = await store.setActiveProfile("quality-optimized")
        XCTAssertFalse(success)
        XCTAssertEqual(
            store.activeProfile,
            "balanced",
            "Local state must not advance when the daemon PATCH fails"
        )
    }

    // MARK: - setProfile

    func testSetProfileRoundTripsAndUpdatesPublishedState() async {
        let fragment = InferenceProfile(
            name: "fast",
            provider: "anthropic",
            model: "claude-haiku-4-5",
            maxTokens: 4096,
            effort: "low",
            thinkingEnabled: false,
            thinkingStreamThinking: false
        )
        let success = await store.setProfile(name: "fast", fragment: fragment)
        XCTAssertTrue(success)

        let profiles = lastProfilesPatch()
        XCTAssertNotNil(profiles)
        let fast = profiles?["fast"] as? [String: Any]
        XCTAssertEqual(fast?["provider"] as? String, "anthropic")
        XCTAssertEqual(fast?["model"] as? String, "claude-haiku-4-5")
        XCTAssertEqual(fast?["maxTokens"] as? Int, 4096)
        XCTAssertEqual(fast?["effort"] as? String, "low")
        let thinking = fast?["thinking"] as? [String: Any]
        XCTAssertEqual(thinking?["enabled"] as? Bool, false)
        XCTAssertEqual(thinking?["streamThinking"] as? Bool, false)

        // Local cache reflects the new profile.
        XCTAssertEqual(store.profiles.map(\.name), ["fast"])
        let stored = store.profiles.first(where: { $0.name == "fast" })
        XCTAssertEqual(stored?.model, "claude-haiku-4-5")
    }

    func testSetProfileUpdatesExistingEntry() async {
        store.loadInferenceProfiles(config: [
            "llm": [
                "profiles": [
                    "balanced": [
                        "provider": "anthropic",
                        "model": "claude-sonnet-4-6",
                    ]
                ]
            ]
        ])
        XCTAssertEqual(store.profiles.count, 1)

        let updated = InferenceProfile(
            name: "balanced",
            provider: "openai",
            model: "gpt-5"
        )
        let success = await store.setProfile(name: "balanced", fragment: updated)
        XCTAssertTrue(success)

        XCTAssertEqual(store.profiles.count, 1, "Updating an existing profile must not duplicate the entry")
        let stored = store.profiles.first(where: { $0.name == "balanced" })
        XCTAssertEqual(stored?.provider, "openai")
        XCTAssertEqual(stored?.model, "gpt-5")
    }

    // MARK: - deleteProfile blocked-by-active

    func testDeleteProfileBlockedByActive() async {
        store.loadInferenceProfiles(config: [
            "llm": [
                "activeProfile": "balanced",
                "profiles": [
                    "balanced": ["model": "claude-sonnet-4-6"],
                    "fast": ["model": "claude-haiku-4-5"],
                ],
            ]
        ])
        XCTAssertEqual(store.activeProfile, "balanced")

        let result = await store.deleteProfile(name: "balanced")
        XCTAssertEqual(result, .blockedByActive("balanced"))
        // Must not emit a PATCH when blocked.
        XCTAssertNil(lastProfilesPatch())
        // Profile must still be present locally.
        XCTAssertTrue(store.profiles.contains(where: { $0.name == "balanced" }))
    }

    // MARK: - deleteProfile blocked-by-call-sites

    func testDeleteProfileBlockedByCallSites() async {
        store.loadInferenceProfiles(config: [
            "llm": [
                "activeProfile": "balanced",
                "profiles": [
                    "balanced": ["model": "claude-sonnet-4-6"],
                    "fast": ["model": "claude-haiku-4-5"],
                ],
            ]
        ])
        store.loadCallSiteOverrides(config: [
            "llm": [
                "callSites": [
                    "memoryRetrieval": ["profile": "fast"],
                    "mainAgent": ["profile": "fast"],
                    "watchSummary": ["provider": "openai"],
                ]
            ]
        ])

        let result = await store.deleteProfile(name: "fast")
        if case .blockedByCallSites(let ids) = result {
            XCTAssertEqual(Set(ids), ["memoryRetrieval", "mainAgent"])
        } else {
            XCTFail("Expected .blockedByCallSites, got \(result)")
        }
        XCTAssertNil(lastProfilesPatch())
        XCTAssertTrue(store.profiles.contains(where: { $0.name == "fast" }))
    }

    // MARK: - deleteProfile success

    func testDeleteProfileSucceedsWhenUnreferenced() async {
        store.loadInferenceProfiles(config: [
            "llm": [
                "activeProfile": "balanced",
                "profiles": [
                    "balanced": ["model": "claude-sonnet-4-6"],
                    "experimental": ["model": "experimental-model"],
                ],
            ]
        ])

        let result = await store.deleteProfile(name: "experimental")
        XCTAssertEqual(result, .deleted)

        let profiles = lastProfilesPatch()
        XCTAssertNotNil(profiles?["experimental"])
        XCTAssertTrue(profiles?["experimental"] is NSNull, "Delete must PATCH NSNull at the profile key")

        // Local cache reflects the deletion.
        XCTAssertFalse(store.profiles.contains(where: { $0.name == "experimental" }))
        XCTAssertTrue(store.profiles.contains(where: { $0.name == "balanced" }))
    }

    func testDeleteProfileFailureSurfacedAsFailed() async {
        store.loadInferenceProfiles(config: [
            "llm": [
                "activeProfile": "balanced",
                "profiles": [
                    "balanced": ["model": "claude-sonnet-4-6"],
                    "experimental": ["model": "x"],
                ],
            ]
        ])
        mockSettingsClient.patchConfigResponse = false

        let result = await store.deleteProfile(name: "experimental")
        XCTAssertEqual(result, .failed)
        // Local cache must remain intact when the daemon PATCH fails.
        XCTAssertTrue(store.profiles.contains(where: { $0.name == "experimental" }))
    }

    // MARK: - replaceCallSiteOverride profile-only stale-clear

    /// When `replaceCallSiteOverride` is invoked with `profile` set and
    /// no raw `provider`/`model`, the second PATCH must explicitly null
    /// out the fragment leaves so any stale `provider`/`model`/
    /// `maxTokens`/`effort`/etc. don't shadow the profile in the
    /// resolver. The first (entry-level) clear PATCH already handles
    /// the same job, but emitting both shores up the contract under
    /// flaky network conditions where the clear could be retried out
    /// of order.
    func testReplaceCallSiteOverrideClearsFragmentLeavesWhenAssigningProfile() async {
        _ = store.replaceCallSiteOverride("memoryRetrieval", profile: "fast")
        // Wait for both the clear and set PATCHes to flush.
        let predicate = NSPredicate { _, _ in
            self.mockSettingsClient.patchConfigCalls.count >= 2
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        await fulfillment(of: [expectation], timeout: 2.0)

        // Locate the SET payload — second of the two callSites PATCHes
        // emitted by replaceCallSiteOverride. The first clears the
        // entry; the second writes the new fragment.
        var setPayloadEntry: [String: Any]?
        var sawClear = false
        for payload in mockSettingsClient.patchConfigCalls {
            guard let llm = payload["llm"] as? [String: Any],
                  let sites = llm["callSites"] as? [String: Any],
                  let entry = sites["memoryRetrieval"] else { continue }
            if entry is NSNull {
                sawClear = true
                continue
            }
            if let dict = entry as? [String: Any] {
                setPayloadEntry = dict
            }
        }
        XCTAssertTrue(sawClear, "replaceCallSiteOverride must first NSNull-clear the entry")
        XCTAssertNotNil(setPayloadEntry, "replaceCallSiteOverride must follow the clear with a set PATCH")
        XCTAssertEqual(setPayloadEntry?["profile"] as? String, "fast")
        // Fragment leaves must be NSNull-cleared in the same SET PATCH so
        // any concurrent persisted state is overwritten with deletes.
        XCTAssertTrue(setPayloadEntry?["provider"] is NSNull)
        XCTAssertTrue(setPayloadEntry?["model"] is NSNull)
        XCTAssertTrue(setPayloadEntry?["maxTokens"] is NSNull)
        XCTAssertTrue(setPayloadEntry?["effort"] is NSNull)
        XCTAssertTrue(setPayloadEntry?["speed"] is NSNull)
        XCTAssertTrue(setPayloadEntry?["verbosity"] is NSNull)
        XCTAssertTrue(setPayloadEntry?["temperature"] is NSNull)
        XCTAssertTrue(setPayloadEntry?["thinking"] is NSNull)
        XCTAssertTrue(setPayloadEntry?["contextWindow"] is NSNull)
    }

    /// Sanity-check that the stale-clear behavior does NOT trigger when
    /// the caller passes a raw provider/model fragment ("Custom" path):
    /// the SET payload must contain the raw fields verbatim, no NSNull
    /// clears.
    func testReplaceCallSiteOverrideDoesNotInjectNullsForRawFragmentWrite() async {
        _ = store.replaceCallSiteOverride(
            "memoryRetrieval",
            provider: "openai",
            model: "gpt-4.1"
        )
        let predicate = NSPredicate { _, _ in
            self.mockSettingsClient.patchConfigCalls.count >= 2
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        await fulfillment(of: [expectation], timeout: 2.0)

        var setPayloadEntry: [String: Any]?
        for payload in mockSettingsClient.patchConfigCalls {
            guard let llm = payload["llm"] as? [String: Any],
                  let sites = llm["callSites"] as? [String: Any],
                  let entry = sites["memoryRetrieval"] as? [String: Any] else { continue }
            setPayloadEntry = entry
        }
        XCTAssertNotNil(setPayloadEntry)
        XCTAssertEqual(setPayloadEntry?["provider"] as? String, "openai")
        XCTAssertEqual(setPayloadEntry?["model"] as? String, "gpt-4.1")
        XCTAssertNil(setPayloadEntry?["profile"])
        // No NSNull-clear should leak into the raw-fragment path.
        XCTAssertNil(setPayloadEntry?["maxTokens"])
        XCTAssertNil(setPayloadEntry?["effort"])
        XCTAssertNil(setPayloadEntry?["thinking"])
    }
}
