import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class SettingsStoreMediaAllowlistTests: XCTestCase {

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

    private func seed(_ json: String) {
        let url = URL(fileURLWithPath: configPath)
        try! json.write(to: url, atomically: true, encoding: .utf8)
    }

    private func readPersistedConfig() -> [String: Any] {
        SettingsStore.readConfigFromDisk(configPath)
    }

    private func readPersistedMediaEmbeds() -> [String: Any]? {
        let config = readPersistedConfig()
        guard let ui = config["ui"] as? [String: Any] else { return nil }
        return ui["mediaEmbeds"] as? [String: Any]
    }

    // MARK: - Setting domains persists to config file

    func testSetDomainsPersistsToConfig() {
        seed(#"{}"#)
        let store = SettingsStore(configPath: configPath)

        store.setMediaEmbedVideoAllowlistDomains(["example.com", "test.org"])

        let mediaEmbeds = readPersistedMediaEmbeds()
        XCTAssertNotNil(mediaEmbeds)
        let domains = mediaEmbeds?["videoAllowlistDomains"] as? [String]
        XCTAssertEqual(domains, ["example.com", "test.org"])
    }

    // MARK: - Domains are normalized (lowercased, trimmed, deduped)

    func testDomainsAreNormalized() {
        seed(#"{}"#)
        let store = SettingsStore(configPath: configPath)

        store.setMediaEmbedVideoAllowlistDomains([
            "  YouTube.COM  ",
            "youtube.com",
            "  Vimeo.COM",
        ])

        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, ["youtube.com", "vimeo.com"])

        let mediaEmbeds = readPersistedMediaEmbeds()
        let domains = mediaEmbeds?["videoAllowlistDomains"] as? [String]
        XCTAssertEqual(domains, ["youtube.com", "vimeo.com"])
    }

    // MARK: - Empty entries are removed

    func testEmptyEntriesAreRemoved() {
        seed(#"{}"#)
        let store = SettingsStore(configPath: configPath)

        store.setMediaEmbedVideoAllowlistDomains(["youtube.com", "", "   ", "vimeo.com"])

        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, ["youtube.com", "vimeo.com"])

        let mediaEmbeds = readPersistedMediaEmbeds()
        let domains = mediaEmbeds?["videoAllowlistDomains"] as? [String]
        XCTAssertEqual(domains, ["youtube.com", "vimeo.com"])
    }

    // MARK: - Setting domains preserves other config keys (enabled, enabledSince)

    func testSetDomainsPreservesOtherMediaEmbedKeys() {
        seed(#"{"ui":{"mediaEmbeds":{"enabled":true,"enabledSince":"2026-01-15T12:00:00Z"}},"other":"data"}"#)
        let store = SettingsStore(configPath: configPath)

        store.setMediaEmbedVideoAllowlistDomains(["custom.com"])

        let config = readPersistedConfig()
        // Top-level sibling preserved
        XCTAssertEqual(config["other"] as? String, "data")

        let mediaEmbeds = readPersistedMediaEmbeds()
        XCTAssertNotNil(mediaEmbeds)
        // Sibling keys inside mediaEmbeds preserved
        XCTAssertEqual(mediaEmbeds?["enabled"] as? Bool, true)
        XCTAssertEqual(mediaEmbeds?["enabledSince"] as? String, "2026-01-15T12:00:00Z")
        // New domains written
        let domains = mediaEmbeds?["videoAllowlistDomains"] as? [String]
        XCTAssertEqual(domains, ["custom.com"])
    }

    // MARK: - Reading back persisted domains matches what was set

    func testPersistedDomainsRoundTrip() {
        seed(#"{}"#)
        let store = SettingsStore(configPath: configPath)

        let input = ["youtube.com", "vimeo.com", "loom.com"]
        store.setMediaEmbedVideoAllowlistDomains(input)

        // Create a new store from the same config file
        let reloaded = SettingsStore(configPath: configPath)
        XCTAssertEqual(reloaded.mediaEmbedVideoAllowlistDomains, input)
    }

    // MARK: - Setting empty array clears domains

    func testSetEmptyArrayClearsDomains() {
        seed(#"{"ui":{"mediaEmbeds":{"videoAllowlistDomains":["youtube.com","vimeo.com"]}}}"#)
        let store = SettingsStore(configPath: configPath)

        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, ["youtube.com", "vimeo.com"])

        store.setMediaEmbedVideoAllowlistDomains([])

        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, [])

        let mediaEmbeds = readPersistedMediaEmbeds()
        let domains = mediaEmbeds?["videoAllowlistDomains"] as? [String]
        XCTAssertEqual(domains, [])

        // A new store should also read back the empty array (not fall back to defaults)
        let reloaded = SettingsStore(configPath: configPath)
        XCTAssertEqual(reloaded.mediaEmbedVideoAllowlistDomains, [])
    }

    // MARK: - Reset to defaults

    func testResetToDefaults() {
        seed(#"{"ui":{"mediaEmbeds":{"videoAllowlistDomains":["custom.com"]}}}"#)
        let store = SettingsStore(configPath: configPath)

        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, ["custom.com"])

        store.setMediaEmbedVideoAllowlistDomains(MediaEmbedSettings.defaultDomains)

        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, MediaEmbedSettings.defaultDomains)

        let reloaded = SettingsStore(configPath: configPath)
        XCTAssertEqual(reloaded.mediaEmbedVideoAllowlistDomains, MediaEmbedSettings.defaultDomains)
    }

    // MARK: - Updates published property

    func testSetDomainsUpdatesPublishedProperty() {
        seed(#"{}"#)
        let store = SettingsStore(configPath: configPath)

        // Starts with defaults
        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, MediaEmbedSettings.defaultDomains)

        store.setMediaEmbedVideoAllowlistDomains(["newsite.com"])
        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, ["newsite.com"])

        store.setMediaEmbedVideoAllowlistDomains(["another.com", "third.io"])
        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, ["another.com", "third.io"])
    }
}
