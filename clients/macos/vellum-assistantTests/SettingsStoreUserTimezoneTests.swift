import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class SettingsStoreUserTimezoneTests: XCTestCase {

    private var tempDir: URL!
    private var configPath: String!

    override func setUp() {
        super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        configPath = tempDir.appendingPathComponent("config.json").path
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        super.tearDown()
    }

    private func seed(_ json: String) {
        try! json.write(toFile: configPath, atomically: true, encoding: .utf8)
    }

    private func readConfig() -> [String: Any] {
        let url = URL(fileURLWithPath: configPath)
        guard let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return json
    }

    func testLoadsValidConfiguredTimezone() {
        seed(#"{"ui":{"userTimezone":"America/New_York"}}"#)
        let store = SettingsStore(configPath: configPath)

        XCTAssertEqual(store.userTimezone, "America/New_York")
    }

    func testIgnoresInvalidConfiguredTimezone() {
        seed(#"{"ui":{"userTimezone":"Not/ARealZone"}}"#)
        let store = SettingsStore(configPath: configPath)

        XCTAssertNil(store.userTimezone)
    }

    func testSaveUserTimezonePersistsCanonicalIdentifier() {
        seed("{}")
        let store = SettingsStore(configPath: configPath)

        let error = store.saveUserTimezone("america/new_york")
        XCTAssertNil(error)
        XCTAssertEqual(store.userTimezone, "America/New_York")

        let persisted = readConfig()
        let ui = persisted["ui"] as? [String: Any]
        XCTAssertEqual(ui?["userTimezone"] as? String, "America/New_York")
    }

    func testSaveUserTimezoneRejectsInvalidValueWithoutOverwritingExisting() {
        seed(#"{"ui":{"userTimezone":"America/Los_Angeles"}}"#)
        let store = SettingsStore(configPath: configPath)

        let error = store.saveUserTimezone("not/a-timezone")
        XCTAssertNotNil(error)
        XCTAssertEqual(store.userTimezone, "America/Los_Angeles")

        let persisted = readConfig()
        let ui = persisted["ui"] as? [String: Any]
        XCTAssertEqual(ui?["userTimezone"] as? String, "America/Los_Angeles")
    }

    func testClearUserTimezoneRemovesOnlyTimezoneKey() {
        seed(#"{"ui":{"userTimezone":"America/New_York","mediaEmbeds":{"enabled":true}},"other":"value"}"#)
        let store = SettingsStore(configPath: configPath)

        store.clearUserTimezone()

        let persisted = readConfig()
        XCTAssertEqual(persisted["other"] as? String, "value")
        let ui = persisted["ui"] as? [String: Any]
        XCTAssertNil(ui?["userTimezone"])
        XCTAssertNotNil(ui?["mediaEmbeds"])
    }

    // MARK: - Startup/reconnect rehydration

    /// Regression: `userTimezone` must be hydrated from the daemon on
    /// app startup. Previously `loadConfigFromDaemon()` only ran when
    /// the daemon broadcast `config_changed` (a file-mutation signal
    /// that never fires on startup), so the timezone stayed "Not Set"
    /// across every restart even when `ui.userTimezone` was persisted.
    func testUserTimezoneHydratesFromDaemonOnInit() {
        let mock = MockSettingsClient()
        mock.fetchConfigResponse = [
            "ui": ["userTimezone": "America/New_York"]
        ]

        let store = SettingsStore(settingsClient: mock)

        let predicate = NSPredicate { _, _ in
            store.userTimezone == "America/New_York"
        }
        wait(
            for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)],
            timeout: 2.0
        )
        XCTAssertGreaterThanOrEqual(mock.fetchConfigCallCount, 1)
    }

    /// Regression: `.daemonDidReconnect` must trigger a config reload
    /// so the timezone (and other daemon-config-dependent state) is
    /// restored after the daemon restarts or after a network blip.
    func testUserTimezoneRehydratesOnDaemonReconnect() {
        let mock = MockSettingsClient()
        mock.fetchConfigResponse = [:]

        let store = SettingsStore(settingsClient: mock)

        // Wait for the eager init-time fetch to land.
        let initFetched = NSPredicate { _, _ in
            mock.fetchConfigCallCount >= 1
        }
        wait(
            for: [XCTNSPredicateExpectation(predicate: initFetched, object: nil)],
            timeout: 2.0
        )
        XCTAssertNil(store.userTimezone)

        // Daemon comes online with a persisted timezone.
        mock.fetchConfigResponse = [
            "ui": ["userTimezone": "Europe/Berlin"]
        ]
        NotificationCenter.default.post(name: .daemonDidReconnect, object: nil)

        let rehydrated = NSPredicate { _, _ in
            store.userTimezone == "Europe/Berlin"
        }
        wait(
            for: [XCTNSPredicateExpectation(predicate: rehydrated, object: nil)],
            timeout: 2.0
        )
    }
}
