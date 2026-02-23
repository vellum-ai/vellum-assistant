import XCTest
@testable import VellumAssistantLib

@MainActor
final class SettingsViewMediaAllowlistTests: XCTestCase {

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

    private func makeStore(enabled: Bool, domains: [String]? = nil) -> SettingsStore {
        if let domains {
            let domainsJSON = domains.map { #""\#($0)""# }.joined(separator: ",")
            seed(#"{"ui":{"mediaEmbeds":{"enabled":\#(enabled),"videoAllowlistDomains":[\#(domainsJSON)]}}}"#)
        } else {
            seed(#"{"ui":{"mediaEmbeds":{"enabled":\#(enabled)}}}"#)
        }
        return SettingsStore(configPath: configPath)
    }

    // MARK: - Allowlist domains from store are accessible

    func testAllowlistDomainsAccessibleThroughStore() {
        let store = makeStore(enabled: true, domains: ["youtube.com", "vimeo.com"])
        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, ["youtube.com", "vimeo.com"])
    }

    func testDefaultDomainsLoadedWhenNoneConfigured() {
        let store = makeStore(enabled: true)
        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, MediaEmbedSettings.defaultDomains)
    }

    // MARK: - Adding a domain updates the store

    func testAddingDomainUpdatesStore() {
        let store = makeStore(enabled: true, domains: ["youtube.com"])

        var domains = store.mediaEmbedVideoAllowlistDomains
        domains.append("newsite.com")
        store.setMediaEmbedVideoAllowlistDomains(domains)

        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, ["youtube.com", "newsite.com"])
    }

    func testAddingDuplicateDomainIsDeduped() {
        let store = makeStore(enabled: true, domains: ["youtube.com"])

        var domains = store.mediaEmbedVideoAllowlistDomains
        domains.append("YouTube.COM")
        store.setMediaEmbedVideoAllowlistDomains(domains)

        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, ["youtube.com"])
    }

    // MARK: - Removing a domain updates the store

    func testRemovingDomainUpdatesStore() {
        let store = makeStore(enabled: true, domains: ["youtube.com", "vimeo.com", "loom.com"])

        var domains = store.mediaEmbedVideoAllowlistDomains
        domains.removeAll { $0 == "vimeo.com" }
        store.setMediaEmbedVideoAllowlistDomains(domains)

        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, ["youtube.com", "loom.com"])
    }

    func testRemovingAllDomainsResultsInEmptyList() {
        let store = makeStore(enabled: true, domains: ["youtube.com"])

        store.setMediaEmbedVideoAllowlistDomains([])

        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, [])
    }

    // MARK: - Resetting to defaults

    func testResetToDefaultsRestoresDefaultDomains() {
        let store = makeStore(enabled: true, domains: ["custom.com", "other.org"])

        store.setMediaEmbedVideoAllowlistDomains(MediaEmbedSettings.defaultDomains)

        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, MediaEmbedSettings.defaultDomains)
    }

    func testResetToDefaultsPersistsCorrectly() {
        let store = makeStore(enabled: true, domains: ["custom.com"])

        store.setMediaEmbedVideoAllowlistDomains(MediaEmbedSettings.defaultDomains)

        // Reload from the same config to verify persistence
        let reloaded = SettingsStore(configPath: configPath)
        XCTAssertEqual(reloaded.mediaEmbedVideoAllowlistDomains, MediaEmbedSettings.defaultDomains)
    }

    // MARK: - Allowlist section relevance when embeds are disabled

    func testAllowlistStillAccessibleWhenEmbedsDisabled() {
        // The store still holds the domains even when embeds are off;
        // the UI hides the editor, but the data remains intact.
        let store = makeStore(enabled: false, domains: ["youtube.com", "custom.com"])
        XCTAssertFalse(store.mediaEmbedsEnabled)
        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, ["youtube.com", "custom.com"])
    }

    func testDisablingEmbedsPreservesAllowlistDomains() {
        let store = makeStore(enabled: true, domains: ["youtube.com", "custom.com"])

        store.setMediaEmbedsEnabled(false)

        XCTAssertFalse(store.mediaEmbedsEnabled)
        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, ["youtube.com", "custom.com"])
    }

    func testReEnablingEmbedsPreservesAllowlistDomains() {
        let store = makeStore(enabled: true, domains: ["custom.com"])

        store.setMediaEmbedsEnabled(false)
        store.setMediaEmbedsEnabled(true)

        XCTAssertTrue(store.mediaEmbedsEnabled)
        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, ["custom.com"])
    }
}
