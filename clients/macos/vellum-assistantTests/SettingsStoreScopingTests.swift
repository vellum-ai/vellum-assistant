import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class SettingsStoreScopingTests: XCTestCase {
    private let flagKey = "multi-platform-assistant"

    // Every per-assistant key this PR scopes.
    private let perAssistantKeys: [String] = [
        "selectedImageGenModel",
        "cmdEnterToSend",
        "globalHotkeyShortcut",
        "quickInputHotkeyShortcut",
        "quickInputHotkeyKeyCode",
        "sidebarToggleShortcut",
        "newChatShortcut",
        "currentConversationShortcut",
        "popOutShortcut",
    ]

    private let assistantAId = "scoping-test-assistant-A"
    private let assistantBId = "scoping-test-assistant-B"

    override func setUp() {
        super.setUp()
        clearAll()
    }

    override func tearDown() {
        clearAll()
        super.tearDown()
    }

    private func clearAll() {
        let defaults = UserDefaults.standard
        for key in perAssistantKeys {
            defaults.removeObject(forKey: key)
            defaults.removeObject(forKey: "\(assistantAId).\(key)")
            defaults.removeObject(forKey: "\(assistantBId).\(key)")
        }
        defaults.removeObject(forKey: "\(assistantAId).__settings_migrated_v1")
        defaults.removeObject(forKey: "\(assistantBId).__settings_migrated_v1")
        defaults.removeObject(forKey: "sendDiagnostics")
        defaults.removeObject(forKey: "collectUsageData")
        AssistantFeatureFlagResolver.clearCachedFlags()
    }

    private func makeFlagStore(enabled: Bool) -> AssistantFeatureFlagStore {
        AssistantFeatureFlagResolver.mergeCachedFlag(key: flagKey, enabled: enabled)
        return AssistantFeatureFlagStore()
    }

    // MARK: - ScopedDefaults wrapper

    func testScopedDefaultsKeyPrefixing() {
        let scoped = ScopedDefaults(assistantId: assistantAId)
        scoped.set("hello", forKey: "myKey")

        XCTAssertEqual(
            UserDefaults.standard.string(forKey: "\(assistantAId).myKey"),
            "hello",
            "ScopedDefaults should write with '<assistantId>.<key>' prefix"
        )
        XCTAssertEqual(scoped.string(forKey: "myKey"), "hello")
        XCTAssertNil(
            UserDefaults.standard.object(forKey: "myKey"),
            "Legacy unscoped key must be left untouched"
        )

        // Cleanup
        UserDefaults.standard.removeObject(forKey: "\(assistantAId).myKey")
    }

    func testScopedDefaultsTwoAssistantsDoNotCollide() {
        let a = ScopedDefaults(assistantId: assistantAId)
        let b = ScopedDefaults(assistantId: assistantBId)

        a.set("alpha", forKey: "shared")
        b.set("beta", forKey: "shared")

        XCTAssertEqual(a.string(forKey: "shared"), "alpha")
        XCTAssertEqual(b.string(forKey: "shared"), "beta")

        UserDefaults.standard.removeObject(forKey: "\(assistantAId).shared")
        UserDefaults.standard.removeObject(forKey: "\(assistantBId).shared")
    }

    // MARK: - Migration helper

    func testMigrationNoOpWhenFlagOff() {
        UserDefaults.standard.set("cmd+shift+g", forKey: "globalHotkeyShortcut")
        let store = makeFlagStore(enabled: false)

        let ran = SettingsStoreScopedMigration.migratePerAssistantKeysIfNeeded(
            activeAssistantId: assistantAId,
            featureFlagStore: store
        )
        XCTAssertFalse(ran)
        XCTAssertNil(UserDefaults.standard.object(forKey: "\(assistantAId).globalHotkeyShortcut"))
        XCTAssertFalse(UserDefaults.standard.bool(forKey: "\(assistantAId).__settings_migrated_v1"))
    }

    func testMigrationCopiesLegacyKeysAndLeavesLegacyIntact() {
        UserDefaults.standard.set("cmd+shift+g", forKey: "globalHotkeyShortcut")
        UserDefaults.standard.set(true, forKey: "cmdEnterToSend")
        UserDefaults.standard.set(42, forKey: "quickInputHotkeyKeyCode")
        let store = makeFlagStore(enabled: true)

        let ran = SettingsStoreScopedMigration.migratePerAssistantKeysIfNeeded(
            activeAssistantId: assistantAId,
            featureFlagStore: store
        )
        XCTAssertTrue(ran)

        XCTAssertEqual(
            UserDefaults.standard.string(forKey: "\(assistantAId).globalHotkeyShortcut"),
            "cmd+shift+g"
        )
        XCTAssertEqual(
            UserDefaults.standard.object(forKey: "\(assistantAId).cmdEnterToSend") as? Bool,
            true
        )
        XCTAssertEqual(
            UserDefaults.standard.object(forKey: "\(assistantAId).quickInputHotkeyKeyCode") as? Int,
            42
        )

        // Legacy keys preserved.
        XCTAssertEqual(UserDefaults.standard.string(forKey: "globalHotkeyShortcut"), "cmd+shift+g")
        XCTAssertEqual(UserDefaults.standard.object(forKey: "cmdEnterToSend") as? Bool, true)
        XCTAssertEqual(UserDefaults.standard.object(forKey: "quickInputHotkeyKeyCode") as? Int, 42)

        // Sentinel set.
        XCTAssertTrue(UserDefaults.standard.bool(forKey: "\(assistantAId).__settings_migrated_v1"))
    }

    func testMigrationIsIdempotent() {
        UserDefaults.standard.set("cmd+shift+g", forKey: "globalHotkeyShortcut")
        let store = makeFlagStore(enabled: true)

        XCTAssertTrue(SettingsStoreScopedMigration.migratePerAssistantKeysIfNeeded(
            activeAssistantId: assistantAId,
            featureFlagStore: store
        ))
        // Second run: sentinel blocks re-copy.
        XCTAssertFalse(SettingsStoreScopedMigration.migratePerAssistantKeysIfNeeded(
            activeAssistantId: assistantAId,
            featureFlagStore: store
        ))

        // Mutating legacy after the fact must not leak into scope.
        UserDefaults.standard.set("cmd+shift+h", forKey: "globalHotkeyShortcut")
        XCTAssertFalse(SettingsStoreScopedMigration.migratePerAssistantKeysIfNeeded(
            activeAssistantId: assistantAId,
            featureFlagStore: store
        ))
        XCTAssertEqual(
            UserDefaults.standard.string(forKey: "\(assistantAId).globalHotkeyShortcut"),
            "cmd+shift+g",
            "Idempotent migration must not re-copy after sentinel is set"
        )
    }

    func testMigrationTwoAssistantsIndependent() {
        UserDefaults.standard.set("cmd+shift+g", forKey: "globalHotkeyShortcut")
        let store = makeFlagStore(enabled: true)

        XCTAssertTrue(SettingsStoreScopedMigration.migratePerAssistantKeysIfNeeded(
            activeAssistantId: assistantAId,
            featureFlagStore: store
        ))
        XCTAssertTrue(SettingsStoreScopedMigration.migratePerAssistantKeysIfNeeded(
            activeAssistantId: assistantBId,
            featureFlagStore: store
        ))

        XCTAssertEqual(
            UserDefaults.standard.string(forKey: "\(assistantAId).globalHotkeyShortcut"),
            "cmd+shift+g"
        )
        XCTAssertEqual(
            UserDefaults.standard.string(forKey: "\(assistantBId).globalHotkeyShortcut"),
            "cmd+shift+g"
        )
    }

    // MARK: - Install-global guard

    func testInstallGlobalKeysStayOnLegacyRegardlessOfFlag() {
        // Seed legacy values.
        UserDefaults.standard.set(false, forKey: "sendDiagnostics")
        UserDefaults.standard.set(false, forKey: "collectUsageData")

        for enabled in [false, true] {
            let store = makeFlagStore(enabled: enabled)
            _ = SettingsStoreScopedMigration.migratePerAssistantKeysIfNeeded(
                activeAssistantId: assistantAId,
                featureFlagStore: store
            )
            XCTAssertNil(
                UserDefaults.standard.object(forKey: "\(assistantAId).sendDiagnostics"),
                "sendDiagnostics must never be migrated into a scoped key"
            )
            XCTAssertNil(
                UserDefaults.standard.object(forKey: "\(assistantAId).collectUsageData"),
                "collectUsageData must never be migrated into a scoped key"
            )
            UserDefaults.standard.removeObject(forKey: "\(assistantAId).__settings_migrated_v1")
        }
    }

    // MARK: - SettingsStore property routing

    func testFlagOffRegressionWritesLegacyKey() {
        let flagStore = makeFlagStore(enabled: false)
        let store = SettingsStore(featureFlagStore: flagStore)

        store.globalHotkeyShortcut = "cmd+shift+x"
        // Sink is synchronous (no debounce) for hotkeys.
        XCTAssertEqual(
            UserDefaults.standard.string(forKey: "globalHotkeyShortcut"),
            "cmd+shift+x",
            "Flag off must write to the legacy unscoped key — byte-for-byte today's behavior"
        )
        XCTAssertNil(
            UserDefaults.standard.object(forKey: "\(assistantAId).globalHotkeyShortcut")
        )
    }

    func testFlagOnNilAssistantIdFallsBackToLegacy() {
        // Ensure no active assistant id is cached — the lockfile helper
        // returns nil when no lockfile is present in the test environment
        // for this random assistant id.
        let flagStore = makeFlagStore(enabled: true)
        let store = SettingsStore(featureFlagStore: flagStore)

        // If there is no cached assistant id, writes fall back to legacy.
        if LockfileAssistant.loadActiveAssistantId() == nil {
            store.globalHotkeyShortcut = "cmd+shift+y"
            XCTAssertEqual(
                UserDefaults.standard.string(forKey: "globalHotkeyShortcut"),
                "cmd+shift+y"
            )
        }
    }
}
