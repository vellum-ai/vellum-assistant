import XCTest
@testable import VellumAssistantLib

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
}
