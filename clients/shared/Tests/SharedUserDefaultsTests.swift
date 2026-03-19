import XCTest

@testable import VellumAssistantShared

final class SharedUserDefaultsTests: XCTestCase {
    private let key = "shared-defaults-regression-test"

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: key)
        SharedUserDefaults.standard.removeObject(forKey: key)
        super.tearDown()
    }

    func testSharedUserDefaultsSeesValuesWrittenThroughStandardDefaults() {
        let expectedValue = "visible-through-shared-defaults"

        UserDefaults.standard.set(expectedValue, forKey: key)

        XCTAssertEqual(SharedUserDefaults.standard.string(forKey: key), expectedValue)
    }
}
