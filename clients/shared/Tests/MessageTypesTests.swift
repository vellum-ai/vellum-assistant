import XCTest

@testable import VellumAssistantShared

/// Unit tests for `ServerMessage` discriminated-union decoding.
///
/// Phase 2 of the Host Browser Proxy work added `host_browser_request` and
/// `host_browser_cancel` cases. These tests assert the SSE decoder does not
/// fail-closed on those types and that the payload fields round-trip cleanly.
final class MessageTypesTests: XCTestCase {
    private let decoder = JSONDecoder()

    func testDecodes_diskPressureStatusChanged() throws {
        let json = Data(
            """
            {
              "type": "disk_pressure_status_changed",
              "status": {
                "enabled": true,
                "state": "critical",
                "locked": true,
                "acknowledged": false,
                "overrideActive": false,
                "effectivelyLocked": true,
                "lockId": "disk-pressure-test",
                "usagePercent": 99.25,
                "thresholdPercent": 95,
                "path": "/workspace",
                "lastCheckedAt": "2026-05-05T12:00:00.000Z",
                "blockedCapabilities": ["agent-turns", "background-work", "remote-ingress"],
                "error": null
              }
            }
            """.utf8
        )

        let message = try decoder.decode(ServerMessage.self, from: json)

        guard case .diskPressureStatusChanged(let event) = message else {
            XCTFail("Expected .diskPressureStatusChanged, got \(message)")
            return
        }

        XCTAssertEqual(event.type, "disk_pressure_status_changed")
        XCTAssertTrue(event.status.enabled)
        XCTAssertEqual(event.status.state, "critical")
        XCTAssertTrue(event.status.locked)
        XCTAssertFalse(event.status.acknowledged)
        XCTAssertTrue(event.status.effectivelyLocked)
        XCTAssertEqual(event.status.lockId, "disk-pressure-test")
        XCTAssertEqual(event.status.usagePercent, 99.25)
        XCTAssertEqual(event.status.blockedCapabilities, [
            "agent-turns",
            "background-work",
            "remote-ingress",
        ])
    }

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

    // MARK: - HostBrowserResultPayload

    func testDecodes_hostBrowserResultPayload_withAllFields() throws {
        let json = Data(
            """
            {
              "requestId": "req-browser-001",
              "content": "CDP command executed successfully",
              "isError": false
            }
            """.utf8
        )

        let payload = try decoder.decode(HostBrowserResultPayload.self, from: json)

        XCTAssertEqual(payload.requestId, "req-browser-001")
        XCTAssertEqual(payload.content, "CDP command executed successfully")
        XCTAssertFalse(payload.isError)
    }

    func testDecodes_hostBrowserResultPayload_withError() throws {
        let json = Data(
            """
            {
              "requestId": "req-browser-err",
              "content": "Target closed unexpectedly",
              "isError": true
            }
            """.utf8
        )

        let payload = try decoder.decode(HostBrowserResultPayload.self, from: json)

        XCTAssertEqual(payload.requestId, "req-browser-err")
        XCTAssertEqual(payload.content, "Target closed unexpectedly")
        XCTAssertTrue(payload.isError)
    }

    func testRoundTrips_hostBrowserResultPayload() throws {
        let original = HostBrowserResultPayload(
            requestId: "req-round-trip",
            content: "Page.navigate result",
            isError: false
        )

        let encoded = try JSONEncoder().encode(original)
        let decoded = try decoder.decode(HostBrowserResultPayload.self, from: encoded)

        XCTAssertEqual(decoded.requestId, original.requestId)
        XCTAssertEqual(decoded.content, original.content)
        XCTAssertEqual(decoded.isError, original.isError)
    }

    func testEncodes_hostBrowserResultPayload_withExpectedKeys() throws {
        let payload = HostBrowserResultPayload(
            requestId: "req-keys",
            content: "ok",
            isError: false
        )

        let encoded = try JSONEncoder().encode(payload)
        let dict = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        )

        // Verify expected JSON keys match the wire shape
        XCTAssertEqual(Set(dict.keys), Set(["requestId", "content", "isError"]))
        XCTAssertEqual(dict["requestId"] as? String, "req-keys")
        XCTAssertEqual(dict["content"] as? String, "ok")
        XCTAssertEqual(dict["isError"] as? Bool, false)
    }

    // MARK: - open_conversation

    func testDecodes_openConversation_withAllFields() throws {
        let json = Data(
            """
            {
              "type": "open_conversation",
              "conversationId": "conv-abc-123",
              "title": "New research thread",
              "anchorMessageId": "msg-999"
            }
            """.utf8
        )

        let message = try decoder.decode(ServerMessage.self, from: json)

        guard case .openConversation(let request) = message else {
            XCTFail("Expected .openConversation, got \(message)")
            return
        }

        XCTAssertEqual(request.type, "open_conversation")
        XCTAssertEqual(request.conversationId, "conv-abc-123")
        XCTAssertEqual(request.title, "New research thread")
        XCTAssertEqual(request.anchorMessageId, "msg-999")
    }

    func testDecodes_openConversation_withOnlyConversationId() throws {
        let json = Data(
            """
            { "type": "open_conversation", "conversationId": "conv-min" }
            """.utf8
        )

        let message = try decoder.decode(ServerMessage.self, from: json)

        guard case .openConversation(let request) = message else {
            XCTFail("Expected .openConversation, got \(message)")
            return
        }

        XCTAssertEqual(request.conversationId, "conv-min")
        XCTAssertNil(request.title)
        XCTAssertNil(request.anchorMessageId)
    }

    // MARK: - open_conversation focus gating
    //
    // The macOS `.openConversation` handler always registers the conversation
    // in the sidebar but only switches focus when `msg.focus != false`. These
    // tests cover the `shouldFocusForOpenConversation` helper used by that
    // handler, which encodes the focus-gating decision so it can be unit
    // tested without spinning up AppDelegate.

    /// `focus: true` → focus switches.
    func testShouldFocus_trueWhenFocusIsTrue() {
        let msg = OpenConversation(
            type: "open_conversation",
            conversationId: "conv-focus-true",
            title: "Focus on this",
            anchorMessageId: nil,
            focus: true
        )
        XCTAssertTrue(shouldFocusForOpenConversation(msg))
        XCTAssertTrue(msg.shouldSwitchFocus)
    }

    /// `focus: false` → focus does NOT switch (but sidebar-registration logic
    /// in the handler still runs; see `testDecodes_openConversation_*` plus
    /// the handler code itself for that half of the contract).
    func testShouldFocus_falseWhenFocusIsFalse() {
        let msg = OpenConversation(
            type: "open_conversation",
            conversationId: "conv-focus-false",
            title: "Background fan-out",
            anchorMessageId: nil,
            focus: false
        )
        XCTAssertFalse(shouldFocusForOpenConversation(msg))
        XCTAssertFalse(msg.shouldSwitchFocus)
    }

    /// `focus` absent (nil) → focus switches. Preserves backward-compat
    /// behavior for any existing single-target caller that doesn't set the
    /// new field.
    func testShouldFocus_trueWhenFocusIsNil() {
        let msg = OpenConversation(
            type: "open_conversation",
            conversationId: "conv-focus-nil",
            title: "Legacy caller",
            anchorMessageId: nil,
            focus: nil
        )
        XCTAssertTrue(shouldFocusForOpenConversation(msg))
        XCTAssertTrue(msg.shouldSwitchFocus)
    }
}
