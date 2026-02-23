import XCTest
@testable import VellumAssistantLib

@MainActor
final class SettingsPanelMediaControlsTests: XCTestCase {

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

    // MARK: - Toggle updates store

    func testToggleEnablesMediaEmbeds() {
        let store = makeStore(enabled: false)
        XCTAssertFalse(store.mediaEmbedsEnabled)

        store.setMediaEmbedsEnabled(true)
        XCTAssertTrue(store.mediaEmbedsEnabled)
    }

    func testToggleDisablesMediaEmbeds() {
        let store = makeStore(enabled: true)
        XCTAssertTrue(store.mediaEmbedsEnabled)

        store.setMediaEmbedsEnabled(false)
        XCTAssertFalse(store.mediaEmbedsEnabled)
    }

    // MARK: - Domain add/remove updates store

    func testAddDomainUpdatesStore() {
        let store = makeStore(enabled: true, domains: ["youtube.com"])

        var domains = store.mediaEmbedVideoAllowlistDomains
        domains.append("example.com")
        store.setMediaEmbedVideoAllowlistDomains(domains)

        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, ["youtube.com", "example.com"])
    }

    func testRemoveDomainUpdatesStore() {
        let store = makeStore(enabled: true, domains: ["youtube.com", "vimeo.com", "loom.com"])

        var domains = store.mediaEmbedVideoAllowlistDomains
        domains.removeAll { $0 == "vimeo.com" }
        store.setMediaEmbedVideoAllowlistDomains(domains)

        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, ["youtube.com", "loom.com"])
    }

    func testResetToDefaultsUpdatesStore() {
        let store = makeStore(enabled: true, domains: ["custom.org"])

        store.setMediaEmbedVideoAllowlistDomains(MediaEmbedSettings.defaultDomains)

        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, MediaEmbedSettings.defaultDomains)
    }

    // MARK: - Store updates reflect across observers

    func testStoreToggleReflectsAcrossSurfaces() {
        let store = makeStore(enabled: false)

        // Toggling via the store API should be visible to any observer.
        store.setMediaEmbedsEnabled(true)

        XCTAssertTrue(store.mediaEmbedsEnabled)
    }

    func testStoreDomainUpdateReflectsAcrossSurfaces() {
        let store = makeStore(enabled: true, domains: ["youtube.com"])

        var domains = store.mediaEmbedVideoAllowlistDomains
        domains.append("newsite.com")
        store.setMediaEmbedVideoAllowlistDomains(domains)

        XCTAssertEqual(store.mediaEmbedVideoAllowlistDomains, ["youtube.com", "newsite.com"])
    }

    func testToggleChangePersistedAndReloadable() {
        let store = makeStore(enabled: false)

        store.setMediaEmbedsEnabled(true)

        // Reload from the same config path to verify persistence
        let reloaded = SettingsStore(configPath: configPath)
        XCTAssertTrue(reloaded.mediaEmbedsEnabled)
    }

    func testDomainChangePersistedAndReloadable() {
        let store = makeStore(enabled: true, domains: ["youtube.com"])

        var domains = store.mediaEmbedVideoAllowlistDomains
        domains.append("newdomain.com")
        store.setMediaEmbedVideoAllowlistDomains(domains)

        let reloaded = SettingsStore(configPath: configPath)
        XCTAssertEqual(reloaded.mediaEmbedVideoAllowlistDomains, ["youtube.com", "newdomain.com"])
    }
}
