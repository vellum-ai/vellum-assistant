import XCTest

@testable import VellumAssistantShared

// MARK: - Mock HostProxyClient

/// Records calls to `postBrowserResult` so tests can verify the payload
/// without making real HTTP requests.
@MainActor
private final class MockHostProxyClient: HostProxyClientProtocol {
    var postedBrowserResults: [HostBrowserResultPayload] = []

    func postBashResult(_ result: HostBashResultPayload) async -> Bool { true }
    func postFileResult(_ result: HostFileResultPayload) async -> Bool { true }
    func postCuResult(_ result: HostCuResultPayload) async -> Bool { true }

    func postBrowserResult(_ result: HostBrowserResultPayload) async -> Bool {
        postedBrowserResults.append(result)
        return true
    }
}

// MARK: - Tests

@MainActor
final class HostBrowserExecutorTests: XCTestCase {

    // MARK: - Transport Error Helpers

    func testTransportErrorFormatsStructuredJSON() {
        let result = HostBrowserExecutor.transportError(
            requestId: "req-1",
            code: "unreachable",
            message: "Connection refused"
        )

        XCTAssertEqual(result.requestId, "req-1")
        XCTAssertTrue(result.isError, "Transport errors must set isError=true for backend failover")

        // Verify the content is valid JSON with code and message
        guard let data = result.content.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            XCTFail("Transport error content should be valid JSON")
            return
        }
        XCTAssertEqual(json["code"] as? String, "unreachable")
        XCTAssertEqual(json["message"] as? String, "Connection refused")
    }

    /// The `non_loopback` error code is used when either the initial HTTP
    /// endpoint or the WebSocket URL from `/json/list` points to a
    /// non-loopback host. Verify it produces valid structured JSON.
    func testTransportErrorNonLoopbackFormatsStructuredJSON() {
        let result = HostBrowserExecutor.transportError(
            requestId: "req-ws-loopback",
            code: "non_loopback",
            message: "WebSocket URL host 'evil.example.com' is not a loopback address. Only localhost, 127.0.0.1, and ::1 are permitted."
        )

        XCTAssertEqual(result.requestId, "req-ws-loopback")
        XCTAssertTrue(result.isError, "non_loopback errors must set isError=true for backend failover")

        guard let data = result.content.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            XCTFail("Transport error content should be valid JSON")
            return
        }
        XCTAssertEqual(json["code"] as? String, "non_loopback")
        XCTAssertTrue(
            (json["message"] as? String)?.contains("evil.example.com") == true,
            "Error message should include the rejected host"
        )
    }

    // MARK: - Executor Run (Unit — No Real Chrome)

    /// When Chrome DevTools is not running, the executor should return a
    /// structured transport error with `unreachable` code.
    func testRunReturnsEndpointUnreachableWhenChromeNotRunning() async {
        let executor = HostBrowserExecutor()
        let request = makeRequest(requestId: "req-no-chrome", cdpMethod: "Runtime.evaluate")

        let result = await executor.run(request)

        XCTAssertEqual(result.requestId, "req-no-chrome")
        XCTAssertTrue(result.isError, "Should be a transport error when Chrome is unreachable")

        guard let data = result.content.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            XCTFail("Content should be valid JSON")
            return
        }
        XCTAssertEqual(json["code"] as? String, "unreachable")
    }

    // MARK: - cdpSessionId Target Resolution

    /// When cdpSessionId is provided but Chrome is unreachable, the executor
    /// should still return a transport error — cdpSessionId is used for target
    /// resolution from /json/list, not as a CDP protocol sessionId field.
    func testRunWithCdpSessionIdReturnsUnreachableWhenChromeNotRunning() async {
        let executor = HostBrowserExecutor()
        let request = makeRequest(
            requestId: "req-with-session",
            cdpMethod: "Runtime.evaluate",
            cdpSessionId: "ABCDEF1234567890"
        )

        let result = await executor.run(request)

        XCTAssertEqual(result.requestId, "req-with-session")
        XCTAssertTrue(result.isError, "Should be a transport error when Chrome is unreachable")

        guard let data = result.content.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            XCTFail("Content should be valid JSON")
            return
        }
        XCTAssertEqual(json["code"] as? String, "unreachable")
    }

    // MARK: - Cancellation

    func testCancelSuppressesResultPost() async {
        let mockClient = MockHostProxyClient()
        let executor = HostBrowserExecutor(proxyClient: mockClient)

        let request = makeRequest(requestId: "req-cancel-test", cdpMethod: "Runtime.evaluate")

        // Cancel before execute — the result POST should be suppressed
        executor.cancel(request.requestId)
        executor.execute(request)

        // Give the task time to start and check cancellation
        try? await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertTrue(
            mockClient.postedBrowserResults.isEmpty,
            "Cancelled requests should not post results"
        )
    }

    func testCancelInFlightRequestCancelsTask() async {
        let mockClient = MockHostProxyClient()
        let executor = HostBrowserExecutor(proxyClient: mockClient)

        let request = makeRequest(requestId: "req-inflight", cdpMethod: "Runtime.evaluate")

        // Start execution (will try to connect to non-existent Chrome)
        executor.execute(request)

        // Immediately cancel
        executor.cancel(request.requestId)

        // Wait for task cleanup
        try? await Task.sleep(nanoseconds: 300_000_000)

        // The result should either be suppressed or reflect the cancellation
        // Since we cancelled immediately, the post should be suppressed
        let hasPosted = !mockClient.postedBrowserResults.isEmpty
        if hasPosted {
            // If a result was posted before cancellation took effect, that's
            // acceptable — it should be a transport error (not a success)
            let result = mockClient.postedBrowserResults[0]
            XCTAssertTrue(result.isError)
        }
    }

    // MARK: - Execute Posts Result

    func testExecutePostsResultForUnreachableEndpoint() async {
        let mockClient = MockHostProxyClient()
        let executor = HostBrowserExecutor(proxyClient: mockClient)

        let request = makeRequest(requestId: "req-post-test", cdpMethod: "Page.navigate")
        executor.execute(request)

        // Wait for the execution to complete and post the result
        try? await Task.sleep(nanoseconds: 2_000_000_000)

        XCTAssertFalse(
            mockClient.postedBrowserResults.isEmpty,
            "Executor should post a result even when Chrome is unreachable"
        )

        let result = mockClient.postedBrowserResults[0]
        XCTAssertEqual(result.requestId, "req-post-test")
        XCTAssertTrue(result.isError, "Unreachable endpoint should produce a transport error")
    }

    // MARK: - Helpers

    /// Build a minimal `HostBrowserRequest` for testing. Uses JSON round-trip
    /// since the struct has no public init (Decodable only).
    private func makeRequest(
        requestId: String,
        cdpMethod: String,
        cdpParams: [String: Any]? = nil,
        cdpSessionId: String? = nil,
        timeoutSeconds: Double? = nil
    ) -> HostBrowserRequest {
        var json: [String: Any] = [
            "type": "host_browser_request",
            "requestId": requestId,
            "conversationId": "conv-test-123",
            "cdpMethod": cdpMethod
        ]
        if let cdpParams {
            json["cdpParams"] = cdpParams
        }
        if let cdpSessionId {
            json["cdpSessionId"] = cdpSessionId
        }
        if let timeoutSeconds {
            json["timeout_seconds"] = timeoutSeconds
        }

        let data = try! JSONSerialization.data(withJSONObject: json)
        return try! JSONDecoder().decode(HostBrowserRequest.self, from: data)
    }
}
