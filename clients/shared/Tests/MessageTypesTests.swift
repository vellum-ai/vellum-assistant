import XCTest

@testable import VellumAssistantShared

/// Unit tests for `ServerMessage` discriminated-union decoding.
///
/// Phase 2 of the Host Browser Proxy work added `host_browser_request` and
/// `host_browser_cancel` cases. These tests assert the SSE decoder does not
/// fail-closed on those types and that the payload fields round-trip cleanly.
final class MessageTypesTests: XCTestCase {
    private let decoder = JSONDecoder()

    // MARK: - host_browser_request

    func testDecodes_hostBrowserRequest_withAllFields() throws {
        let json = Data(
            """
            {
              "type": "host_browser_request",
              "requestId": "req-abc-123",
              "conversationId": "conv-xyz-789",
              "cdpMethod": "Page.navigate",
              "cdpParams": {
                "url": "https://example.com",
                "transitionType": "typed"
              },
              "cdpSessionId": "session-555",
              "timeout_seconds": 45.5
            }
            """.utf8
        )

        let message = try decoder.decode(ServerMessage.self, from: json)

        guard case .hostBrowserRequest(let request) = message else {
            XCTFail("Expected .hostBrowserRequest, got \(message)")
            return
        }

        XCTAssertEqual(request.type, "host_browser_request")
        XCTAssertEqual(request.requestId, "req-abc-123")
        XCTAssertEqual(request.conversationId, "conv-xyz-789")
        XCTAssertEqual(request.cdpMethod, "Page.navigate")
        XCTAssertEqual(request.cdpSessionId, "session-555")
        XCTAssertEqual(request.timeoutSeconds, 45.5)

        let params = try XCTUnwrap(request.cdpParams)
        XCTAssertEqual(params["url"]?.value as? String, "https://example.com")
        XCTAssertEqual(params["transitionType"]?.value as? String, "typed")
    }

    /// Regression test for the typing fix that changed `timeoutSeconds` from
    /// `Int?` to `Double?`. The daemon's wire contract is `timeout_seconds?:
    /// number`, which permits fractional values such as `0.01`. With the old
    /// `Int?` typing, `JSONDecoder` would throw a type-mismatch on this
    /// payload and the SSE decoder would drop the entire `host_browser_request`
    /// event — exactly the failure mode this Phase 2 PR is meant to prevent.
    func testDecodes_hostBrowserRequest_withFractionalTimeoutSeconds() throws {
        let json = Data(
            """
            {
              "type": "host_browser_request",
              "requestId": "req-frac",
              "conversationId": "conv-frac",
              "cdpMethod": "Page.navigate",
              "timeout_seconds": 0.01
            }
            """.utf8
        )

        let message = try decoder.decode(ServerMessage.self, from: json)

        guard case .hostBrowserRequest(let request) = message else {
            XCTFail("Expected .hostBrowserRequest, got \(message)")
            return
        }

        XCTAssertEqual(request.type, "host_browser_request")
        XCTAssertEqual(request.requestId, "req-frac")
        XCTAssertEqual(request.conversationId, "conv-frac")
        XCTAssertEqual(request.cdpMethod, "Page.navigate")
        XCTAssertEqual(request.timeoutSeconds, 0.01)
    }

    func testDecodes_hostBrowserRequest_withOptionalFieldsAbsent() throws {
        let json = Data(
            """
            {
              "type": "host_browser_request",
              "requestId": "req-min",
              "conversationId": "conv-min",
              "cdpMethod": "Browser.getVersion"
            }
            """.utf8
        )

        let message = try decoder.decode(ServerMessage.self, from: json)

        guard case .hostBrowserRequest(let request) = message else {
            XCTFail("Expected .hostBrowserRequest, got \(message)")
            return
        }

        XCTAssertEqual(request.type, "host_browser_request")
        XCTAssertEqual(request.requestId, "req-min")
        XCTAssertEqual(request.conversationId, "conv-min")
        XCTAssertEqual(request.cdpMethod, "Browser.getVersion")
        XCTAssertNil(request.cdpParams)
        XCTAssertNil(request.cdpSessionId)
        XCTAssertNil(request.timeoutSeconds)
    }

    // MARK: - host_browser_cancel

    func testDecodes_hostBrowserCancel() throws {
        let json = Data(
            """
            {
              "type": "host_browser_cancel",
              "requestId": "req-abc-123"
            }
            """.utf8
        )

        let message = try decoder.decode(ServerMessage.self, from: json)

        guard case .hostBrowserCancel(let cancel) = message else {
            XCTFail("Expected .hostBrowserCancel, got \(message)")
            return
        }

        XCTAssertEqual(cancel.type, "host_browser_cancel")
        XCTAssertEqual(cancel.requestId, "req-abc-123")
    }
}
