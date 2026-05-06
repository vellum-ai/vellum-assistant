import XCTest
@testable import VellumAssistantShared

/// Wire-protocol decoding tests for `AdminAssistantDetailResponse`.
///
/// These lock in the byte-for-byte JSON shape produced by the Django admin
/// assistant detail serializer. Any drift in the `machine_size` field name or
/// type on the server side will fail decoding here.
final class AdminAssistantClientDecodingTests: XCTestCase {
    func testDecodesSmallMachineSize() throws {
        let json = """
        { "machine_size": "small" }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(AdminAssistantDetailResponse.self, from: json)

        XCTAssertEqual(decoded.machine_size, "small")
    }

    func testDecodesNullMachineSize() throws {
        let json = """
        { "machine_size": null }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(AdminAssistantDetailResponse.self, from: json)

        XCTAssertNil(decoded.machine_size)
    }

    func testIgnoresExtraFieldsInServerPayload() throws {
        let json = """
        {
            "id": "asst_x",
            "name": "x",
            "machine_size": "medium"
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(AdminAssistantDetailResponse.self, from: json)

        XCTAssertEqual(decoded.machine_size, "medium")
    }
}
