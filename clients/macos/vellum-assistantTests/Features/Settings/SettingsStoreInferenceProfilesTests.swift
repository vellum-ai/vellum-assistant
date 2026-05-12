import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Verifies the inference-profile state and CRUD APIs on `SettingsStore`:
/// daemon-push parsing into `profiles` / `activeProfile`, profile create/
/// update via `setProfile`, active selection via `setActiveProfile`,
/// reference-aware deletion via `deleteProfile`, and the two-step
/// clear-then-write semantics of `replaceCallSiteOverride` when
/// assigning a profile.
@MainActor
final class SettingsStoreInferenceProfilesTests: XCTestCase {

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

    /// Returns the most recent `llm.profileOrder` patch payload captured by
    /// the mock client, or `nil` if no such patch has been emitted.
    private func lastProfileOrderPatch() -> [String]? {
        for payload in mockSettingsClient.patchConfigCalls.reversed() {
            if let llm = payload["llm"] as? [String: Any],
               let order = llm["profileOrder"] as? [String] {
                return order
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

    func testLoadInferenceProfilesUsesExplicitOrderAndNormalizesStaleEntries() {
        store.loadInferenceProfiles(config: [
            "llm": [
                "activeProfile": "fast",
                "profileOrder": ["fast", "missing", "fast"],
                "profiles": [
                    "balanced": ["model": "claude-sonnet-4-6"],
                    "fast": ["model": "claude-haiku-4-5"],
                    "quality-optimized": ["model": "claude-opus-4-7"],
                ],
            ]
        ])

        XCTAssertEqual(store.activeProfile, "fast")
        XCTAssertEqual(store.profiles.map(\.name), ["fast", "balanced", "quality-optimized"])
        XCTAssertEqual(store.profileOrder, ["fast", "balanced", "quality-optimized"])
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

    func testSetProfileAppendsToExplicitProfileOrder() async {
        store.loadInferenceProfiles(config: [
            "llm": [
                "profileOrder": ["fast", "balanced"],
                "profiles": [
                    "balanced": ["model": "claude-sonnet-4-6"],
                    "fast": ["model": "claude-haiku-4-5"],
                ],
            ]
        ])

        let fragment = InferenceProfile(name: "custom", model: "gpt-5.5")
        let success = await store.setProfile(name: "custom", fragment: fragment)

        XCTAssertTrue(success)
        XCTAssertEqual(store.profiles.map(\.name), ["fast", "balanced", "custom"])
        XCTAssertEqual(lastProfileOrderPatch(), ["fast", "balanced", "custom"])
    }

    func testSetProfileRenameReplacesOldNameInExplicitProfileOrder() async {
        store.loadInferenceProfiles(config: [
            "llm": [
                "profileOrder": ["other", "old-name"],
                "profiles": [
                    "old-name": ["model": "claude-sonnet-4-6"],
                    "other": ["model": "claude-haiku-4-5"],
                ],
            ]
        ])

        let fragment = InferenceProfile(name: "new-name", model: "gpt-5.5")
        let success = await store.setProfile(
            name: "new-name",
            fragment: fragment,
            replacingOrderName: "old-name"
        )

        XCTAssertTrue(success)
        XCTAssertEqual(store.profiles.map(\.name), ["other", "new-name"])
        XCTAssertEqual(lastProfileOrderPatch(), ["other", "new-name"])
    }

    func testSetProfileUpdatesExistingEntry() async {
        store.loadInferenceProfiles(config: [
            "llm": [
                "profiles": [
                    "balanced": [
                        "provider": "anthropic",
                        "model": "claude-sonnet-4-6",
                        "maxTokens": 16000,
                    ]
                ]
            ]
        ])
        XCTAssertEqual(store.profiles.count, 1)

        // Partial fragment — only the model changes. The daemon deep-merges,
        // so `provider` and `maxTokens` must remain set locally as well.
        let updated = InferenceProfile(
            name: "balanced",
            model: "gpt-5"
        )
        let success = await store.setProfile(name: "balanced", fragment: updated)
        XCTAssertTrue(success)

        XCTAssertEqual(store.profiles.count, 1, "Updating an existing profile must not duplicate the entry")
        let stored = store.profiles.first(where: { $0.name == "balanced" })
        XCTAssertEqual(stored?.model, "gpt-5")
        XCTAssertEqual(stored?.provider, "anthropic", "Local cache must mirror the daemon's deep-merge — fields absent from the fragment must persist")
        XCTAssertEqual(stored?.maxTokens, 16000, "Local cache must mirror the daemon's deep-merge — fields absent from the fragment must persist")
    }

    func testReplaceProfileDropsHiddenLeavesFromPayloadAndLocalCache() async {
        store.loadInferenceProfiles(config: [
            "llm": [
                "profiles": [
                    "balanced": [
                        "provider": "anthropic",
                        "model": "claude-opus-4-7",
                        "maxTokens": 32000,
                        "effort": "max",
                        "speed": "fast",
                        "verbosity": "high",
                        "temperature": 0.7,
                        "thinking": ["enabled": true, "streamThinking": true],
                    ]
                ]
            ]
        ])

        let replacement = InferenceProfile(
            name: "balanced",
            provider: "openai",
            model: "gpt-5.5",
            maxTokens: 128000,
            effort: "high",
            verbosity: "medium"
        )
        let success = await store.replaceProfile(name: "balanced", fragment: replacement)
        XCTAssertTrue(success)

        XCTAssertEqual(mockSettingsClient.replaceInferenceProfileCalls.count, 1)
        let call = mockSettingsClient.replaceInferenceProfileCalls[0]
        XCTAssertEqual(call.name, "balanced")
        XCTAssertEqual(call.fragment["provider"] as? String, "openai")
        XCTAssertEqual(call.fragment["model"] as? String, "gpt-5.5")
        XCTAssertEqual(call.fragment["maxTokens"] as? Int, 128000)
        XCTAssertEqual(call.fragment["effort"] as? String, "high")
        XCTAssertEqual(call.fragment["verbosity"] as? String, "medium")
        XCTAssertNil(call.fragment["speed"])
        XCTAssertNil(call.fragment["temperature"])
        XCTAssertNil(call.fragment["thinking"])

        let stored = store.profiles.first(where: { $0.name == "balanced" })
        XCTAssertEqual(stored?.provider, "openai")
        XCTAssertEqual(stored?.model, "gpt-5.5")
        XCTAssertEqual(stored?.maxTokens, 128000)
        XCTAssertEqual(stored?.effort, "high")
        XCTAssertEqual(stored?.verbosity, "medium")
        XCTAssertNil(stored?.speed)
        XCTAssertEqual(stored?.temperature, .some(.unset))
        XCTAssertNil(stored?.thinkingEnabled)
        XCTAssertNil(stored?.thinkingStreamThinking)
    }

    func testReplaceProfileRoundTripsContextWindowOverride() async {
        store.loadInferenceProfiles(config: [
            "llm": [
                "profiles": [
                    "long-context": [
                        "provider": "openai",
                        "model": "gpt-5.5",
                        "contextWindow": [
                            "maxInputTokens": 150000,
                            "summaryBudgetRatio": 0.05,
                        ],
                    ]
                ]
            ]
        ])

        var replacement = store.profiles.first(where: { $0.name == "long-context" })!
        replacement.contextWindowMaxInputTokens = 175000
        let success = await store.replaceProfile(name: "long-context", fragment: replacement)
        XCTAssertTrue(success)

        let call = mockSettingsClient.replaceInferenceProfileCalls[0]
        let contextWindow = call.fragment["contextWindow"] as? [String: Any]
        XCTAssertEqual(contextWindow?["maxInputTokens"] as? Int, 175000)
        XCTAssertEqual(contextWindow?["summaryBudgetRatio"] as? Double, 0.05)

        let stored = store.profiles.first(where: { $0.name == "long-context" })
        XCTAssertEqual(stored?.contextWindowMaxInputTokens, 175000)
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
                    "trustRuleSuggestion": ["provider": "openai"],
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

    func testDeleteProfileBlockedByRawCallSitesWhenCatalogUnavailable() async {
        CallSiteCatalog.shared.clearForTesting()
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
                    "futureCallSite": ["profile": "fast"],
                ]
            ]
        ])
        XCTAssertTrue(store.callSiteOverrides.isEmpty)

        let result = await store.deleteProfile(name: "fast")
        if case .blockedByCallSites(let ids) = result {
            XCTAssertEqual(ids, ["futureCallSite"])
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

    func testDeleteProfileRemovesNameFromExplicitProfileOrder() async {
        store.loadInferenceProfiles(config: [
            "llm": [
                "activeProfile": "balanced",
                "profileOrder": ["experimental", "balanced"],
                "profiles": [
                    "balanced": ["model": "claude-sonnet-4-6"],
                    "experimental": ["model": "experimental-model"],
                ],
            ]
        ])

        let result = await store.deleteProfile(name: "experimental")

        XCTAssertEqual(result, .deleted)
        XCTAssertEqual(store.profiles.map(\.name), ["balanced"])
        XCTAssertEqual(store.profileOrder, ["balanced"])
        XCTAssertEqual(lastProfileOrderPatch(), ["balanced"])
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

    // MARK: - profileOrder reordering

    func testMoveProfilePersistsPresentationOrder() async {
        store.loadInferenceProfiles(config: [
            "llm": [
                "profiles": [
                    "balanced": ["model": "claude-sonnet-4-6"],
                    "cost-optimized": ["model": "claude-haiku-4-5"],
                    "quality-optimized": ["model": "claude-opus-4-7"],
                ],
            ]
        ])

        let success = await store.moveProfile(
            sourceName: "quality-optimized",
            targetName: "balanced",
            insertAfterTarget: false
        )

        XCTAssertTrue(success)
        XCTAssertEqual(
            store.profiles.map(\.name),
            ["quality-optimized", "balanced", "cost-optimized"]
        )
        XCTAssertEqual(
            lastProfileOrderPatch(),
            ["quality-optimized", "balanced", "cost-optimized"]
        )
    }

    func testMoveProfileFailureRevertsLocalOrder() async {
        store.loadInferenceProfiles(config: [
            "llm": [
                "profileOrder": ["balanced", "cost-optimized", "quality-optimized"],
                "profiles": [
                    "balanced": ["model": "claude-sonnet-4-6"],
                    "cost-optimized": ["model": "claude-haiku-4-5"],
                    "quality-optimized": ["model": "claude-opus-4-7"],
                ],
            ]
        ])
        mockSettingsClient.patchConfigResponse = false

        let success = await store.moveProfile(
            sourceName: "quality-optimized",
            targetName: "balanced",
            insertAfterTarget: false
        )

        XCTAssertFalse(success)
        XCTAssertEqual(
            store.profiles.map(\.name),
            ["balanced", "cost-optimized", "quality-optimized"]
        )
        XCTAssertEqual(store.profileOrder, ["balanced", "cost-optimized", "quality-optimized"])
    }

    // MARK: - replaceCallSiteOverride profile-only path

    /// When `replaceCallSiteOverride` is invoked with `profile` set and
    /// no raw `provider`/`model`, the entry-level clear PATCH (first
    /// step) already removes any stale fragment leaves, so the second
    /// PATCH writes only the `profile` field — no leaf-level NSNull
    /// blanket is needed.
    func testReplaceCallSiteOverrideWritesProfileOnlyAfterEntryClear() async {
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
        // The entry-level clear handles stale leaves; the SET payload
        // should contain only `profile` and no fragment fields.
        XCTAssertNil(setPayloadEntry?["provider"])
        XCTAssertNil(setPayloadEntry?["model"])
        XCTAssertNil(setPayloadEntry?["maxTokens"])
        XCTAssertNil(setPayloadEntry?["effort"])
        XCTAssertNil(setPayloadEntry?["speed"])
        XCTAssertNil(setPayloadEntry?["verbosity"])
        XCTAssertNil(setPayloadEntry?["temperature"])
        XCTAssertNil(setPayloadEntry?["thinking"])
        XCTAssertNil(setPayloadEntry?["contextWindow"])
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

    // MARK: - setManagedProfilePolicy (managed-profile view-mode policy edit)

    /// View-mode Save on a managed profile must (a) send only `{label,
    /// status}` over the wire — the daemon's
    /// `handleReplaceInferenceProfile` rejects any other field for managed
    /// names with a 400 — and (b) preserve every seed-owned field on the
    /// local profile copy, since the partial overlay on disk only touches
    /// the two policy keys.
    func testSetManagedProfilePolicySendsOnlyLabelAndStatusAndPreservesSeedFieldsLocally() async {
        store.loadInferenceProfiles(config: [
            "llm": [
                "profiles": [
                    "balanced": [
                        "source": "managed",
                        "label": "Balanced",
                        "provider": "anthropic",
                        "model": "claude-opus-4-7",
                        "maxTokens": 32000,
                        "effort": "max",
                        "thinking": ["enabled": true, "streamThinking": true],
                    ]
                ]
            ]
        ])

        let success = await store.setManagedProfilePolicy(
            name: "balanced",
            label: "My Default",
            status: "disabled"
        )
        XCTAssertTrue(success)

        // Wire payload: ONLY label and status. The daemon route would
        // reject any other field for a managed name.
        XCTAssertEqual(mockSettingsClient.replaceInferenceProfileCalls.count, 1)
        let call = mockSettingsClient.replaceInferenceProfileCalls[0]
        XCTAssertEqual(call.name, "balanced")
        XCTAssertEqual(call.fragment["label"] as? String, "My Default")
        XCTAssertEqual(call.fragment["status"] as? String, "disabled")
        XCTAssertNil(call.fragment["provider"])
        XCTAssertNil(call.fragment["model"])
        XCTAssertNil(call.fragment["maxTokens"])
        XCTAssertNil(call.fragment["effort"])
        XCTAssertNil(call.fragment["thinking"])
        XCTAssertEqual(call.fragment.count, 2, "Fragment should contain only label and status keys")

        // Local cache: label/status updated, seed-owned fields preserved
        // (the daemon does a partial overlay so the local copy must
        // mirror that — if we replaced the full record, the cached
        // provider/model would vanish until the next config push).
        let stored = store.profiles.first(where: { $0.name == "balanced" })
        XCTAssertEqual(stored?.label, "My Default")
        XCTAssertEqual(stored?.status, "disabled")
        XCTAssertEqual(stored?.provider, "anthropic")
        XCTAssertEqual(stored?.model, "claude-opus-4-7")
        XCTAssertEqual(stored?.maxTokens, 32000)
        XCTAssertEqual(stored?.effort, "max")
        XCTAssertEqual(stored?.thinkingEnabled, true)
        XCTAssertEqual(stored?.source, "managed")
    }

    /// `nil` / whitespace-only `label` → the key is OMITTED from the wire
    /// payload. The daemon `ProfileEntry` schema declares
    /// `label: z.string().min(1).optional()` (NOT `.nullable()`), so a
    /// `null` value would fail `safeParse` and 400 the whole request
    /// (Codex P1). Omitting is the only safe encoding; the daemon's
    /// partial overlay leaves the existing on-disk label untouched.
    ///
    /// `nil` `status` → the wire sends the literal `"active"` enum value.
    /// The schema's `ProfileStatusSchema = z.enum(["active", "disabled"])`
    /// also rejects null, and omitting would let a "disabled" status on
    /// disk linger when the user is trying to flip it back to active.
    func testSetManagedProfilePolicyOmitsLabelAndNormalizesStatusToActiveForNilInputs() async {
        store.loadInferenceProfiles(config: [
            "llm": [
                "profiles": [
                    "balanced": [
                        "source": "managed",
                        "label": "Balanced",
                        "status": "disabled",
                        "provider": "anthropic",
                        "model": "claude-opus-4-7",
                    ]
                ]
            ]
        ])

        let success = await store.setManagedProfilePolicy(
            name: "balanced",
            label: nil,
            status: nil
        )
        XCTAssertTrue(success)

        let call = mockSettingsClient.replaceInferenceProfileCalls[0]
        // Invariant: never send null for either field. Zod would reject it.
        XCTAssertFalse(
            call.fragment["label"] is NSNull,
            "label must never serialize as NSNull (Zod schema is .optional() not .nullable())"
        )
        XCTAssertFalse(
            call.fragment["status"] is NSNull,
            "status must never serialize as NSNull (Zod schema is .optional() not .nullable())"
        )
        // label omitted entirely (nil input), status normalized to "active".
        XCTAssertNil(call.fragment["label"], "label key must be absent when input is nil")
        XCTAssertEqual(call.fragment["status"] as? String, "active")
        XCTAssertEqual(call.fragment.count, 1, "Fragment should contain only the status key when label is nil")

        // Local cache: label NOT touched (still "Balanced" because we
        // didn't send a label update). Status flips to nil locally to
        // mirror the codebase's nil-as-active convention; functionally
        // equivalent to the "active" the daemon now has on disk.
        let stored = store.profiles.first(where: { $0.name == "balanced" })
        XCTAssertEqual(stored?.label, "Balanced", "Label must NOT be cleared locally when omitted on the wire")
        XCTAssertNil(stored?.status, "Status normalized to nil (== active) locally")
        // Seed fields preserved.
        XCTAssertEqual(stored?.provider, "anthropic")
        XCTAssertEqual(stored?.model, "claude-opus-4-7")
    }

    /// `status: "active"` and `status: nil` both produce the same wire
    /// payload (`"active"`). Anything other than the literal `"disabled"`
    /// is normalized to `"active"` so the daemon's `ProfileStatusSchema`
    /// enum is satisfied for every input shape the editor can produce.
    func testSetManagedProfilePolicyAlwaysSendsValidEnumStatusForActiveBucket() async {
        store.loadInferenceProfiles(config: [
            "llm": ["profiles": ["balanced": ["source": "managed"]]]
        ])

        // Explicit "active"
        _ = await store.setManagedProfilePolicy(name: "balanced", label: "L", status: "active")
        // Nil
        _ = await store.setManagedProfilePolicy(name: "balanced", label: "L", status: nil)
        // Empty string (defensive)
        _ = await store.setManagedProfilePolicy(name: "balanced", label: "L", status: "")

        XCTAssertEqual(
            mockSettingsClient.replaceInferenceProfileCalls.map { $0.fragment["status"] as? String },
            ["active", "active", "active"],
            "Every non-disabled status input must normalize to the literal \"active\" enum value"
        )
    }

    /// Codex P1 invariant test: the wire payload must never contain
    /// `NSNull()` for either policy field. Tested across the cartesian
    /// product of (nil, "", whitespace, real value) for both inputs.
    func testSetManagedProfilePolicyNeverSendsNullForLabelOrStatus() async {
        store.loadInferenceProfiles(config: [
            "llm": ["profiles": ["balanced": ["source": "managed"]]]
        ])

        let labelInputs: [String?] = [nil, "", "   ", "Quality"]
        let statusInputs: [String?] = [nil, "", "active", "disabled"]
        for label in labelInputs {
            for status in statusInputs {
                _ = await store.setManagedProfilePolicy(
                    name: "balanced",
                    label: label,
                    status: status
                )
            }
        }

        for (idx, call) in mockSettingsClient.replaceInferenceProfileCalls.enumerated() {
            XCTAssertFalse(
                call.fragment["label"] is NSNull,
                "Call #\(idx): label is NSNull — daemon Zod schema rejects null"
            )
            XCTAssertFalse(
                call.fragment["status"] is NSNull,
                "Call #\(idx): status is NSNull — daemon Zod schema rejects null"
            )
            // status is ALWAYS present (always normalized to a valid enum)
            XCTAssertTrue(
                call.fragment["status"] is String,
                "Call #\(idx): status key must always be present as a String"
            )
        }
    }

    /// Label whitespace is trimmed before comparison and storage. A
    /// whitespace-only input is treated as "no label change" — the key
    /// is OMITTED rather than serialized as `NSNull` (Codex P1).
    func testSetManagedProfilePolicyTrimsLabelWhitespaceAndOmitsWhitespaceOnly() async {
        store.loadInferenceProfiles(config: [
            "llm": [
                "profiles": [
                    "balanced": ["source": "managed", "label": "Balanced"]
                ]
            ]
        ])

        _ = await store.setManagedProfilePolicy(
            name: "balanced",
            label: "  Quality  ",
            status: nil
        )
        XCTAssertEqual(
            mockSettingsClient.replaceInferenceProfileCalls[0].fragment["label"] as? String,
            "Quality"
        )
        XCTAssertEqual(
            store.profiles.first(where: { $0.name == "balanced" })?.label,
            "Quality"
        )

        _ = await store.setManagedProfilePolicy(
            name: "balanced",
            label: "   ",
            status: nil
        )
        XCTAssertNil(
            mockSettingsClient.replaceInferenceProfileCalls[1].fragment["label"],
            "Whitespace-only label should be omitted from the wire payload (not NSNull)"
        )
        XCTAssertFalse(
            mockSettingsClient.replaceInferenceProfileCalls[1].fragment["label"] is NSNull,
            "Whitespace-only label must NOT serialize as NSNull"
        )
        // Local cache: label NOT cleared, since we don't have a daemon-side
        // null-clear path. The previous "Quality" override persists.
        XCTAssertEqual(
            store.profiles.first(where: { $0.name == "balanced" })?.label,
            "Quality",
            "Whitespace-only label input must leave the local label untouched (matches daemon partial-overlay)"
        )
    }

    /// Daemon-side failure must NOT mutate the local cache — the user
    /// retries from a consistent state and the surfaced `actionError`
    /// (from `commitEditor`) is the recovery affordance.
    func testSetManagedProfilePolicyFailureLeavesLocalStateUntouched() async {
        store.loadInferenceProfiles(config: [
            "llm": [
                "profiles": [
                    "balanced": [
                        "source": "managed",
                        "label": "Balanced",
                        "provider": "anthropic",
                        "model": "claude-opus-4-7",
                    ]
                ]
            ]
        ])

        mockSettingsClient.replaceInferenceProfileResponse = false

        let success = await store.setManagedProfilePolicy(
            name: "balanced",
            label: "My Default",
            status: "disabled"
        )
        XCTAssertFalse(success)

        let stored = store.profiles.first(where: { $0.name == "balanced" })
        XCTAssertEqual(stored?.label, "Balanced", "Label should be unchanged on failure")
        XCTAssertNil(stored?.status, "Status should be unchanged on failure")
        XCTAssertEqual(stored?.provider, "anthropic")
        XCTAssertEqual(stored?.model, "claude-opus-4-7")
    }

    /// `setManagedProfilePolicy` is technically callable on any name —
    /// the daemon route does the managed-vs-user dispatch. When the local
    /// profile cache has no matching entry (e.g. concurrent removal), the
    /// method still completes successfully but skips the local update;
    /// the next daemon config push reconciles state.
    func testSetManagedProfilePolicySkipsLocalUpdateWhenProfileNotCached() async {
        // No profile loaded; cache is empty.
        let success = await store.setManagedProfilePolicy(
            name: "balanced",
            label: "Quality",
            status: "disabled"
        )
        XCTAssertTrue(success)
        XCTAssertEqual(mockSettingsClient.replaceInferenceProfileCalls.count, 1)
        XCTAssertTrue(
            store.profiles.first(where: { $0.name == "balanced" }) == nil,
            "Method should not synthesize a new profile entry when none exists locally"
        )
    }
}
