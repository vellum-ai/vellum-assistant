import XCTest
@testable import VellumAssistantLib

final class AssistantDisplayNameTests: XCTestCase {

    // MARK: - firstUserFacing

    func testRealNameReturned() {
        let result = AssistantDisplayName.firstUserFacing(from: ["Luna"])
        XCTAssertEqual(result, "Luna")
    }

    func testNilSkipped() {
        let result = AssistantDisplayName.firstUserFacing(from: [nil, "Luna"])
        XCTAssertEqual(result, "Luna")
    }

    func testEmptyStringSkipped() {
        let result = AssistantDisplayName.firstUserFacing(from: ["", "Luna"])
        XCTAssertEqual(result, "Luna")
    }

    func testWhitespaceOnlySkipped() {
        let result = AssistantDisplayName.firstUserFacing(from: ["  ", "Luna"])
        XCTAssertEqual(result, "Luna")
    }

    func testBootstrapPrefixSkipped() {
        let result = AssistantDisplayName.firstUserFacing(from: ["_(not yet chosen)_"])
        XCTAssertNil(result)
    }

    func testBootstrapPrefixFallsThrough() {
        let result = AssistantDisplayName.firstUserFacing(from: ["_(not yet chosen)_", "Luna"])
        XCTAssertEqual(result, "Luna")
    }

    func testAllNilReturnsNil() {
        let result = AssistantDisplayName.firstUserFacing(from: [nil, nil])
        XCTAssertNil(result)
    }

    func testEmptyArrayReturnsNil() {
        let result = AssistantDisplayName.firstUserFacing(from: [])
        XCTAssertNil(result)
    }

    // MARK: - resolve

    func testResolveWithName() {
        let result = AssistantDisplayName.resolve("Luna")
        XCTAssertEqual(result, "Luna")
    }

    func testResolveWithBootstrapUsesDefaultFallback() {
        let result = AssistantDisplayName.resolve("_(not yet chosen)_")
        XCTAssertEqual(result, AssistantDisplayName.placeholder)
    }

    func testResolveWithBootstrapUsesCustomFallback() {
        let result = AssistantDisplayName.resolve("_(not yet chosen)_", fallback: "Your Assistant")
        XCTAssertEqual(result, "Your Assistant")
    }

    func testResolveWithNilUsesCustomFallback() {
        let name: String? = nil
        let result = AssistantDisplayName.resolve(name, fallback: "Your Assistant")
        XCTAssertEqual(result, "Your Assistant")
    }

    func testResolveFirstValidCandidate() {
        let name: String? = nil
        let result = AssistantDisplayName.resolve(name, "_(bootstrap)_", "Luna", fallback: "Fallback")
        XCTAssertEqual(result, "Luna")
    }
}
