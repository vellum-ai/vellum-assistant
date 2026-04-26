import Foundation
import XCTest

@testable import VellumAssistantLib
@testable import VellumAssistantShared

private final class MockACPClientURLProtocol: URLProtocol {
    static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let handler = Self.requestHandler else {
            XCTFail("requestHandler not set")
            return
        }

        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

@MainActor
final class ACPClientTests: XCTestCase {
    private let assistantId = "assistant-acp-test"
    private let gatewayPort = 7833
    private var originalPrimaryLockfileData: Data?
    private var primaryLockfileExisted = false

    override func setUpWithError() throws {
        try super.setUpWithError()
        MockACPClientURLProtocol.requestHandler = nil
        URLProtocol.registerClass(MockACPClientURLProtocol.self)

        let primaryLockfileURL = LockfilePaths.primary
        primaryLockfileExisted = FileManager.default.fileExists(atPath: primaryLockfileURL.path)
        if primaryLockfileExisted {
            originalPrimaryLockfileData = try Data(contentsOf: primaryLockfileURL)
        }

        try installLockfileFixture()
    }

    override func tearDownWithError() throws {
        URLProtocol.unregisterClass(MockACPClientURLProtocol.self)
        MockACPClientURLProtocol.requestHandler = nil

        if primaryLockfileExisted {
            try originalPrimaryLockfileData?.write(to: LockfilePaths.primary, options: .atomic)
        } else {
            try? FileManager.default.removeItem(at: LockfilePaths.primary)
        }

        try super.tearDownWithError()
    }

    // MARK: - listSessions

    func testListSessionsBuildsExpectedPathAndDecodesResponse() async throws {
        let requestExpectation = expectation(description: "list sessions request")
        var capturedRequest: URLRequest?

        MockACPClientURLProtocol.requestHandler = { request in
            capturedRequest = request
            requestExpectation.fulfill()

            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            let data = Data(
                #"""
                {
                  "sessions": [
                    {
                      "id": "sess-1",
                      "agentId": "claude-code",
                      "acpSessionId": "acp-1",
                      "parentConversationId": "conv-1",
                      "status": "running",
                      "startedAt": 1700000000000
                    },
                    {
                      "id": "sess-2",
                      "agentId": "agent-x",
                      "acpSessionId": "acp-2",
                      "parentConversationId": "conv-2",
                      "status": "completed",
                      "startedAt": 1700000010000,
                      "completedAt": 1700000020000,
                      "stopReason": "end_turn"
                    }
                  ]
                }
                """#.utf8
            )
            return (response, data)
        }

        let result = await ACPClient.listSessions()

        await fulfillment(of: [requestExpectation], timeout: 1.0)

        let url = try XCTUnwrap(capturedRequest?.url?.absoluteString)
        XCTAssertTrue(
            url.hasPrefix("http://127.0.0.1:7833/v1/assistants/assistant-acp-test/acp/sessions/"),
            "Unexpected path: \(url)"
        )
        XCTAssertEqual(capturedRequest?.httpMethod, "GET")
        XCTAssertTrue(url.contains("limit=50"), "Default limit should be encoded as ?limit=50: \(url)")

        guard case let .success(sessions) = result else {
            return XCTFail("Expected success, got \(result)")
        }
        XCTAssertEqual(sessions.count, 2)
        XCTAssertEqual(sessions[0].id, "sess-1")
        XCTAssertEqual(sessions[0].status, .running)
        XCTAssertEqual(sessions[1].stopReason, .endTurn)
    }

    func testListSessionsEncodesConversationIdAndCustomLimit() async throws {
        let requestExpectation = expectation(description: "list sessions filtered request")
        var capturedURL: URL?

        MockACPClientURLProtocol.requestHandler = { request in
            capturedURL = request.url
            requestExpectation.fulfill()
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(#"{"sessions":[]}"#.utf8))
        }

        _ = await ACPClient.listSessions(limit: 10, conversationId: "conv-xyz")

        await fulfillment(of: [requestExpectation], timeout: 1.0)

        let url = try XCTUnwrap(capturedURL?.absoluteString)
        XCTAssertTrue(url.contains("limit=10"), "Expected ?limit=10 in URL: \(url)")
        XCTAssertTrue(url.contains("conversationId=conv-xyz"), "Expected ?conversationId=conv-xyz in URL: \(url)")
    }

    func testListSessionsReturnsFailureForNonSuccessStatus() async {
        MockACPClientURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 500,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(#"{"error":{"message":"boom"}}"#.utf8))
        }

        let result = await ACPClient.listSessions()

        guard case .failure(.httpError(let statusCode)) = result else {
            return XCTFail("Expected .httpError, got \(result)")
        }
        XCTAssertEqual(statusCode, 500)
    }

    func testListSessionsReturnsDecodingFailureForMalformedBody() async {
        MockACPClientURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(#"{"unexpected":"shape"}"#.utf8))
        }

        let result = await ACPClient.listSessions()

        guard case .failure(.decodingFailed) = result else {
            return XCTFail("Expected .decodingFailed, got \(result)")
        }
    }

    // MARK: - cancelSession

    func testCancelSessionPostsExpectedPath() async throws {
        let requestExpectation = expectation(description: "cancel session request")
        var capturedRequest: URLRequest?

        MockACPClientURLProtocol.requestHandler = { request in
            capturedRequest = request
            requestExpectation.fulfill()
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(#"{"acpSessionId":"acp-1","cancelled":true}"#.utf8))
        }

        let result = await ACPClient.cancelSession(id: "acp-1")

        await fulfillment(of: [requestExpectation], timeout: 1.0)

        XCTAssertEqual(
            capturedRequest?.url?.absoluteString,
            "http://127.0.0.1:7833/v1/assistants/assistant-acp-test/acp/acp-1/cancel/"
        )
        XCTAssertEqual(capturedRequest?.httpMethod, "POST")

        guard case .success(let cancelled) = result else {
            return XCTFail("Expected success, got \(result)")
        }
        XCTAssertTrue(cancelled)
    }

    func testCancelSessionTreats404AsAlreadyTerminal() async {
        MockACPClientURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 404,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(#"{"error":{"message":"not found"}}"#.utf8))
        }

        let result = await ACPClient.cancelSession(id: "acp-missing")

        guard case .success(let cancelled) = result else {
            return XCTFail("Expected success(false) for 404, got \(result)")
        }
        XCTAssertFalse(cancelled, "404 should report success(false) — session already terminal")
    }

    func testCancelSessionReturnsFailureFor5xx() async {
        MockACPClientURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 503,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data())
        }

        let result = await ACPClient.cancelSession(id: "acp-1")

        guard case .failure(.httpError(let statusCode)) = result else {
            return XCTFail("Expected .httpError for 503, got \(result)")
        }
        XCTAssertEqual(statusCode, 503)
    }

    // MARK: - steerSession

    func testSteerSessionPostsExpectedPathAndBody() async throws {
        let requestExpectation = expectation(description: "steer session request")
        var capturedRequest: URLRequest?

        MockACPClientURLProtocol.requestHandler = { request in
            capturedRequest = request
            requestExpectation.fulfill()
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(#"{"acpSessionId":"acp-1","steered":true}"#.utf8))
        }

        let result = await ACPClient.steerSession(id: "acp-1", instruction: "be more concise")

        await fulfillment(of: [requestExpectation], timeout: 1.0)

        XCTAssertEqual(
            capturedRequest?.url?.absoluteString,
            "http://127.0.0.1:7833/v1/assistants/assistant-acp-test/acp/acp-1/steer/"
        )
        XCTAssertEqual(capturedRequest?.httpMethod, "POST")

        let body = try requestJSONBody(from: try XCTUnwrap(capturedRequest))
        XCTAssertEqual(body["instruction"] as? String, "be more concise")

        guard case .success(let steered) = result else {
            return XCTFail("Expected success, got \(result)")
        }
        XCTAssertTrue(steered)
    }

    func testSteerSessionTreats404AsAlreadyTerminal() async {
        MockACPClientURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 404,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data())
        }

        let result = await ACPClient.steerSession(id: "acp-missing", instruction: "hello")

        guard case .success(let steered) = result else {
            return XCTFail("Expected success(false) for 404, got \(result)")
        }
        XCTAssertFalse(steered)
    }

    // MARK: - Helpers

    private func installLockfileFixture() throws {
        let lockfile: [String: Any] = [
            "activeAssistant": assistantId,
            "assistants": [
                [
                    "assistantId": assistantId,
                    "cloud": "local",
                    "hatchedAt": "2026-03-19T12:00:00Z",
                    "resources": [
                        "gatewayPort": gatewayPort,
                    ],
                ],
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: lockfile, options: [.sortedKeys])
        try data.write(to: LockfilePaths.primary, options: .atomic)
    }

    private func requestJSONBody(from request: URLRequest) throws -> [String: Any] {
        let body: Data
        if let httpBody = request.httpBody {
            body = httpBody
        } else {
            let stream = try XCTUnwrap(request.httpBodyStream)
            stream.open()
            defer { stream.close() }

            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let bytesRead = stream.read(&buffer, maxLength: buffer.count)
                if bytesRead < 0 {
                    throw try XCTUnwrap(stream.streamError)
                }
                if bytesRead == 0 {
                    break
                }
                data.append(buffer, count: bytesRead)
            }
            body = data
        }

        return try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    }
}
