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
        seed(#"{"ui":{"userTimezone":"America/New_York","detectedTimezone":"America/Los_Angeles"}}"#)
        let store = SettingsStore(configPath: configPath)

        XCTAssertEqual(store.userTimezone, "America/New_York")
        XCTAssertEqual(store.detectedTimezone, "America/Los_Angeles")
    }

    func testIgnoresInvalidConfiguredTimezone() {
        seed(#"{"ui":{"userTimezone":"Not/ARealZone","detectedTimezone":"Also/Invalid"}}"#)
        let store = SettingsStore(configPath: configPath)

        XCTAssertNil(store.userTimezone)
        XCTAssertNil(store.detectedTimezone)
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

    func testSaveDetectedTimezonePersistsCanonicalIdentifier() {
        seed("{}")
        let store = SettingsStore(configPath: configPath)

        let error = store.saveDetectedTimezone("america/los_angeles")
        XCTAssertNil(error)
        XCTAssertEqual(store.detectedTimezone, "America/Los_Angeles")

        let persisted = readConfig()
        let ui = persisted["ui"] as? [String: Any]
        XCTAssertEqual(ui?["detectedTimezone"] as? String, "America/Los_Angeles")
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

    func testSaveDetectedTimezoneRejectsInvalidValueWithoutOverwritingExisting() {
        seed(#"{"ui":{"detectedTimezone":"America/New_York"}}"#)
        let store = SettingsStore(configPath: configPath)

        let error = store.saveDetectedTimezone("not/a-timezone")
        XCTAssertNotNil(error)
        XCTAssertEqual(store.detectedTimezone, "America/New_York")

        let persisted = readConfig()
        let ui = persisted["ui"] as? [String: Any]
        XCTAssertEqual(ui?["detectedTimezone"] as? String, "America/New_York")
    }

    func testClearUserTimezoneRemovesOnlyTimezoneKey() {
        seed(#"{"ui":{"userTimezone":"America/New_York","detectedTimezone":"America/Los_Angeles","mediaEmbeds":{"enabled":true}},"other":"value"}"#)
        let store = SettingsStore(configPath: configPath)

        store.clearUserTimezone()

        let persisted = readConfig()
        XCTAssertEqual(persisted["other"] as? String, "value")
        let ui = persisted["ui"] as? [String: Any]
        XCTAssertNil(ui?["userTimezone"])
        XCTAssertEqual(ui?["detectedTimezone"] as? String, "America/Los_Angeles")
        XCTAssertNotNil(ui?["mediaEmbeds"])
    }

    func testAutomaticModeClearingManualOverrideKeepsDetectedTimezone() {
        seed(#"{"ui":{"userTimezone":"America/New_York","detectedTimezone":"Europe/Berlin","mediaEmbeds":{"enabled":true}}}"#)
        let store = SettingsStore(configPath: configPath)

        store.clearUserTimezone()

        XCTAssertNil(store.userTimezone)
        XCTAssertEqual(store.detectedTimezone, "Europe/Berlin")

        let persisted = readConfig()
        let ui = persisted["ui"] as? [String: Any]
        XCTAssertNil(ui?["userTimezone"])
        XCTAssertEqual(ui?["detectedTimezone"] as? String, "Europe/Berlin")
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
            "ui": ["userTimezone": "America/New_York", "detectedTimezone": "America/Los_Angeles"]
        ]

        let store = SettingsStore(
            settingsClient: mock,
            currentDeviceTimezoneIdentifier: { "America/Los_Angeles" }
        )

        let predicate = NSPredicate { _, _ in
            store.userTimezone == "America/New_York"
        }
        wait(
            for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)],
            timeout: 2.0
        )
        XCTAssertGreaterThanOrEqual(mock.fetchConfigCallCount, 1)
        XCTAssertEqual(store.detectedTimezone, "America/Los_Angeles")
    }

    /// Regression: `.daemonDidReconnect` must trigger a config reload
    /// so the timezone (and other daemon-config-dependent state) is
    /// restored after the daemon restarts or after a network blip.
    func testUserTimezoneRehydratesOnDaemonReconnect() {
        let mock = MockSettingsClient()
        mock.fetchConfigResponse = [:]

        let store = SettingsStore(
            settingsClient: mock,
            currentDeviceTimezoneIdentifier: { "Europe/Paris" }
        )

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
            "ui": ["userTimezone": "Europe/Berlin", "detectedTimezone": "Europe/Paris"]
        ]
        NotificationCenter.default.post(name: .daemonDidReconnect, object: nil)

        let rehydrated = NSPredicate { _, _ in
            store.userTimezone == "Europe/Berlin"
        }
        wait(
            for: [XCTNSPredicateExpectation(predicate: rehydrated, object: nil)],
            timeout: 2.0
        )
        XCTAssertEqual(store.detectedTimezone, "Europe/Paris")
    }

    func testDetectedTimezonePersistsFromDeviceOnDaemonConfigLoad() {
        let mock = MockSettingsClient()
        mock.fetchConfigResponse = [
            "ui": [
                "mediaEmbeds": [
                    "enabled": true,
                    "enabledSince": "2026-02-15T12:00:00Z",
                    "videoAllowlistDomains": []
                ]
            ]
        ]

        let store = SettingsStore(
            settingsClient: mock,
            currentDeviceTimezoneIdentifier: { "America/Chicago" }
        )

        let patched = NSPredicate { _, _ in
            mock.patchConfigCalls.contains { payload in
                guard let ui = payload["ui"] as? [String: Any] else { return false }
                return ui["detectedTimezone"] as? String == "America/Chicago"
            }
        }
        wait(
            for: [XCTNSPredicateExpectation(predicate: patched, object: nil)],
            timeout: 2.0
        )
        XCTAssertEqual(store.detectedTimezone, "America/Chicago")
    }

    func testDetectedTimezonePersistsWhenSystemTimezoneChanges() {
        let mock = MockSettingsClient()
        mock.fetchConfigResponse = [
            "ui": [
                "detectedTimezone": "America/Chicago",
                "mediaEmbeds": [
                    "enabled": true,
                    "enabledSince": "2026-02-15T12:00:00Z",
                    "videoAllowlistDomains": []
                ]
            ]
        ]
        var currentDeviceTimezone = "America/Chicago"

        let store = SettingsStore(
            settingsClient: mock,
            currentDeviceTimezoneIdentifier: { currentDeviceTimezone }
        )

        let loaded = NSPredicate { _, _ in
            store.detectedTimezone == "America/Chicago"
        }
        wait(
            for: [XCTNSPredicateExpectation(predicate: loaded, object: nil)],
            timeout: 2.0
        )

        currentDeviceTimezone = "Europe/London"
        NotificationCenter.default.post(
            name: NSNotification.Name.NSSystemTimeZoneDidChange,
            object: nil
        )

        let patched = NSPredicate { _, _ in
            mock.patchConfigCalls.contains { payload in
                guard let ui = payload["ui"] as? [String: Any] else { return false }
                return ui["detectedTimezone"] as? String == "Europe/London"
            }
        }
        wait(
            for: [XCTNSPredicateExpectation(predicate: patched, object: nil)],
            timeout: 2.0
        )
        XCTAssertEqual(store.detectedTimezone, "Europe/London")
    }
}
