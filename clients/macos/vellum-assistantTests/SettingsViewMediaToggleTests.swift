import XCTest
@testable import VellumAssistantLib

@MainActor
final class SettingsViewMediaToggleTests: XCTestCase {

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

    private func makeStore(enabled: Bool) -> SettingsStore {
        seed(#"{"ui":{"mediaEmbeds":{"enabled":\#(enabled)}}}"#)
        return SettingsStore(configPath: configPath)
    }

    // MARK: - Toggle reflects the store's current state

    func testToggleReflectsStoreEnabledTrue() {
        let store = makeStore(enabled: true)
        XCTAssertTrue(store.mediaEmbedsEnabled)
    }

    func testToggleReflectsStoreEnabledFalse() {
        let store = makeStore(enabled: false)
        XCTAssertFalse(store.mediaEmbedsEnabled)
    }

    // MARK: - Toggling updates the store

    func testTogglingOnUpdatesStore() {
        let store = makeStore(enabled: false)
        XCTAssertFalse(store.mediaEmbedsEnabled)

        store.setMediaEmbedsEnabled(true)
        XCTAssertTrue(store.mediaEmbedsEnabled)
    }

    func testTogglingOffUpdatesStore() {
        let store = makeStore(enabled: true)
        XCTAssertTrue(store.mediaEmbedsEnabled)

        store.setMediaEmbedsEnabled(false)
        XCTAssertFalse(store.mediaEmbedsEnabled)
    }

    // MARK: - Store reflects media embeds state

    func testStoreReflectsMediaEmbedsEnabled() {
        let store = makeStore(enabled: true)
        XCTAssertTrue(store.mediaEmbedsEnabled)
    }

    func testStoreReflectsMediaEmbedsDisabled() {
        let store = makeStore(enabled: false)
        XCTAssertFalse(store.mediaEmbedsEnabled)
    }
}
