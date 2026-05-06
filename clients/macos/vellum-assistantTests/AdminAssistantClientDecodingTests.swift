import XCTest
@testable import VellumAssistantShared

final class AdminAssistantClientDecodingTests: XCTestCase {
    func testDecodesMachineSizeField() throws {
        let json = """
        { "machine_size": "small" }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(AdminAssistantDetailResponse.self, from: json)

        XCTAssertEqual(decoded.machine_size, "small")
    }
}
