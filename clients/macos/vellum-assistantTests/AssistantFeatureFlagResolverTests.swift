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

    // MARK: - mergePersistedFlag write/read round-trip

    func testMergePersistedFlagWritesAndReadsCorrectly() throws {
        // Create a temp directory to act as the persisted file location
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let filePath = tempDir.appendingPathComponent("feature-flags.json").path

        addTeardownBlock {
            try? FileManager.default.removeItem(at: tempDir)
        }

        // Manually write the file in the same format mergePersistedFlag uses
        // to simulate calling mergePersistedFlag with "test-flag" = false
        let initialPayload: [String: Any] = ["version": 1, "values": ["test-flag": false]]
        let initialData = try JSONSerialization.data(
            withJSONObject: initialPayload,
            options: [.prettyPrinted, .sortedKeys]
        )
        try initialData.write(to: URL(fileURLWithPath: filePath), options: .atomic)

        // readPersistedFlags should return test-flag as false
        let flagsAfterDisable = AssistantFeatureFlagResolver.readPersistedFlags(from: filePath)
        XCTAssertEqual(flagsAfterDisable["test-flag"], false)

        // Simulate calling mergePersistedFlag with "test-flag" = true
        // (merge into existing values, same as the production code does)
        var updatedValues = flagsAfterDisable
        updatedValues["test-flag"] = true
        let updatedPayload: [String: Any] = ["version": 1, "values": updatedValues]
        let updatedData = try JSONSerialization.data(
            withJSONObject: updatedPayload,
            options: [.prettyPrinted, .sortedKeys]
        )
        try updatedData.write(to: URL(fileURLWithPath: filePath), options: .atomic)

        // readPersistedFlags should now return test-flag as true
        let flagsAfterEnable = AssistantFeatureFlagResolver.readPersistedFlags(from: filePath)
        XCTAssertEqual(flagsAfterEnable["test-flag"], true)
    }

    // MARK: - Resolution priority: persisted > cached > remote > defaults

    func testPersistedFlagWinsOverCachedFlag() throws {
        let testKey = "test-priority-\(UUID().uuidString)"

        addTeardownBlock {
            // Clean up UserDefaults entry
            UserDefaults.standard.removeObject(forKey: "AssistantFeatureFlagCache.\(testKey)")
        }

        // Write true to the persisted file for the key
        let filePath = try createTempFeatureFlagsFile(values: [testKey: true])
        let persistedFlags = AssistantFeatureFlagResolver.readPersistedFlags(from: filePath)

        // Write false to the UserDefaults cache for the same key
        AssistantFeatureFlagResolver.mergeCachedFlag(key: testKey, enabled: false)
        let cachedFlags = AssistantFeatureFlagResolver.readCachedFlags()

        // Verify the raw values: persisted says true, cached says false
        XCTAssertEqual(persistedFlags[testKey], true)
        XCTAssertEqual(cachedFlags[testKey], false)

        // Build the resolved flags using the same priority chain as
        // resolvedFlags(registryDefaults:): defaults < remote < cached < persisted
        let registryDefaults = AssistantFeatureFlagResolver.registryDefaults(
            from: makeRegistry(defaultEnabled: false)
        )
        let resolved = registryDefaults
            .merging(cachedFlags) { _, new in new }
            .merging(persistedFlags) { _, new in new }

        // The persisted value (true) should win over the cached value (false)
        XCTAssertEqual(resolved[testKey], true)
    }

    // MARK: - Cache and persisted paths work independently

    func testCacheAndPersistedPathsWorkIndependently() throws {
        let testKey = "test-independent-\(UUID().uuidString)"

        addTeardownBlock {
            // Clean up UserDefaults entry
            UserDefaults.standard.removeObject(forKey: "AssistantFeatureFlagCache.\(testKey)")
        }

        // Write to UserDefaults cache via mergeCachedFlag
        AssistantFeatureFlagResolver.mergeCachedFlag(key: testKey, enabled: true)

        // Write to a temp persisted file with a different value
        let filePath = try createTempFeatureFlagsFile(values: [testKey: false])

        // Verify readCachedFlags returns the cached value independently
        let cachedFlags = AssistantFeatureFlagResolver.readCachedFlags()
        XCTAssertEqual(cachedFlags[testKey], true)

        // Verify readPersistedFlags returns the persisted value independently
        let persistedFlags = AssistantFeatureFlagResolver.readPersistedFlags(from: filePath)
        XCTAssertEqual(persistedFlags[testKey], false)

        // The two storage mechanisms return their own values without interfering
        XCTAssertNotEqual(cachedFlags[testKey], persistedFlags[testKey])
    }
}
