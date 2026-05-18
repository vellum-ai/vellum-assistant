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

    /// When two `setActiveProfile` calls are in flight and responses resolve
    /// out of order, the late-arriving success must not overwrite the newer
    /// in-flight pick. The user picks A then B; B's PATCH succeeds first
    /// (UI and daemon become B); A's delayed success then arrives. The
    /// current-value guard must prevent the success branch from resetting
    /// `activeProfile` back to A.
    func testSetActiveProfileIgnoresStaleSuccessFromOlderInflightCall() async {
        var continuationA: CheckedContinuation<Bool, Never>?
        var continuationB: CheckedContinuation<Bool, Never>?
        let bothSuspended = expectation(description: "both PATCH calls suspended")
        bothSuspended.expectedFulfillmentCount = 2
        mockSettingsClient.patchConfigHandler = { partial in
            let name = (partial["llm"] as? [String: Any])?["activeProfile"] as? String
            return await withCheckedContinuation { cont in
                if name == "A" {
                    continuationA = cont
                } else {
                    continuationB = cont
                }
                bothSuspended.fulfill()
            }
        }

        async let resultA: Bool = store.setActiveProfile("A")
        async let resultB: Bool = store.setActiveProfile("B")

        await fulfillment(of: [bothSuspended], timeout: 1.0)

        // Optimistic writes ran synchronously; the later pick (B) is current.
        XCTAssertEqual(store.activeProfile, "B")

        // Resolve B first — daemon-confirmed value becomes B.
        continuationB?.resume(returning: true)
        let bSucceeded = await resultB
        XCTAssertTrue(bSucceeded)
        XCTAssertEqual(store.activeProfile, "B")

        // Resolve A's late success. The guard must drop the stale write.
        continuationA?.resume(returning: true)
        let aSucceeded = await resultA
        XCTAssertTrue(aSucceeded)
        XCTAssertEqual(
            store.activeProfile,
            "B",
            "Late success of an older pick must not overwrite a newer confirmed pick"
        )
    }

    /// When the newer in-flight pick fails and reverts before the older
    /// pick's success arrives, the older success must still apply — the
    /// daemon has it and no live newer intent remains. The user picks A
    /// then B; B's PATCH fails first (UI reverts to "balanced"); A's
    /// delayed success then arrives. Because B is no longer in flight and
    /// never confirmed, A is the only "live" intent and must drive both
    /// `activeProfile` and `lastConfirmedActiveProfile` back to "A".
    ///
    /// Regression test for the previous guard (`self.activeProfile ==
    /// name` only) which would early-return here and leave the UI stuck
    /// on "balanced" while the daemon held "A".
    func testSetActiveProfileAppliesLateSuccessWhenNewerPickFailed() async {
        var continuationA: CheckedContinuation<Bool, Never>?
        var continuationB: CheckedContinuation<Bool, Never>?
        let bothSuspended = expectation(description: "both PATCH calls suspended")
        bothSuspended.expectedFulfillmentCount = 2
        mockSettingsClient.patchConfigHandler = { partial in
            let name = (partial["llm"] as? [String: Any])?["activeProfile"] as? String
            return await withCheckedContinuation { cont in
                if name == "A" {
                    continuationA = cont
                } else {
                    continuationB = cont
                }
                bothSuspended.fulfill()
            }
        }

        async let resultA: Bool = store.setActiveProfile("A")
        async let resultB: Bool = store.setActiveProfile("B")

        await fulfillment(of: [bothSuspended], timeout: 1.0)

        // Optimistic writes ran synchronously; the later pick (B) is current.
        XCTAssertEqual(store.activeProfile, "B")

        // Resolve B first as a failure — UI must revert to the last
        // daemon-confirmed value ("balanced") since A's PATCH has not
        // returned yet and B was the only newer-than-A in flight.
        continuationB?.resume(returning: false)
        let bSucceeded = await resultB
        XCTAssertFalse(bSucceeded)
        XCTAssertEqual(store.activeProfile, "balanced")

        // Resolve A's late success. No newer pick is live (B failed and
        // reverted; nothing newer in flight). Both `activeProfile` and
        // `lastConfirmedActiveProfile` must advance to "A" so the UI
        // matches the daemon-persisted value.
        continuationA?.resume(returning: true)
        let aSucceeded = await resultA
        XCTAssertTrue(aSucceeded)
        XCTAssertEqual(
            store.activeProfile,
            "A",
            "Late success must apply when the newer pick failed and reverted"
        )

        // A subsequent failed pick must revert to "A", not "balanced",
        // confirming `lastConfirmedActiveProfile` was also updated.
        mockSettingsClient.patchConfigHandler = nil
        mockSettingsClient.patchConfigResponse = false
        let cSucceeded = await store.setActiveProfile("C")
        XCTAssertFalse(cSucceeded)
        XCTAssertEqual(store.activeProfile, "A")
    }

    /// When `loadInferenceProfiles` pushes a remote-confirmed value (e.g.
    /// from another client/session) while a `setActiveProfile` PATCH is in
    /// flight, the older local PATCH must not stomp the newer daemon-pushed
    /// value once it finally succeeds. The user picks "A"; while the PATCH
    /// is suspended, a config push updates the authoritative value to "C";
    /// "A"'s late success must observe the external-confirmation generation
    /// bump and leave both `activeProfile` and `lastConfirmedActiveProfile`
    /// set to "C".
    func testSetActiveProfileDoesNotStompExternalConfirmedUpdate() async {
        var continuationA: CheckedContinuation<Bool, Never>?
        let aSuspended = expectation(description: "A PATCH suspended")
        mockSettingsClient.patchConfigHandler = { _ in
            return await withCheckedContinuation { cont in
                continuationA = cont
                aSuspended.fulfill()
            }
        }

        async let resultA: Bool = store.setActiveProfile("A")

        await fulfillment(of: [aSuspended], timeout: 1.0)
        XCTAssertEqual(store.activeProfile, "A")

        // External config push (another client/session) advances the
        // daemon-authoritative value to "C" while A is still in flight.
        store.loadInferenceProfiles(config: [
            "llm": [
                "activeProfile": "C",
                "profiles": ["C": ["model": "claude-sonnet-4-6"]],
            ]
        ])
        XCTAssertEqual(store.activeProfile, "C")

        // A's late success arrives. Even though no newer local pick is
        // live, the external-confirmation generation captured at entry no
        // longer matches — so the success branch must skip its writes and
        // leave the daemon-pushed value intact.
        continuationA?.resume(returning: true)
        let aSucceeded = await resultA
        XCTAssertTrue(aSucceeded)
        XCTAssertEqual(
            store.activeProfile,
            "C",
            "Late local success must not stomp a newer remote-confirmed value"
        )

        // A subsequent failed pick must revert to "C", not "A",
        // confirming `lastConfirmedActiveProfile` was preserved.
        mockSettingsClient.patchConfigHandler = nil
        mockSettingsClient.patchConfigResponse = false
        let dSucceeded = await store.setActiveProfile("D")
        XCTAssertFalse(dSucceeded)
        XCTAssertEqual(store.activeProfile, "C")
    }

    /// Generation-counter drift detection must trigger even when the
    /// external push lands the same string twice during the await — a
    /// value-equality check (the predecessor of this guard) would miss
    /// the drift entirely because `lastConfirmedActiveProfile` ends up
    /// matching the snapshot taken at entry. The user picks "A"; while
    /// suspended, the daemon pushes "C" then "A"; A's late success must
    /// still defer to the external confirmations rather than re-asserting
    /// its own write.
    func testSetActiveProfileDefersToExternalConfirmationsEvenWhenValueRoundtrips() async {
        var continuationA: CheckedContinuation<Bool, Never>?
        let aSuspended = expectation(description: "A PATCH suspended")
        mockSettingsClient.patchConfigHandler = { _ in
            return await withCheckedContinuation { cont in
                continuationA = cont
                aSuspended.fulfill()
            }
        }

        async let resultA: Bool = store.setActiveProfile("A")
        await fulfillment(of: [aSuspended], timeout: 1.0)

        // Two external confirmations land while A is in flight; the
        // second restores the same string A was originally writing.
        store.loadInferenceProfiles(config: [
            "llm": [
                "activeProfile": "C",
                "profiles": ["C": ["model": "claude-sonnet-4-6"]],
            ]
        ])
        store.loadInferenceProfiles(config: [
            "llm": [
                "activeProfile": "A",
                "profiles": ["A": ["model": "claude-haiku-4-5"]],
            ]
        ])

        continuationA?.resume(returning: true)
        let aSucceeded = await resultA
        XCTAssertTrue(aSucceeded)
        XCTAssertEqual(store.activeProfile, "A")

        // A failed pick must revert to the externally-confirmed "A"
        // (preserved by the daemon's push), not to a stale value the
        // success branch might have re-confirmed had drift detection
        // relied on string equality.
        mockSettingsClient.patchConfigHandler = nil
        mockSettingsClient.patchConfigResponse = false
        let bSucceeded = await store.setActiveProfile("B")
        XCTAssertFalse(bSucceeded)
        XCTAssertEqual(store.activeProfile, "A")
    }

    /// A slow `refreshDaemonConfig()` GET that was already in flight when
    /// the user picks "A" can return *during* A's PATCH, carrying the
    /// pre-A active profile. That stale push must not look like a true
    /// external write — counting it would force A's success branch into
    /// the defer path and leave `lastConfirmedActiveProfile` stuck at the
    /// pre-A value, so a subsequent failed pick would roll back to a
    /// profile the assistant had already moved off of.
    func testSetActiveProfileIgnoresStaleRefreshReassertingPreviousValue() async {
        // Seed the store with a confirmed value so the "stale refresh"
        // mid-flight can replay that same value.
        store.loadInferenceProfiles(config: [
            "llm": [
                "activeProfile": "balanced",
                "profiles": ["balanced": ["model": "claude-sonnet-4-6"]],
            ]
        ])

        var continuationA: CheckedContinuation<Bool, Never>?
        let aSuspended = expectation(description: "A PATCH suspended")
        mockSettingsClient.patchConfigHandler = { _ in
            return await withCheckedContinuation { cont in
                continuationA = cont
                aSuspended.fulfill()
            }
        }

        async let resultA: Bool = store.setActiveProfile("A")
        await fulfillment(of: [aSuspended], timeout: 1.0)

        // A slow GET started before the pick lands during the PATCH and
        // re-asserts the pre-A value. Because the value matches what was
        // already confirmed, it must not bump the external-confirmation
        // counter.
        store.loadInferenceProfiles(config: [
            "llm": [
                "activeProfile": "balanced",
                "profiles": ["balanced": ["model": "claude-sonnet-4-6"]],
            ]
        ])

        continuationA?.resume(returning: true)
        let aSucceeded = await resultA
        XCTAssertTrue(aSucceeded)
        XCTAssertEqual(
            store.activeProfile,
            "A",
            "A's success must apply when the only external push re-asserts the prior value"
        )

        // A subsequent failed pick must revert to "A", proving
        // `lastConfirmedActiveProfile` advanced — not to "balanced",
        // which would indicate the success branch wrongly deferred.
        mockSettingsClient.patchConfigHandler = nil
        mockSettingsClient.patchConfigResponse = false
        let bSucceeded = await store.setActiveProfile("B")
        XCTAssertFalse(bSucceeded)
        XCTAssertEqual(store.activeProfile, "A")
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

    /// Regression: when `replaceInferenceProfile` succeeds but the
    /// follow-up `profileOrder` PATCH fails, the local cache must not be
    /// left in a state where `profiles` contains a new entry that is
    /// missing from `profileOrder`. Otherwise a caller retry sees the
    /// "already exists" collision in `profiles` and
    /// `reorderPublishedProfiles` silently drops the unlisted entry on the
    /// next reorder pass.
    func testReplaceProfileFailedOrderPatchRebuildsLocalOrder() async {
        store.loadInferenceProfiles(config: [
            "llm": [
                "profileOrder": ["balanced"],
                "profiles": [
                    "balanced": ["model": "claude-sonnet-4-6"],
                ],
            ]
        ])
        // The first PATCH after `replaceInferenceProfile` is the
        // `profileOrder` patch — fail it to exercise the recovery path.
        mockSettingsClient.patchConfigResponse = false

        let newProfile = InferenceProfile(
            name: "experimental",
            provider: "anthropic",
            model: "claude-opus-4-7"
        )
        let success = await store.replaceProfile(name: "experimental", fragment: newProfile)
        XCTAssertFalse(success)

        // The server-side replace already succeeded, so the new profile
        // must be present in the local cache to mirror persisted state.
        XCTAssertTrue(store.profiles.contains(where: { $0.name == "experimental" }))
        // profileOrder must be rebuilt as a stable sort over `profiles`
        // so it includes the new name. A retry must not see a stuck
        // "already exists" collision against an out-of-order cache.
        XCTAssertEqual(store.profileOrder, ["balanced", "experimental"])
        XCTAssertEqual(Set(store.profileOrder), Set(store.profiles.map(\.name)))
        // `reorderPublishedProfiles` must not silently drop the new
        // profile — published `profiles` and `profileOrder` must agree.
        XCTAssertEqual(store.profiles.map(\.name).sorted(), store.profileOrder)
    }

    /// Regression: when the follow-up `profileOrder` PATCH fails, the
    /// rebuilt local order must preserve any user-defined ordering of
    /// existing profiles instead of collapsing to alphabetical. A retry
    /// of `replaceProfile` computes `nextProfileOrderAfterSaving` from
    /// local state and would otherwise persist the alphabetic order back
    /// to the daemon, silently overwriting the user's prior ordering.
    func testReplaceProfileFailedOrderPatchPreservesCustomOrder() async {
        store.loadInferenceProfiles(config: [
            "llm": [
                "profileOrder": ["zeta", "alpha", "mike"],
                "profiles": [
                    "alpha": ["model": "claude-sonnet-4-6"],
                    "mike": ["model": "claude-sonnet-4-6"],
                    "zeta": ["model": "claude-sonnet-4-6"],
                ],
            ]
        ])
        mockSettingsClient.patchConfigResponse = false

        let newProfile = InferenceProfile(
            name: "bravo",
            provider: "anthropic",
            model: "claude-opus-4-7"
        )
        let success = await store.replaceProfile(name: "bravo", fragment: newProfile)
        XCTAssertFalse(success)

        // Custom order of existing profiles must survive; only the new
        // name is appended (alphabetically after preserved entries).
        XCTAssertEqual(store.profileOrder, ["zeta", "alpha", "mike", "bravo"])
        XCTAssertEqual(Set(store.profileOrder), Set(store.profiles.map(\.name)))
        XCTAssertEqual(store.profiles.map(\.name), store.profileOrder)
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

    /// `nil` / whitespace-only `label` and `status` → wire serializes as
    /// `NSNull` (= JSON null) so the daemon's `patchManagedProfileFields`
    /// route applies the null-clear sentinel from #30362, deleting the
    /// `label` / `status` key on disk. The daemon schema change in #30387
    /// (`.nullable()` on both fields) is what makes this reachable
    /// end-to-end.
    func testSetManagedProfilePolicySendsNullForClearedLabelAndStatus() async {
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
        XCTAssertTrue(
            call.fragment["label"] is NSNull,
            "nil label must serialize as NSNull so the daemon clears it"
        )
        XCTAssertTrue(
            call.fragment["status"] is NSNull,
            "nil status must serialize as NSNull so the daemon clears it (active-by-absence)"
        )
        XCTAssertEqual(call.fragment.count, 2, "Fragment should contain both label and status keys (both NSNull)")

        let stored = store.profiles.first(where: { $0.name == "balanced" })
        XCTAssertNil(stored?.label, "Label must be cleared locally when NSNull sent on the wire")
        XCTAssertNil(stored?.status, "Status must be cleared locally when NSNull sent on the wire")
        // Seed fields preserved.
        XCTAssertEqual(stored?.provider, "anthropic")
        XCTAssertEqual(stored?.model, "claude-opus-4-7")
    }

    /// Status passes through verbatim for the two valid enum values.
    /// `nil` / `""` both serialize as `NSNull` (clear sentinel) — same
    /// shape as a never-set status, which renders active-by-absence.
    func testSetManagedProfilePolicyStatusPassThroughAndClearShapes() async {
        store.loadInferenceProfiles(config: [
            "llm": ["profiles": ["balanced": ["source": "managed"]]]
        ])

        _ = await store.setManagedProfilePolicy(name: "balanced", label: "L", status: "active")
        _ = await store.setManagedProfilePolicy(name: "balanced", label: "L", status: "disabled")
        _ = await store.setManagedProfilePolicy(name: "balanced", label: "L", status: nil)
        _ = await store.setManagedProfilePolicy(name: "balanced", label: "L", status: "")

        let calls = mockSettingsClient.replaceInferenceProfileCalls
        XCTAssertEqual(calls[0].fragment["status"] as? String, "active",
                       "Explicit \"active\" must pass through verbatim")
        XCTAssertEqual(calls[1].fragment["status"] as? String, "disabled",
                       "Explicit \"disabled\" must pass through verbatim")
        XCTAssertTrue(calls[2].fragment["status"] is NSNull,
                      "nil status must serialize as NSNull (clear sentinel)")
        XCTAssertTrue(calls[3].fragment["status"] is NSNull,
                      "Empty-string status must serialize as NSNull (clear sentinel)")
    }

    /// Wire-format invariants across (nil, "", whitespace, real value)
    /// for both inputs: label and status are NSNull when empty/nil,
    /// String when non-empty. Symmetric clear semantics — no field-specific
    /// normalization on either side.
    func testSetManagedProfilePolicyWireFormatInvariants() async {
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
            let labelIsEmpty = idx / statusInputs.count < 3 // nil, "", "   "
            // Status input cycles within each label row. Indices 0/1 in
            // a row are nil / "" (clear); 2/3 are "active" / "disabled".
            let statusIsCleared = idx % statusInputs.count < 2

            if labelIsEmpty {
                XCTAssertTrue(
                    call.fragment["label"] is NSNull,
                    "Call #\(idx): empty/nil label must be NSNull"
                )
            } else {
                XCTAssertTrue(
                    call.fragment["label"] is String,
                    "Call #\(idx): non-empty label must be a String"
                )
            }

            if statusIsCleared {
                XCTAssertTrue(
                    call.fragment["status"] is NSNull,
                    "Call #\(idx): empty/nil status must be NSNull (clear sentinel)"
                )
            } else {
                XCTAssertTrue(
                    call.fragment["status"] is String,
                    "Call #\(idx): non-empty status must be a String"
                )
            }
        }
    }

    /// Label whitespace is trimmed before comparison and storage. A
    /// whitespace-only input sends `NSNull()` to clear the label on the
    /// daemon and locally.
    func testSetManagedProfilePolicyTrimsLabelWhitespaceAndClearsWhitespaceOnly() async {
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
        XCTAssertTrue(
            mockSettingsClient.replaceInferenceProfileCalls[1].fragment["label"] is NSNull,
            "Whitespace-only label must serialize as NSNull to clear on the daemon"
        )
        XCTAssertNil(
            store.profiles.first(where: { $0.name == "balanced" })?.label,
            "Whitespace-only label input must clear the local label"
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
