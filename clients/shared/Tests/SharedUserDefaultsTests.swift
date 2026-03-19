import XCTest

@testable import VellumAssistantShared

final class SharedUserDefaultsTests: XCTestCase {
    private let key = "shared-defaults-regression-test"
    private let legacySuiteName = "com.vellum.vellum-assistant.swiftpackage"

    private var legacyDefaults: UserDefaults {
        guard let defaults = UserDefaults(suiteName: legacySuiteName) else {
            fatalError("Expected legacy suite to be available in tests")
        }
        return defaults
    }

    override func setUp() {
        super.setUp()
        SharedUserDefaults.resetLegacyMigrationStateForTests()
        UserDefaults.standard.removeObject(forKey: key)
        legacyDefaults.removeObject(forKey: key)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: key)
        legacyDefaults.removeObject(forKey: key)
        SharedUserDefaults.resetLegacyMigrationStateForTests()
        super.tearDown()
    }

    func testSharedUserDefaultsSeesValuesWrittenThroughStandardDefaults() {
        let expectedValue = "visible-through-shared-defaults"

        UserDefaults.standard.set(expectedValue, forKey: key)

        XCTAssertEqual(SharedUserDefaults.standard.string(forKey: key), expectedValue)
    }

    func testSharedUserDefaultsMigratesValuesFromLegacySwiftPackageSuite() {
        let expectedValue = "migrated-from-legacy-suite"

        legacyDefaults.set(expectedValue, forKey: key)

        XCTAssertNil(UserDefaults.standard.object(forKey: key))
        XCTAssertEqual(SharedUserDefaults.standard.string(forKey: key), expectedValue)
        XCTAssertEqual(UserDefaults.standard.string(forKey: key), expectedValue)
        XCTAssertNil(legacyDefaults.object(forKey: key))
    }

    func testSharedUserDefaultsKeepsNewerStandardValueWhenLegacySuiteHasStaleValue() {
        let expectedValue = "newer-standard-value"

        UserDefaults.standard.set(expectedValue, forKey: key)
        legacyDefaults.set("stale-legacy-value", forKey: key)

        XCTAssertEqual(SharedUserDefaults.standard.string(forKey: key), expectedValue)
        XCTAssertEqual(UserDefaults.standard.string(forKey: key), expectedValue)
        XCTAssertNil(legacyDefaults.object(forKey: key))
    }
}
