import XCTest
@testable import VellumAssistantLib

@MainActor
final class SettingsStoreMediaToggleTests: XCTestCase {

    private var tempDir: URL!

    override func setUp() {
        super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        super.tearDown()
    }

    // MARK: - Helpers

    private var configPath: String {
        tempDir.appendingPathComponent("config.json").path
    }

    /// Write JSON to the config file for pre-population.
    private func seed(_ json: String) {
        let url = URL(fileURLWithPath: configPath)
        try! json.write(to: url, atomically: true, encoding: .utf8)
    }

    /// Read the persisted config back as a dictionary.
    private func readPersistedConfig() -> [String: Any] {
        let url = URL(fileURLWithPath: configPath)
        guard let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return json
    }

    /// Extract the `ui.mediaEmbeds` sub-dictionary from the persisted config.
    private func readPersistedMediaEmbeds() -> [String: Any]? {
        let config = readPersistedConfig()
        guard let ui = config["ui"] as? [String: Any] else { return nil }
        return ui["mediaEmbeds"] as? [String: Any]
    }

    // MARK: - OFF -> ON sets enabled=true and enabledSince to ~now

    func testToggleOffToOnSetsEnabledAndTimestamp() {
        seed(#"{"ui":{"mediaEmbeds":{"enabled":false}}}"#)
        let store = SettingsStore(configPath: configPath)

        XCTAssertFalse(store.mediaEmbedsEnabled)
        // enabledSince is defaulted to now when the key is missing from config
        XCTAssertNotNil(store.mediaEmbedsEnabledSince)

        let before = Date()
        store.setMediaEmbedsEnabled(true)
        let after = Date()

        XCTAssertTrue(store.mediaEmbedsEnabled)
        XCTAssertNotNil(store.mediaEmbedsEnabledSince)

        // Timestamp should be approximately now
        let since = store.mediaEmbedsEnabledSince!
        XCTAssertGreaterThanOrEqual(since, before)
        XCTAssertLessThanOrEqual(since, after)
    }

    // MARK: - ON -> OFF sets enabled=false, preserves enabledSince

    func testToggleOnToOffPreservesTimestamp() {
        let isoString = "2026-01-15T12:00:00Z"
        seed("""
        {"ui":{"mediaEmbeds":{"enabled":true,"enabledSince":"\(isoString)"}}}
        """)
        let store = SettingsStore(configPath: configPath)

        XCTAssertTrue(store.mediaEmbedsEnabled)
        let originalSince = store.mediaEmbedsEnabledSince

        store.setMediaEmbedsEnabled(false)

        XCTAssertFalse(store.mediaEmbedsEnabled)
        // enabledSince should be unchanged in memory
        XCTAssertEqual(store.mediaEmbedsEnabledSince, originalSince)
    }

    // MARK: - OFF -> ON -> OFF -> ON resets enabledSince each time

    func testToggleCycleResetsTimestampEachEnable() {
        seed(#"{"ui":{"mediaEmbeds":{"enabled":false}}}"#)
        let store = SettingsStore(configPath: configPath)

        // First toggle ON
        store.setMediaEmbedsEnabled(true)
        let firstSince = store.mediaEmbedsEnabledSince
        XCTAssertNotNil(firstSince)

        // Toggle OFF
        store.setMediaEmbedsEnabled(false)
        XCTAssertFalse(store.mediaEmbedsEnabled)

        // Small delay to ensure timestamps differ
        Thread.sleep(forTimeInterval: 0.01)

        // Second toggle ON — timestamp should be newer
        store.setMediaEmbedsEnabled(true)
        let secondSince = store.mediaEmbedsEnabledSince
        XCTAssertNotNil(secondSince)
        XCTAssertGreaterThan(secondSince!, firstSince!)
    }

    // MARK: - ON when already ON is a no-op for enabledSince

    func testToggleOnWhenAlreadyOnIsNoOp() {
        let isoString = "2026-01-15T12:00:00Z"
        seed("""
        {"ui":{"mediaEmbeds":{"enabled":true,"enabledSince":"\(isoString)"}}}
        """)
        let store = SettingsStore(configPath: configPath)

        let originalSince = store.mediaEmbedsEnabledSince

        // Calling setMediaEmbedsEnabled(true) when already on should not change timestamp
        store.setMediaEmbedsEnabled(true)

        XCTAssertTrue(store.mediaEmbedsEnabled)
        XCTAssertEqual(store.mediaEmbedsEnabledSince, originalSince)
    }

    // MARK: - OFF when already OFF is a no-op

    func testToggleOffWhenAlreadyOffIsNoOp() {
        seed(#"{"ui":{"mediaEmbeds":{"enabled":false}}}"#)
        let store = SettingsStore(configPath: configPath)

        XCTAssertFalse(store.mediaEmbedsEnabled)

        // Should not crash or change state
        store.setMediaEmbedsEnabled(false)
        XCTAssertFalse(store.mediaEmbedsEnabled)
    }

    // MARK: - Toggle persists to config file (enabled)

    func testToggleOnPersistsToConfigFile() {
        seed(#"{"ui":{"mediaEmbeds":{"enabled":false}}}"#)
        let store = SettingsStore(configPath: configPath)

        store.setMediaEmbedsEnabled(true)

        let mediaEmbeds = readPersistedMediaEmbeds()
        XCTAssertNotNil(mediaEmbeds)
        XCTAssertEqual(mediaEmbeds?["enabled"] as? Bool, true)
        XCTAssertNotNil(mediaEmbeds?["enabledSince"] as? String)

        // Verify the persisted ISO string parses to a valid date
        let isoString = mediaEmbeds!["enabledSince"] as! String
        let formatter = ISO8601DateFormatter()
        XCTAssertNotNil(formatter.date(from: isoString))
    }

    // MARK: - Toggle OFF persists enabled=false to config file

    func testToggleOffPersistsToConfigFile() {
        let isoString = "2026-01-15T12:00:00Z"
        seed("""
        {"ui":{"mediaEmbeds":{"enabled":true,"enabledSince":"\(isoString)"}}}
        """)
        let store = SettingsStore(configPath: configPath)

        store.setMediaEmbedsEnabled(false)

        let mediaEmbeds = readPersistedMediaEmbeds()
        XCTAssertNotNil(mediaEmbeds)
        XCTAssertEqual(mediaEmbeds?["enabled"] as? Bool, false)
        // enabledSince should still be in the config
        XCTAssertEqual(mediaEmbeds?["enabledSince"] as? String, isoString)
    }

    // MARK: - Toggle preserves sibling config keys

    func testTogglePreservesSiblingConfigKeys() {
        seed(#"{"ui":{"mediaEmbeds":{"enabled":false,"videoAllowlistDomains":["example.com"]}},"other":"data"}"#)
        let store = SettingsStore(configPath: configPath)

        store.setMediaEmbedsEnabled(true)

        let config = readPersistedConfig()
        // Top-level sibling key preserved
        XCTAssertEqual(config["other"] as? String, "data")

        // videoAllowlistDomains inside mediaEmbeds preserved
        let mediaEmbeds = readPersistedMediaEmbeds()
        XCTAssertNotNil(mediaEmbeds)
        let domains = mediaEmbeds?["videoAllowlistDomains"] as? [String]
        XCTAssertEqual(domains, ["example.com"])
    }

    // MARK: - Toggle persists correctly when read back by a new store

    func testPersistedStateRoundTrips() {
        seed(#"{"ui":{"mediaEmbeds":{"enabled":false}}}"#)
        let store = SettingsStore(configPath: configPath)

        store.setMediaEmbedsEnabled(true)
        let persistedSince = store.mediaEmbedsEnabledSince

        // Create a new store from the same config — it should pick up persisted values
        let reloaded = SettingsStore(configPath: configPath)
        XCTAssertTrue(reloaded.mediaEmbedsEnabled)
        XCTAssertNotNil(reloaded.mediaEmbedsEnabledSince)

        // Timestamps should match (within ISO8601 second precision)
        let diff = abs(reloaded.mediaEmbedsEnabledSince!.timeIntervalSince(persistedSince!))
        XCTAssertLessThan(diff, 1.0)
    }
}
