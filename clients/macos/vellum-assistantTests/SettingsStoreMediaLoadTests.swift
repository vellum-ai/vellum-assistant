import XCTest
@testable import VellumAssistantLib

@MainActor
final class SettingsStoreMediaLoadTests: XCTestCase {

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

    /// Write JSON to a temp file and return its path.
    private func writeConfig(_ json: String) -> String {
        let fileURL = tempDir.appendingPathComponent("config.json")
        try! json.write(to: fileURL, atomically: true, encoding: .utf8)
        return fileURL.path
    }

    /// Path to a file that does not exist.
    private var missingConfigPath: String {
        tempDir.appendingPathComponent("nonexistent.json").path
    }

    // MARK: - No config file (defaults)

    func testNoConfigFileUsesDefaults() {
        let before = Date()
        let store = SettingsStore(configPath: missingConfigPath)
        let after = Date()

        XCTAssertEqual(store.mediaEmbedsEnabled, MediaEmbedSettings.defaultEnabled)
        XCTAssertNotNil(store.mediaEmbedsEnabledSince, "enabledSince should default to now when no config exists")
        let since = store.mediaEmbedsEnabledSince!
        XCTAssertGreaterThanOrEqual(since, before)
        XCTAssertLessThanOrEqual(since, after)
        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, MediaEmbedSettings.defaultDomains)
    }

    // MARK: - Fresh install produces enabledSince ≈ now

    func testFreshInstallEnabledSinceIsApproximatelyNow() {
        let before = Date()
        let store = SettingsStore(configPath: missingConfigPath)
        let after = Date()

        let since = store.mediaEmbedsEnabledSince
        XCTAssertNotNil(since, "Fresh install must produce a non-nil enabledSince")
        let interval = since!.timeIntervalSince(before)
        XCTAssertLessThanOrEqual(interval, 2.0, "enabledSince should be within 2 seconds of now")
        XCTAssertGreaterThanOrEqual(since!, before)
        XCTAssertLessThanOrEqual(since!, after)
    }

    // MARK: - Defaulted enabledSince is persisted to disk

    func testDefaultedEnabledSinceIsPersistedToDisk() {
        let configPath = tempDir.appendingPathComponent("persist-test.json").path
        let store = SettingsStore(configPath: configPath)
        let firstSince = store.mediaEmbedsEnabledSince
        XCTAssertNotNil(firstSince, "enabledSince should be defaulted on first load")

        // Create a second store from the same path — it should read the
        // persisted value instead of generating a new "now".
        let store2 = SettingsStore(configPath: configPath)
        XCTAssertNotNil(store2.mediaEmbedsEnabledSince)
        // Compare within 1-second tolerance because ISO8601 persistence
        // truncates sub-second precision.
        let diff = abs(store2.mediaEmbedsEnabledSince!.timeIntervalSince(firstSince!))
        XCTAssertLessThan(diff, 1.0,
                          "Second load should use the persisted enabledSince, not generate a new one")
    }

    // MARK: - Empty config file (defaults)

    func testEmptyConfigUsesDefaults() {
        let before = Date()
        let path = writeConfig("{}")
        let store = SettingsStore(configPath: path)
        let after = Date()

        XCTAssertEqual(store.mediaEmbedsEnabled, MediaEmbedSettings.defaultEnabled)
        XCTAssertNotNil(store.mediaEmbedsEnabledSince, "enabledSince should default to now for empty config")
        let since = store.mediaEmbedsEnabledSince!
        XCTAssertGreaterThanOrEqual(since, before)
        XCTAssertLessThanOrEqual(since, after)
        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, MediaEmbedSettings.defaultDomains)
    }

    // MARK: - enabled = false

    func testLoadEnabledFalse() {
        let before = Date()
        let path = writeConfig("""
        {"ui":{"mediaEmbeds":{"enabled":false}}}
        """)
        let store = SettingsStore(configPath: path)
        let after = Date()

        XCTAssertFalse(store.mediaEmbedsEnabled)
        XCTAssertNotNil(store.mediaEmbedsEnabledSince, "enabledSince should default to now when key is missing")
        let since = store.mediaEmbedsEnabledSince!
        XCTAssertGreaterThanOrEqual(since, before)
        XCTAssertLessThanOrEqual(since, after)
        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, MediaEmbedSettings.defaultDomains)
    }

    // MARK: - enabled = true (explicit)

    func testLoadEnabledTrue() {
        let path = writeConfig("""
        {"ui":{"mediaEmbeds":{"enabled":true}}}
        """)
        let store = SettingsStore(configPath: path)

        XCTAssertTrue(store.mediaEmbedsEnabled)
    }

    // MARK: - Custom domains

    func testLoadCustomDomains() {
        let path = writeConfig("""
        {"ui":{"mediaEmbeds":{"videoAllowlistDomains":["dailymotion.com","twitch.tv"]}}}
        """)
        let store = SettingsStore(configPath: path)

        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, ["dailymotion.com", "twitch.tv"])
    }

    func testLoadCustomDomainsAreNormalized() {
        let path = writeConfig("""
        {"ui":{"mediaEmbeds":{"videoAllowlistDomains":["  YouTube.COM  ","youtube.com","Vimeo.com"]}}}
        """)
        let store = SettingsStore(configPath: path)

        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, ["youtube.com", "vimeo.com"])
    }

    // MARK: - Valid enabledSince timestamp

    func testLoadValidEnabledSince() {
        let path = writeConfig("""
        {"ui":{"mediaEmbeds":{"enabledSince":"2025-06-15T12:00:00Z"}}}
        """)
        let store = SettingsStore(configPath: path)

        XCTAssertNotNil(store.mediaEmbedsEnabledSince)
        let formatter = ISO8601DateFormatter()
        let expected = formatter.date(from: "2025-06-15T12:00:00Z")
        XCTAssertEqual(store.mediaEmbedsEnabledSince, expected)
    }

    // MARK: - Invalid enabledSince

    func testLoadInvalidEnabledSinceDefaultsToNow() {
        let before = Date()
        let path = writeConfig("""
        {"ui":{"mediaEmbeds":{"enabledSince":"not-a-date"}}}
        """)
        let store = SettingsStore(configPath: path)
        let after = Date()

        XCTAssertNotNil(store.mediaEmbedsEnabledSince, "Unparseable enabledSince should default to now")
        let since = store.mediaEmbedsEnabledSince!
        XCTAssertGreaterThanOrEqual(since, before)
        XCTAssertLessThanOrEqual(since, after)
    }

    // MARK: - Missing enabledSince

    func testLoadMissingEnabledSinceDefaultsToNow() {
        let before = Date()
        let path = writeConfig("""
        {"ui":{"mediaEmbeds":{"enabled":true}}}
        """)
        let store = SettingsStore(configPath: path)
        let after = Date()

        XCTAssertNotNil(store.mediaEmbedsEnabledSince, "Missing enabledSince key should default to now")
        let since = store.mediaEmbedsEnabledSince!
        XCTAssertGreaterThanOrEqual(since, before)
        XCTAssertLessThanOrEqual(since, after)
    }

    // MARK: - Numeric enabledSince (wrong type)

    func testLoadNumericEnabledSinceDefaultsToNow() {
        let before = Date()
        let path = writeConfig("""
        {"ui":{"mediaEmbeds":{"enabledSince":12345}}}
        """)
        let store = SettingsStore(configPath: path)
        let after = Date()

        XCTAssertNotNil(store.mediaEmbedsEnabledSince, "Numeric enabledSince (wrong type) should default to now")
        let since = store.mediaEmbedsEnabledSince!
        XCTAssertGreaterThanOrEqual(since, before)
        XCTAssertLessThanOrEqual(since, after)
    }

    // MARK: - Corrupt config (fallback to defaults)

    func testCorruptConfigFallsBackToDefaults() {
        let before = Date()
        let path = writeConfig("{not valid json!!!")
        let store = SettingsStore(configPath: path)
        let after = Date()

        XCTAssertEqual(store.mediaEmbedsEnabled, MediaEmbedSettings.defaultEnabled)
        XCTAssertNotNil(store.mediaEmbedsEnabledSince, "Corrupt config should default enabledSince to now")
        let since = store.mediaEmbedsEnabledSince!
        XCTAssertGreaterThanOrEqual(since, before)
        XCTAssertLessThanOrEqual(since, after)
        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, MediaEmbedSettings.defaultDomains)
    }

    // MARK: - Config with ui key but no mediaEmbeds

    func testConfigWithUiButNoMediaEmbedsUsesDefaults() {
        let before = Date()
        let path = writeConfig("""
        {"ui":{"theme":"dark"}}
        """)
        let store = SettingsStore(configPath: path)
        let after = Date()

        XCTAssertEqual(store.mediaEmbedsEnabled, MediaEmbedSettings.defaultEnabled)
        XCTAssertNotNil(store.mediaEmbedsEnabledSince, "Missing mediaEmbeds section should default enabledSince to now")
        let since = store.mediaEmbedsEnabledSince!
        XCTAssertGreaterThanOrEqual(since, before)
        XCTAssertLessThanOrEqual(since, after)
        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, MediaEmbedSettings.defaultDomains)
    }

    // MARK: - All fields populated

    func testLoadAllFieldsPopulated() {
        let path = writeConfig("""
        {"ui":{"mediaEmbeds":{"enabled":false,"enabledSince":"2025-01-01T00:00:00Z","videoAllowlistDomains":["example.com"]}}}
        """)
        let store = SettingsStore(configPath: path)

        XCTAssertFalse(store.mediaEmbedsEnabled)
        let formatter = ISO8601DateFormatter()
        let expected = formatter.date(from: "2025-01-01T00:00:00Z")
        XCTAssertEqual(store.mediaEmbedsEnabledSince, expected)
        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, ["example.com"])
    }

    // MARK: - mediaEmbeds is wrong type (non-dict)

    func testMediaEmbedsAsStringFallsBackToDefaults() {
        let before = Date()
        let path = writeConfig("""
        {"ui":{"mediaEmbeds":"invalid"}}
        """)
        let store = SettingsStore(configPath: path)
        let after = Date()

        XCTAssertEqual(store.mediaEmbedsEnabled, MediaEmbedSettings.defaultEnabled)
        XCTAssertNotNil(store.mediaEmbedsEnabledSince, "Non-dict mediaEmbeds should default enabledSince to now")
        let since = store.mediaEmbedsEnabledSince!
        XCTAssertGreaterThanOrEqual(since, before)
        XCTAssertLessThanOrEqual(since, after)
        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, MediaEmbedSettings.defaultDomains)
    }
}
