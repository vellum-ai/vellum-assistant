import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class AssistantFeatureFlagResolverTests: XCTestCase {
    private let conversationStartersKey = "feature_flags.conversation-starters.enabled"

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

    /// Creates a temporary feature-flags.json file with the given values and
    /// returns the file path. The file is automatically cleaned up via `addTeardownBlock`.
    private func createTempFeatureFlagsFile(values: [String: Bool]) throws -> String {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)

        let filePath = tempDir.appendingPathComponent("feature-flags.json").path
        let payload: [String: Any] = ["version": 1, "values": values]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted])
        FileManager.default.createFile(atPath: filePath, contents: data)

        addTeardownBlock {
            try? FileManager.default.removeItem(at: tempDir)
        }

        return filePath
    }

    func testUsesAssistantRegistryDefaultWhenNoOverrideExists() {
        // Read from a nonexistent path so no persisted overrides are found
        let nonexistentPath = "/tmp/\(UUID().uuidString)/feature-flags.json"
        let persistedFlags = AssistantFeatureFlagResolver.readPersistedFlags(from: nonexistentPath)
        let registryDefaults = AssistantFeatureFlagResolver.registryDefaults(from: makeRegistry(defaultEnabled: false))
        let resolved = AssistantFeatureFlagResolver.resolvedFlags(
            persistedFlags: persistedFlags,
            registryDefaults: registryDefaults
        )
        let enabled = resolved[conversationStartersKey] ?? true

        XCTAssertFalse(enabled)
    }

    func testPersistedAssistantOverrideWinsOverRegistryDefault() throws {
        let filePath = try createTempFeatureFlagsFile(values: [
            conversationStartersKey: true
        ])

        let persistedFlags = AssistantFeatureFlagResolver.readPersistedFlags(from: filePath)
        let registryDefaults = AssistantFeatureFlagResolver.registryDefaults(from: makeRegistry(defaultEnabled: false))
        let resolved = AssistantFeatureFlagResolver.resolvedFlags(
            persistedFlags: persistedFlags,
            registryDefaults: registryDefaults
        )
        let enabled = resolved[conversationStartersKey] ?? true

        XCTAssertTrue(enabled)
    }

    func testUndeclaredAssistantFlagsDefaultToEnabled() {
        let nonexistentPath = "/tmp/\(UUID().uuidString)/feature-flags.json"
        let persistedFlags = AssistantFeatureFlagResolver.readPersistedFlags(from: nonexistentPath)
        let registryDefaults = AssistantFeatureFlagResolver.registryDefaults(from: makeRegistry(defaultEnabled: false))
        let resolved = AssistantFeatureFlagResolver.resolvedFlags(
            persistedFlags: persistedFlags,
            registryDefaults: registryDefaults
        )
        let enabled = resolved["feature_flags.unknown.enabled"] ?? true

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
        // Store reads from disk once during init and caches the result
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
}
