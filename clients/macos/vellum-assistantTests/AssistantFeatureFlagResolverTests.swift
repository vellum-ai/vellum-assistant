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
            persistedFlags: [:],
            registryDefaults: registryDefaults
        )
        let enabled = resolved[conversationStartersKey] ?? true

        XCTAssertFalse(enabled)
    }

    func testPersistedOverrideWinsOverRegistryDefault() {
        let registryDefaults = AssistantFeatureFlagResolver.registryDefaults(from: makeRegistry(defaultEnabled: false))
        let resolved = AssistantFeatureFlagResolver.resolvedFlags(
            persistedFlags: [conversationStartersKey: true],
            registryDefaults: registryDefaults
        )
        let enabled = resolved[conversationStartersKey] ?? true

        XCTAssertTrue(enabled)
    }

    func testUndeclaredAssistantFlagsDefaultToEnabled() {
        let registryDefaults = AssistantFeatureFlagResolver.registryDefaults(from: makeRegistry(defaultEnabled: false))
        let resolved = AssistantFeatureFlagResolver.resolvedFlags(
            persistedFlags: [:],
            registryDefaults: registryDefaults
        )
        let enabled = resolved["unknown"] ?? true

        XCTAssertTrue(enabled)
    }

    @MainActor
    func testMultiPlatformAssistantTypedAccessorReflectsRegistryDefault() {
        let multiKey = "multi-platform-assistant"
        let registryOff = FeatureFlagRegistry(
            version: 1,
            flags: [
                FeatureFlagDefinition(
                    id: multiKey,
                    scope: .assistant,
                    key: multiKey,
                    label: "Multiple Platform Assistants",
                    description: "Allow users to create and manage multiple platform-hosted assistants",
                    defaultEnabled: false
                )
            ]
        )
        let storeOff = AssistantFeatureFlagStore(
            notificationCenter: NotificationCenter(),
            registry: registryOff
        )
        XCTAssertFalse(storeOff.multiPlatformAssistantEnabled)

        let registryOn = FeatureFlagRegistry(
            version: 1,
            flags: [
                FeatureFlagDefinition(
                    id: multiKey,
                    scope: .assistant,
                    key: multiKey,
                    label: "Multiple Platform Assistants",
                    description: "Allow users to create and manage multiple platform-hosted assistants",
                    defaultEnabled: true
                )
            ]
        )
        let storeOn = AssistantFeatureFlagStore(
            notificationCenter: NotificationCenter(),
            registry: registryOn
        )
        XCTAssertTrue(storeOn.multiPlatformAssistantEnabled)
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

    // MARK: - UserDefaults cache round-trip

    func testWriteAndReadCachedFlagRoundTrip() {
        let testKey = "test-cache-\(UUID().uuidString)"

        addTeardownBlock {
            UserDefaults.standard.removeObject(forKey: "AssistantFeatureFlagCache.\(testKey)")
        }

        // Write false
        AssistantFeatureFlagResolver.mergeCachedFlag(key: testKey, enabled: false)
        var cached = AssistantFeatureFlagResolver.readCachedFlags()
        XCTAssertEqual(cached[testKey], false)

        // Overwrite with true
        AssistantFeatureFlagResolver.mergeCachedFlag(key: testKey, enabled: true)
        cached = AssistantFeatureFlagResolver.readCachedFlags()
        XCTAssertEqual(cached[testKey], true)
    }

    // MARK: - Resolution priority: cached gateway flags > defaults

    func testCachedFlagWinsOverRegistryDefault() {
        let testKey = "test-priority-\(UUID().uuidString)"

        addTeardownBlock {
            UserDefaults.standard.removeObject(forKey: "AssistantFeatureFlagCache.\(testKey)")
        }

        // Registry says false, but cache says true
        AssistantFeatureFlagResolver.mergeCachedFlag(key: testKey, enabled: true)

        let registryDefaults: [String: Bool] = [testKey: false]
        let resolved = AssistantFeatureFlagResolver.resolvedFlags(
            registryDefaults: registryDefaults
        )

        // The cached value (true) should win over the registry default (false)
        XCTAssertEqual(resolved[testKey], true)
    }

    // MARK: - writeCachedFlags replaces all cache entries

    func testWriteCachedFlagsReplacesAllEntries() {
        let keyA = "test-replace-a-\(UUID().uuidString)"
        let keyB = "test-replace-b-\(UUID().uuidString)"

        addTeardownBlock {
            UserDefaults.standard.removeObject(forKey: "AssistantFeatureFlagCache.\(keyA)")
            UserDefaults.standard.removeObject(forKey: "AssistantFeatureFlagCache.\(keyB)")
        }

        // Write keyA
        AssistantFeatureFlagResolver.mergeCachedFlag(key: keyA, enabled: true)
        XCTAssertEqual(AssistantFeatureFlagResolver.readCachedFlags()[keyA], true)

        // Replace all with only keyB
        AssistantFeatureFlagResolver.writeCachedFlags([keyB: false])

        let cached = AssistantFeatureFlagResolver.readCachedFlags()
        XCTAssertNil(cached[keyA], "keyA should have been removed by writeCachedFlags")
        XCTAssertEqual(cached[keyB], false)
    }

    // MARK: - clearCachedFlags clears cache

    func testClearCachedFlagsClearsCache() {
        let testKey = "test-clear-\(UUID().uuidString)"

        addTeardownBlock {
            UserDefaults.standard.removeObject(forKey: "AssistantFeatureFlagCache.\(testKey)")
        }

        AssistantFeatureFlagResolver.mergeCachedFlag(key: testKey, enabled: true)

        // Should exist before clearing
        XCTAssertEqual(AssistantFeatureFlagResolver.readCachedFlags()[testKey], true)

        AssistantFeatureFlagResolver.clearCachedFlags()

        // Should be gone after clearing
        XCTAssertNil(AssistantFeatureFlagResolver.readCachedFlags()[testKey])
    }
}
