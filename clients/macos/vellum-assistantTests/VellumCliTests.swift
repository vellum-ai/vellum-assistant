import XCTest
@testable import VellumAssistantLib

final class VellumCliTests: XCTestCase {
    func testRetireArgumentsBypassCliConfirmationForDesktopControlledFlows() {
        XCTAssertEqual(
            VellumCli.retireArguments(name: "assistant-1"),
            ["retire", "assistant-1", "--yes"]
        )
    }
}
