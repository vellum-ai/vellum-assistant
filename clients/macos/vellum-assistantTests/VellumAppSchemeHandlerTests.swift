import XCTest
@testable import VellumAssistantLib

final class VellumAppSchemeHandlerTests: XCTestCase {

    func testSchemeIsVellumApp() {
        XCTAssertEqual(VellumAppSchemeHandler.scheme, "vellumapp")
    }
}
