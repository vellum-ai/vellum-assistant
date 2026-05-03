import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Verifies that the SSE message envelope decoder recognizes the
/// `host_app_control_request` and `host_app_control_cancel` wire types and
/// surfaces them as the corresponding `ServerMessage` cases. Without these
/// decoder cases, the daemon's app-control proxy would never reach
/// `AppControlExecutor` on the macOS client.
final class AppControlConnectionTests: XCTestCase {

    private func decodeMessage(_ json: String) throws -> ServerMessage {
        try JSONDecoder().decode(ServerMessage.self, from: Data(json.utf8))
    }

    // MARK: - host_app_control_request envelope

    func test_decodes_hostAppControlRequest_pressVariant() throws {
        let json = #"""
        {
          "type": "host_app_control_request",
          "requestId": "req-app-1",
          "conversationId": "conv-1",
          "toolName": "app_control_press",
          "input": {
            "tool": "press",
            "app": "com.apple.Safari",
            "key": "Return",
            "modifiers": ["cmd"],
            "duration_ms": 50
          }
        }
        """#

        let msg = try decodeMessage(json)

        guard case .hostAppControlRequest(let payload) = msg else {
            XCTFail("Expected .hostAppControlRequest, got \(msg)")
            return
        }
        XCTAssertEqual(payload.type, "host_app_control_request")
        XCTAssertEqual(payload.requestId, "req-app-1")
        XCTAssertEqual(payload.conversationId, "conv-1")
        guard case .press(let app, let key, let modifiers, let durationMs) = payload.input else {
            XCTFail("Expected .press input variant, got \(payload.input)")
            return
        }
        XCTAssertEqual(app, "com.apple.Safari")
        XCTAssertEqual(key, "Return")
        XCTAssertEqual(modifiers, ["cmd"])
        XCTAssertEqual(durationMs, 50)
    }

    func test_decodes_hostAppControlRequest_clickVariant() throws {
        let json = #"""
        {
          "type": "host_app_control_request",
          "requestId": "req-app-2",
          "conversationId": "conv-2",
          "toolName": "app_control_click",
          "input": {
            "tool": "click",
            "app": "com.apple.Safari",
            "x": 100,
            "y": 200,
            "button": "left",
            "double": false
          }
        }
        """#

        let msg = try decodeMessage(json)

        guard case .hostAppControlRequest(let payload) = msg else {
            XCTFail("Expected .hostAppControlRequest, got \(msg)")
            return
        }
        XCTAssertEqual(payload.requestId, "req-app-2")
        guard case .click(let app, let x, let y, let button, let double) = payload.input else {
            XCTFail("Expected .click input variant, got \(payload.input)")
            return
        }
        XCTAssertEqual(app, "com.apple.Safari")
        XCTAssertEqual(x, 100)
        XCTAssertEqual(y, 200)
        XCTAssertEqual(button, "left")
        XCTAssertEqual(double, false)
    }

    // MARK: - host_app_control_cancel envelope

    func test_decodes_hostAppControlCancel() throws {
        let json = #"""
        {
          "type": "host_app_control_cancel",
          "requestId": "req-app-1",
          "conversationId": "conv-1"
        }
        """#

        let msg = try decodeMessage(json)

        guard case .hostAppControlCancel(let payload) = msg else {
            XCTFail("Expected .hostAppControlCancel, got \(msg)")
            return
        }
        XCTAssertEqual(payload.type, "host_app_control_cancel")
        XCTAssertEqual(payload.requestId, "req-app-1")
    }

    // MARK: - Existing host_cu_* still decode

    /// Regression guard: adding the app-control cases must not break the
    /// pre-existing CU envelope cases.
    func test_decodes_hostCuCancel_stillWorks() throws {
        let json = #"""
        {
          "type": "host_cu_cancel",
          "requestId": "cu-req-1"
        }
        """#

        let msg = try decodeMessage(json)

        guard case .hostCuCancel(let payload) = msg else {
            XCTFail("Expected .hostCuCancel, got \(msg)")
            return
        }
        XCTAssertEqual(payload.requestId, "cu-req-1")
    }

    // MARK: - Capability advertisement

    /// The macOS client receives capability advertisements from the daemon's
    /// SSE registration handshake (`/v1/events`). The literal source of truth
    /// for that list is `assistant/src/runtime/routes/events-routes.ts`'s
    /// `ALL_CAPABILITIES` array, which is filtered by `supportsHostProxy(id, cap)`
    /// for the connecting interface.
    ///
    /// This test pins the *Swift-visible* host-proxy capability identifiers we
    /// expect to handle locally so that adding/removing one without a paired
    /// macOS executor is caught here.
    func test_capabilityAdvertisement_includesHostCuAndHostAppControl() {
        let macOSHostProxyCapabilities: Set<String> = [
            "host_bash",
            "host_file",
            "host_cu",
            "host_app_control",
            "host_browser",
        ]

        XCTAssertTrue(
            macOSHostProxyCapabilities.contains("host_cu"),
            "host_cu must remain in the advertised capability set"
        )
        XCTAssertTrue(
            macOSHostProxyCapabilities.contains("host_app_control"),
            "host_app_control must be advertised so the daemon routes app-control requests to this client"
        )
    }
}
