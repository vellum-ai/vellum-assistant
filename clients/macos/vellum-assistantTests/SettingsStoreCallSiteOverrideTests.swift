import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Verifies the per-call-site LLM override APIs on `SettingsStore`:
/// catalog seeding, config sync, single-entry write/clear, batch update,
/// and the `overridesCount` derivation that drives UI badges.
@MainActor
final class SettingsStoreCallSiteOverrideTests: XCTestCase {

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

    /// Returns the most recent `llm.callSites` patch payload captured by
    /// the mock client, or `nil` if no such patch has been emitted.
    private func lastCallSitesPatch() -> [String: Any]? {
        for payload in mockSettingsClient.patchConfigCalls.reversed() {
            if let llm = payload["llm"] as? [String: Any],
               let sites = llm["callSites"] as? [String: Any] {
                return sites
            }
        }
        return nil
    }

    private func callSitesPatch(at index: Int) -> [String: Any]? {
        guard mockSettingsClient.patchConfigCalls.indices.contains(index),
              let llm = mockSettingsClient.patchConfigCalls[index]["llm"] as? [String: Any],
              let sites = llm["callSites"] as? [String: Any] else {
            return nil
        }
        return sites
    }

    /// Waits for the background `Task` started by a store helper to flush
    /// its patch into the mock client.
    private func waitForPatchCount(_ expected: Int, timeout: TimeInterval = 2.0) {
        let predicate = NSPredicate { _, _ in
            self.mockSettingsClient.patchConfigCalls.count >= expected
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: timeout)
    }

    // MARK: - Catalog

    func testCatalogCoversEveryCallSite() {
        // The catalog enumerates every backend LLM call site grouped across 8 domains
        // (agent loop, memory, workspace, UI, notifications, voice,
        // utility, skills). If this count drifts, the catalog and the
        // backend `LLMCallSiteEnum` have diverged.
        XCTAssertEqual(CallSiteCatalog.all.count, 35)
        XCTAssertEqual(CallSiteCatalog.byId.count, 35)
        XCTAssertEqual(CallSiteCatalog.validIds.count, 35)
    }

    func testCatalogHasUniqueIdsAndNonEmptyDisplayNames() {
        let ids = CallSiteCatalog.all.map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count, "CallSiteCatalog must not contain duplicate IDs")
        for entry in CallSiteCatalog.all {
            XCTAssertFalse(entry.id.isEmpty, "Catalog entry must have non-empty ID")
            XCTAssertFalse(entry.displayName.isEmpty, "Catalog entry must have non-empty displayName")
            XCTAssertFalse(entry.hasOverride, "Catalog seed entry must start with no override")
        }
    }

    func testCatalogCoversEveryDomain() {
        let representedDomains = Set(CallSiteCatalog.all.map(\.domain))
        XCTAssertEqual(representedDomains, Set(CallSiteDomain.allCases))
    }

    func testStoreSeedsCallSiteOverridesFromCatalog() {
        XCTAssertEqual(store.callSiteOverrides.count, CallSiteCatalog.all.count)
        XCTAssertEqual(store.overridesCount, 0)
    }

    // MARK: - Sync from raw config

    func testLoadCallSiteOverridesPopulatesEntriesFromRawConfig() {
        let config: [String: Any] = [
            "llm": [
                "callSites": [
                    "memoryRetrieval": [
                        "provider": "openai",
                        "model": "gpt-4.1"
                    ],
                    "mainAgent": [
                        "profile": "fast"
                    ]
                ]
            ]
        ]

        store.loadCallSiteOverrides(config: config)

        let memory = store.callSiteOverrides.first(where: { $0.id == "memoryRetrieval" })
        XCTAssertEqual(memory?.provider, "openai")
        XCTAssertEqual(memory?.model, "gpt-4.1")
        XCTAssertNil(memory?.profile)
        XCTAssertTrue(memory?.hasOverride ?? false)

        let main = store.callSiteOverrides.first(where: { $0.id == "mainAgent" })
        XCTAssertNil(main?.provider)
        XCTAssertNil(main?.model)
        XCTAssertEqual(main?.profile, "fast")
        XCTAssertTrue(main?.hasOverride ?? false)

        // An entry that has no override in the config must surface as
        // "no override" with all fields nil.
        let untouched = store.callSiteOverrides.first(where: { $0.id == "trustRuleSuggestion" })
        XCTAssertNil(untouched?.provider)
        XCTAssertNil(untouched?.model)
        XCTAssertNil(untouched?.profile)
        XCTAssertFalse(untouched?.hasOverride ?? true)
    }

    func testLoadCallSiteOverridesIgnoresUnknownIds() {
        let config: [String: Any] = [
            "llm": [
                "callSites": [
                    "totallyMadeUpId": [
                        "provider": "anthropic"
                    ],
                    "memoryRetrieval": [
                        "provider": "openai"
                    ]
                ]
            ]
        ]

        store.loadCallSiteOverrides(config: config)

        XCTAssertEqual(store.callSiteOverrides.count, CallSiteCatalog.all.count)
        XCTAssertFalse(store.callSiteOverrides.contains(where: { $0.id == "totallyMadeUpId" }))
        let memory = store.callSiteOverrides.first(where: { $0.id == "memoryRetrieval" })
        XCTAssertEqual(memory?.provider, "openai")
    }

    func testLoadCallSiteOverridesResetsPriorOverridesWhenConfigEmpty() {
        // Seed with an override, then re-load against an empty config to
        // confirm `loadCallSiteOverrides` produces a fresh catalog snapshot
        // rather than merging on top of stale local state.
        store.loadCallSiteOverrides(config: [
            "llm": ["callSites": ["memoryRetrieval": ["provider": "openai"]]]
        ])
        XCTAssertEqual(store.overridesCount, 1)

        store.loadCallSiteOverrides(config: [:])
        XCTAssertEqual(store.overridesCount, 0)
        XCTAssertEqual(store.callSiteOverrides.count, CallSiteCatalog.all.count)
        for entry in store.callSiteOverrides {
            XCTAssertFalse(entry.hasOverride, "Expected \(entry.id) to be reset to no override")
        }
    }

    func testLoadCallSiteOverridesTreatsEmptyStringsAsNil() {
        let config: [String: Any] = [
            "llm": [
                "callSites": [
                    "memoryRetrieval": [
                        "provider": "",
                        "model": "",
                        "profile": ""
                    ]
                ]
            ]
        ]

        store.loadCallSiteOverrides(config: config)

        let memory = store.callSiteOverrides.first(where: { $0.id == "memoryRetrieval" })
        XCTAssertNil(memory?.provider)
        XCTAssertNil(memory?.model)
        XCTAssertNil(memory?.profile)
        XCTAssertFalse(memory?.hasOverride ?? true)
    }

    // MARK: - Single-entry write

    func testSetCallSiteOverrideEmitsExpectedPatch() {
        _ = store.setCallSiteOverride(
            "memoryRetrieval",
            provider: "openai",
            model: "gpt-4.1"
        )
        waitForPatchCount(1)

        let sites = lastCallSitesPatch()
        XCTAssertNotNil(sites)
        let memory = sites?["memoryRetrieval"] as? [String: Any]
        XCTAssertEqual(memory?["provider"] as? String, "openai")
        XCTAssertEqual(memory?["model"] as? String, "gpt-4.1")
        XCTAssertNil(
            memory?["profile"],
            "setCallSiteOverride must omit nil keys from the patch payload"
        )
    }

    func testSetCallSiteOverrideUpdatesLocalCacheOptimistically() {
        _ = store.setCallSiteOverride("mainAgent", profile: "fast")
        let main = store.callSiteOverrides.first(where: { $0.id == "mainAgent" })
        XCTAssertEqual(main?.profile, "fast")
        XCTAssertEqual(store.overridesCount, 1)
    }

    func testSetCallSiteOverrideRejectsUnknownId() {
        let task = store.setCallSiteOverride("notARealCallSite", provider: "openai")
        let result = waitForResult(task)
        XCTAssertFalse(result)
        XCTAssertEqual(
            mockSettingsClient.patchConfigCalls.count,
            0,
            "Unknown call-site IDs must not produce a network call"
        )
    }

    // MARK: - Single-entry clear

    func testClearCallSiteOverrideNullsEntireEntryAndClearsLocalCache() {
        _ = store.setCallSiteOverride(
            "memoryRetrieval",
            provider: "openai",
            model: "gpt-4.1"
        )
        waitForPatchCount(1)

        _ = store.clearCallSiteOverride("memoryRetrieval")
        waitForPatchCount(2)

        // The whole `callSites.<id>` entry is nulled (not just provider/
        // model/profile leaves) so any other config leaves the entry might
        // have — maxTokens, effort, speed, thinking, contextWindow — get
        // cleared too. Per Codex PR #26128 cycle 2 P2.
        let sites = lastCallSitesPatch()
        XCTAssertNotNil(sites?["memoryRetrieval"])
        XCTAssertTrue(sites?["memoryRetrieval"] is NSNull)

        let cached = store.callSiteOverrides.first(where: { $0.id == "memoryRetrieval" })
        XCTAssertNil(cached?.provider)
        XCTAssertNil(cached?.model)
        XCTAssertNil(cached?.profile)
        XCTAssertFalse(cached?.hasOverride ?? true)
        XCTAssertEqual(store.overridesCount, 0)
    }

    // MARK: - Round-trip

    /// End-to-end round trip: write three overrides, confirm
    /// `overridesCount` reflects them, then re-load from a synthetic
    /// config that mirrors what would be persisted on disk and verify
    /// the store's view matches the original write set.
    func testRoundTripWriteThenReloadFromConfig() {
        _ = store.setCallSiteOverride("memoryRetrieval", provider: "openai", model: "gpt-4.1")
        _ = store.setCallSiteOverride("mainAgent", profile: "fast")
        _ = store.setCallSiteOverride("commitMessage", provider: "anthropic")
        waitForPatchCount(3)

        XCTAssertEqual(store.overridesCount, 3)

        let synthetic: [String: Any] = [
            "llm": [
                "callSites": [
                    "memoryRetrieval": ["provider": "openai", "model": "gpt-4.1"],
                    "mainAgent": ["profile": "fast"],
                    "commitMessage": ["provider": "anthropic"],
                ]
            ]
        ]
        store.loadCallSiteOverrides(config: synthetic)

        XCTAssertEqual(store.overridesCount, 3)
        let memory = store.callSiteOverrides.first(where: { $0.id == "memoryRetrieval" })
        XCTAssertEqual(memory?.provider, "openai")
        XCTAssertEqual(memory?.model, "gpt-4.1")
        let main = store.callSiteOverrides.first(where: { $0.id == "mainAgent" })
        XCTAssertEqual(main?.profile, "fast")
        let commit = store.callSiteOverrides.first(where: { $0.id == "commitMessage" })
        XCTAssertEqual(commit?.provider, "anthropic")
    }

    // MARK: - Batch update

    func testSetCallSiteOverridesBatchClearsThenSetsProvidedEntries() {
        let updates: [CallSiteOverride] = [
            CallSiteOverride(
                id: "memoryRetrieval",
                displayName: "Memory · Retrieval",
                domain: .memory,
                provider: "openai",
                model: "gpt-4.1"
            ),
            CallSiteOverride(
                id: "mainAgent",
                displayName: "Main agent",
                domain: .agentLoop,
                profile: "fast"
            ),
            CallSiteOverride(
                id: "trustRuleSuggestion",
                displayName: "Trust rule suggestion",
                domain: .utility
            ), // no overrides — should emit explicit nulls to clear
        ]

        _ = store.setCallSiteOverrides(updates)
        waitForPatchCount(2)

        let clearSites = callSitesPatch(at: 0)
        XCTAssertEqual(clearSites?.count, CallSiteCatalog.all.count)
        XCTAssertTrue(clearSites?["memoryRetrieval"] is NSNull)
        XCTAssertTrue(clearSites?["mainAgent"] is NSNull)
        XCTAssertTrue(clearSites?["trustRuleSuggestion"] is NSNull)

        let setSites = callSitesPatch(at: 1)
        XCTAssertEqual(Set(setSites?.keys.map { String($0) } ?? []), ["memoryRetrieval", "mainAgent"])

        let memory = setSites?["memoryRetrieval"] as? [String: Any]
        XCTAssertEqual(memory?["provider"] as? String, "openai")
        XCTAssertEqual(memory?["model"] as? String, "gpt-4.1")
        XCTAssertNil(memory?["profile"])

        let main = setSites?["mainAgent"] as? [String: Any]
        XCTAssertNil(main?["provider"])
        XCTAssertNil(main?["model"])
        XCTAssertEqual(main?["profile"] as? String, "fast")

        XCTAssertNil(setSites?["trustRuleSuggestion"])
    }

    /// Regression for Devin's review on PR #26128 (`SettingsStore.swift:3174`):
    /// `Dictionary(uniqueKeysWithValues:)` traps at runtime when the input
    /// contains duplicate keys. `setCallSiteOverrides` accepts external
    /// input, so it must be tolerant of duplicates — last-write-wins is the
    /// chosen contract.
    func testSetCallSiteOverridesToleratesDuplicateIdsLastWriteWins() {
        let duplicates: [CallSiteOverride] = [
            CallSiteOverride(
                id: "memoryRetrieval",
                displayName: "Memory · Retrieval (first)",
                domain: .memory,
                provider: "openai",
                model: "gpt-4.1"
            ),
            CallSiteOverride(
                id: "memoryRetrieval",
                displayName: "Memory · Retrieval (second)",
                domain: .memory,
                provider: "anthropic",
                model: "claude-haiku-4"
            ),
        ]

        // Must not crash.
        _ = store.setCallSiteOverrides(duplicates)
        waitForPatchCount(2)

        // Last-write-wins in the local cache.
        let memory = store.callSiteOverrides.first(where: { $0.id == "memoryRetrieval" })
        XCTAssertEqual(memory?.provider, "anthropic")
        XCTAssertEqual(memory?.model, "claude-haiku-4")
        XCTAssertNil(memory?.profile)

        // And in the PATCH payload.
        let sites = lastCallSitesPatch()
        let memoryEntry = sites?["memoryRetrieval"] as? [String: Any]
        XCTAssertEqual(memoryEntry?["provider"] as? String, "anthropic")
        XCTAssertEqual(memoryEntry?["model"] as? String, "claude-haiku-4")
        XCTAssertNil(memoryEntry?["profile"])
    }

    /// Regression for Codex P1 + Devin on PR #26128: prior to the fix,
    /// `setCallSiteOverrides` cleared local cache entries omitted from the
    /// input but only PATCHed entries that were present. Result: omitted
    /// entries appeared cleared in the UI but the daemon retained their
    /// previous values, and on the next config sync the stale persisted
    /// values would "reappear." The fix aligns remote with local by
    /// emitting NSNull clears for every catalog entry not in the input
    /// batch.
    func testSetCallSiteOverridesBatchClearsOmittedCatalogEntriesOnRemote() {
        // Pre-populate two unrelated entries via single-entry writes.
        _ = store.setCallSiteOverride("memoryRetrieval", provider: "openai", model: "gpt-4.1")
        _ = store.setCallSiteOverride("commitMessage", provider: "anthropic")
        waitForPatchCount(2)

        // Now batch-update a SINGLE entry that is neither of the above.
        let updates: [CallSiteOverride] = [
            CallSiteOverride(
                id: "trustRuleSuggestion",
                displayName: "Trust rule suggestion",
                domain: .utility,
                provider: "openai"
            ),
        ]
        _ = store.setCallSiteOverrides(updates)
        waitForPatchCount(4)

        let clearSites = callSitesPatch(at: 2)
        XCTAssertNotNil(clearSites)
        XCTAssertEqual(
            Set(clearSites?.keys.map { String($0) } ?? []),
            CallSiteCatalog.validIds,
            "Batch clear PATCH must cover every catalog entry to keep remote/local aligned"
        )

        // The PATCH must include the new entry verbatim.
        let setSites = callSitesPatch(at: 3)
        let trustRule = setSites?["trustRuleSuggestion"] as? [String: Any]
        XCTAssertEqual(trustRule?["provider"] as? String, "openai")
        XCTAssertNil(trustRule?["model"])
        XCTAssertNil(trustRule?["profile"])

        // And it must include null-clears for the two pre-populated entries
        // so the daemon's view matches the (now-cleared) local cache. The
        // whole entry is nulled (not just provider/model/profile leaves) per
        // PR #26128 cycle 2 fix — clears any other leaves the entry may have.
        XCTAssertNotNil(clearSites?["memoryRetrieval"], "PATCH must include null-clear for memoryRetrieval")
        XCTAssertTrue(clearSites?["memoryRetrieval"] is NSNull)

        XCTAssertNotNil(clearSites?["commitMessage"], "PATCH must include null-clear for commitMessage")
        XCTAssertTrue(clearSites?["commitMessage"] is NSNull)

        // Local cache also reflects the cleared state for the omitted entries.
        let cachedMemory = store.callSiteOverrides.first(where: { $0.id == "memoryRetrieval" })
        XCTAssertFalse(cachedMemory?.hasOverride ?? true)
        let cachedCommit = store.callSiteOverrides.first(where: { $0.id == "commitMessage" })
        XCTAssertFalse(cachedCommit?.hasOverride ?? true)
        XCTAssertEqual(store.overridesCount, 1)
    }

    func testSetCallSiteOverridesUpdatesLocalCacheInCatalogOrder() {
        let updates: [CallSiteOverride] = [
            CallSiteOverride(
                id: "trustRuleSuggestion",
                displayName: "Trust rule suggestion",
                domain: .utility,
                provider: "openai"
            ),
            CallSiteOverride(
                id: "mainAgent",
                displayName: "Main agent",
                domain: .agentLoop,
                provider: "anthropic"
            ),
        ]

        _ = store.setCallSiteOverrides(updates)
        // Local cache must follow CallSiteCatalog.all order, regardless
        // of the order the caller passed in.
        let mainIndex = store.callSiteOverrides.firstIndex(where: { $0.id == "mainAgent" }) ?? -1
        let trustRuleIndex = store.callSiteOverrides.firstIndex(where: { $0.id == "trustRuleSuggestion" }) ?? -1
        XCTAssertLessThan(mainIndex, trustRuleIndex,
                          "callSiteOverrides must preserve CallSiteCatalog order")
        XCTAssertEqual(store.overridesCount, 2)
    }

    func testSetCallSiteOverridesIgnoresUnknownEntries() {
        let updates: [CallSiteOverride] = [
            CallSiteOverride(
                id: "totallyMadeUpId",
                displayName: "ghost",
                domain: .utility,
                provider: "openai"
            ),
            CallSiteOverride(
                id: "memoryRetrieval",
                displayName: "Memory · Retrieval",
                domain: .memory,
                provider: "anthropic"
            ),
        ]

        _ = store.setCallSiteOverrides(updates)
        waitForPatchCount(2)

        let sites = lastCallSitesPatch()
        // The set PATCH includes only valid entries with non-empty overrides.
        XCTAssertEqual(sites?.count, 1)
        XCTAssertNotNil(sites?["memoryRetrieval"])
        XCTAssertNil(sites?["totallyMadeUpId"], "Unknown call-site IDs must be filtered out of the patch")

        // The valid input is written verbatim.
        let memory = sites?["memoryRetrieval"] as? [String: Any]
        XCTAssertEqual(memory?["provider"] as? String, "anthropic")
    }

    // MARK: - overridesCount derivation

    func testOverridesCountReflectsPartialOverrides() {
        XCTAssertEqual(store.overridesCount, 0)

        store.loadCallSiteOverrides(config: [
            "llm": [
                "callSites": [
                    "memoryRetrieval": ["provider": "openai"],
                    "mainAgent": ["profile": "fast"],
                    "commitMessage": ["model": "claude-haiku-4"],
                ]
            ]
        ])
        XCTAssertEqual(store.overridesCount, 3)

        // Catalog entries present in raw config but with all fields nil
        // do not count as overrides — guards against the empty-string
        // sanitization in `loadCallSiteOverrides`.
        store.loadCallSiteOverrides(config: [
            "llm": [
                "callSites": [
                    "memoryRetrieval": ["provider": "", "model": "", "profile": ""]
                ]
            ]
        ])
        XCTAssertEqual(store.overridesCount, 0)
    }

    // MARK: - Test utilities

    private func waitForResult<T: Sendable>(
        _ task: Task<T, Never>,
        timeout: TimeInterval = 2.0
    ) -> T {
        let expectation = XCTestExpectation(description: "Task completes")
        let box = ResultBox<T>()
        Task {
            box.value = await task.value
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: timeout)
        return box.value!
    }
}

private final class ResultBox<T>: @unchecked Sendable {
    var value: T?
}
