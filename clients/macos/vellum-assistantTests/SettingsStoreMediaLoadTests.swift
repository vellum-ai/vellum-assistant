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
        let store = SettingsStore(configPath: missingConfigPath)

        XCTAssertEqual(store.mediaEmbedsEnabled, MediaEmbedSettings.defaultEnabled)
        XCTAssertNil(store.mediaEmbedsEnabledSince)
        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, MediaEmbedSettings.defaultDomains)
    }

    // MARK: - Empty config file (defaults)

    func testEmptyConfigUsesDefaults() {
        let path = writeConfig("{}")
        let store = SettingsStore(configPath: path)

        XCTAssertEqual(store.mediaEmbedsEnabled, MediaEmbedSettings.defaultEnabled)
        XCTAssertNil(store.mediaEmbedsEnabledSince)
        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, MediaEmbedSettings.defaultDomains)
    }

    // MARK: - enabled = false

    func testLoadEnabledFalse() {
        let path = writeConfig("""
        {"ui":{"mediaEmbeds":{"enabled":false}}}
        """)
        let store = SettingsStore(configPath: path)

        XCTAssertFalse(store.mediaEmbedsEnabled)
        XCTAssertNil(store.mediaEmbedsEnabledSince)
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

    func testLoadInvalidEnabledSinceIsNil() {
        let path = writeConfig("""
        {"ui":{"mediaEmbeds":{"enabledSince":"not-a-date"}}}
        """)
        let store = SettingsStore(configPath: path)

        XCTAssertNil(store.mediaEmbedsEnabledSince)
    }

    // MARK: - Missing enabledSince

    func testLoadMissingEnabledSinceIsNil() {
        let path = writeConfig("""
        {"ui":{"mediaEmbeds":{"enabled":true}}}
        """)
        let store = SettingsStore(configPath: path)

        XCTAssertNil(store.mediaEmbedsEnabledSince)
    }

    // MARK: - Numeric enabledSince (wrong type)

    func testLoadNumericEnabledSinceIsNil() {
        let path = writeConfig("""
        {"ui":{"mediaEmbeds":{"enabledSince":12345}}}
        """)
        let store = SettingsStore(configPath: path)

        XCTAssertNil(store.mediaEmbedsEnabledSince)
    }

    // MARK: - Corrupt config (fallback to defaults)

    func testCorruptConfigFallsBackToDefaults() {
        let path = writeConfig("{not valid json!!!")
        let store = SettingsStore(configPath: path)

        XCTAssertEqual(store.mediaEmbedsEnabled, MediaEmbedSettings.defaultEnabled)
        XCTAssertNil(store.mediaEmbedsEnabledSince)
        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, MediaEmbedSettings.defaultDomains)
    }

    // MARK: - Config with ui key but no mediaEmbeds

    func testConfigWithUiButNoMediaEmbedsUsesDefaults() {
        let path = writeConfig("""
        {"ui":{"theme":"dark"}}
        """)
        let store = SettingsStore(configPath: path)

        XCTAssertEqual(store.mediaEmbedsEnabled, MediaEmbedSettings.defaultEnabled)
        XCTAssertNil(store.mediaEmbedsEnabledSince)
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
        let path = writeConfig("""
        {"ui":{"mediaEmbeds":"invalid"}}
        """)
        let store = SettingsStore(configPath: path)

        XCTAssertEqual(store.mediaEmbedsEnabled, MediaEmbedSettings.defaultEnabled)
        XCTAssertNil(store.mediaEmbedsEnabledSince)
        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, MediaEmbedSettings.defaultDomains)
    }
}
