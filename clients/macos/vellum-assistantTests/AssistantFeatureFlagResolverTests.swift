import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class AssistantFeatureFlagResolverTests: XCTestCase {
    private let conversationStartersKey = "conversation-starters"

    private func makeRegistry(defaultEnabled: Bool) -> FeatureFlagRegistry {
        FeatureFlagRegistry(
            version: 1,
            flags: [
                FeatureFlagDefinition(
                    id: "conversation-starters",
                    scope: .assistant,
                    key: conversationStartersKey,
                    label: "Recommended Starts",
                    description: "Show conversation starter chips",
                    defaultEnabled: defaultEnabled
                )
            ]
        )
    }

    func testUsesAssistantRegistryDefaultWhenNoOverrideExists() {
        let registryDefaults = AssistantFeatureFlagResolver.registryDefaults(from: makeRegistry(defaultEnabled: false))
        let resolved = AssistantFeatureFlagResolver.resolvedFlags(
            persistedOverrides: [:],
            registryDefaults: registryDefaults
        )
        let enabled = resolved[conversationStartersKey] ?? true

        XCTAssertFalse(enabled)
    }

    func testPersistedOverrideWinsOverRegistryDefault() {
        let registryDefaults = AssistantFeatureFlagResolver.registryDefaults(from: makeRegistry(defaultEnabled: false))
        let resolved = AssistantFeatureFlagResolver.resolvedFlags(
            persistedOverrides: [conversationStartersKey: true],
            registryDefaults: registryDefaults
        )
        let enabled = resolved[conversationStartersKey] ?? true

        XCTAssertTrue(enabled)
    }

    func testUndeclaredAssistantFlagsDefaultToEnabled() {
        let registryDefaults = AssistantFeatureFlagResolver.registryDefaults(from: makeRegistry(defaultEnabled: false))
        let resolved = AssistantFeatureFlagResolver.resolvedFlags(
            persistedOverrides: [:],
            registryDefaults: registryDefaults
        )
        let enabled = resolved["unknown"] ?? true

        XCTAssertTrue(enabled)
    }

    @MainActor
    func testStoreCachesResolvedFlagsAfterInitialLoad() {
        let store = AssistantFeatureFlagStore(
            notificationCenter: NotificationCenter(),
            registry: makeRegistry(defaultEnabled: false)
        )

        XCTAssertFalse(store.isEnabled(conversationStartersKey))
        XCTAssertFalse(store.isEnabled(conversationStartersKey))
    }

    @MainActor
    func testStoreAppliesFlagChangeNotificationsWithoutReloadingConfig() {
        let notificationCenter = NotificationCenter()
        let store = AssistantFeatureFlagStore(
            notificationCenter: notificationCenter,
            registry: makeRegistry(defaultEnabled: false)
        )

        notificationCenter.post(
            name: .assistantFeatureFlagDidChange,
            object: nil,
            userInfo: ["key": conversationStartersKey, "enabled": true]
        )
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))

        XCTAssertTrue(store.isEnabled(conversationStartersKey))
    }

    // MARK: - writePersistedOverride / readPersistedOverrides round-trip

    func testWriteAndReadPersistedOverrideRoundTrip() {
        let testKey = "test-override-\(UUID().uuidString)"

        addTeardownBlock {
            UserDefaults.standard.removeObject(forKey: "AssistantFeatureFlagOverride.\(testKey)")
        }

        // Write false
        AssistantFeatureFlagResolver.writePersistedOverride(key: testKey, enabled: false)
        var overrides = AssistantFeatureFlagResolver.readPersistedOverrides()
        XCTAssertEqual(overrides[testKey], false)

        // Overwrite with true
        AssistantFeatureFlagResolver.writePersistedOverride(key: testKey, enabled: true)
        overrides = AssistantFeatureFlagResolver.readPersistedOverrides()
        XCTAssertEqual(overrides[testKey], true)
    }

    // MARK: - Resolution priority: persisted override > cached > defaults

    func testPersistedOverrideWinsOverCachedFlag() {
        let testKey = "test-priority-\(UUID().uuidString)"

        addTeardownBlock {
            UserDefaults.standard.removeObject(forKey: "AssistantFeatureFlagCache.\(testKey)")
            UserDefaults.standard.removeObject(forKey: "AssistantFeatureFlagOverride.\(testKey)")
        }

        // Write true as a persisted override
        AssistantFeatureFlagResolver.writePersistedOverride(key: testKey, enabled: true)

        // Write false to the UserDefaults cache for the same key
        AssistantFeatureFlagResolver.mergeCachedFlag(key: testKey, enabled: false)

        // Verify the raw values: override says true, cached says false
        let overrides = AssistantFeatureFlagResolver.readPersistedOverrides()
        let cachedFlags = AssistantFeatureFlagResolver.readCachedFlags()
        XCTAssertEqual(overrides[testKey], true)
        XCTAssertEqual(cachedFlags[testKey], false)

        // Build the resolved flags using the same priority chain:
        // defaults < cached < persisted overrides
        let registryDefaults = AssistantFeatureFlagResolver.registryDefaults(
            from: makeRegistry(defaultEnabled: false)
        )
        let resolved = registryDefaults
            .merging(cachedFlags) { _, new in new }
            .merging(overrides) { _, new in new }

        // The persisted override (true) should win over the cached value (false)
        XCTAssertEqual(resolved[testKey], true)
    }

    // MARK: - Cache and persisted overrides work independently

    func testCacheAndPersistedOverridesWorkIndependently() {
        let testKey = "test-independent-\(UUID().uuidString)"

        addTeardownBlock {
            UserDefaults.standard.removeObject(forKey: "AssistantFeatureFlagCache.\(testKey)")
            UserDefaults.standard.removeObject(forKey: "AssistantFeatureFlagOverride.\(testKey)")
        }

        // Write true to UserDefaults cache
        AssistantFeatureFlagResolver.mergeCachedFlag(key: testKey, enabled: true)

        // Write false as a persisted override
        AssistantFeatureFlagResolver.writePersistedOverride(key: testKey, enabled: false)

        // Verify they return their own values without interfering
        let cachedFlags = AssistantFeatureFlagResolver.readCachedFlags()
        XCTAssertEqual(cachedFlags[testKey], true)

        let overrides = AssistantFeatureFlagResolver.readPersistedOverrides()
        XCTAssertEqual(overrides[testKey], false)

        XCTAssertNotEqual(cachedFlags[testKey], overrides[testKey])
    }

    // MARK: - clearCachedFlags clears both caches and overrides

    func testClearCachedFlagsClearsBothCachesAndOverrides() {
        let testKey = "test-clear-\(UUID().uuidString)"

        addTeardownBlock {
            UserDefaults.standard.removeObject(forKey: "AssistantFeatureFlagCache.\(testKey)")
            UserDefaults.standard.removeObject(forKey: "AssistantFeatureFlagOverride.\(testKey)")
        }

        AssistantFeatureFlagResolver.mergeCachedFlag(key: testKey, enabled: true)
        AssistantFeatureFlagResolver.writePersistedOverride(key: testKey, enabled: false)

        // Both should exist before clearing
        XCTAssertEqual(AssistantFeatureFlagResolver.readCachedFlags()[testKey], true)
        XCTAssertEqual(AssistantFeatureFlagResolver.readPersistedOverrides()[testKey], false)

        AssistantFeatureFlagResolver.clearCachedFlags()

        // Both should be gone after clearing
        XCTAssertNil(AssistantFeatureFlagResolver.readCachedFlags()[testKey])
        XCTAssertNil(AssistantFeatureFlagResolver.readPersistedOverrides()[testKey])
    }
}
