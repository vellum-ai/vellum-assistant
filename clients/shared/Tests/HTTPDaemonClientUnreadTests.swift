import XCTest

@testable import VellumAssistantShared

private final class MockURLProtocol: URLProtocol {
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
final class HTTPDaemonClientUnreadTests: XCTestCase {
    private func requestBody(from request: URLRequest) throws -> Data {
        if let body = request.httpBody {
            return body
        }

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

        return data
    }

    override func setUp() {
        super.setUp()
        MockURLProtocol.requestHandler = nil
        URLProtocol.registerClass(MockURLProtocol.self)
    }

    override func tearDown() {
        URLProtocol.unregisterClass(MockURLProtocol.self)
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    func testRuntimeFlatUnreadSignalPostsExpectedRequest() async throws {
        let requestExpectation = expectation(description: "runtime unread request")
        var capturedRequest: URLRequest?

        MockURLProtocol.requestHandler = { request in
            capturedRequest = request
            requestExpectation.fulfill()
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(#"{"ok":true}"#.utf8))
        }

        let transport = HTTPTransport(
            baseURL: "https://example.com",
            bearerToken: "test-token",
            conversationKey: "conv-local"
        )

        try transport.send(
            ConversationUnreadSignal(
                conversationId: "conv-123",
                sourceChannel: "vellum",
                signalType: "macos_conversation_opened",
                confidence: "explicit",
                source: "ui-navigation",
                evidenceText: "User selected Mark as unread"
            )
        )

        await fulfillment(of: [requestExpectation], timeout: 1.0)

        XCTAssertEqual(
            capturedRequest?.url?.absoluteString,
            "https://example.com/v1/conversations/unread"
        )
        XCTAssertEqual(capturedRequest?.httpMethod, "POST")
        XCTAssertEqual(
            capturedRequest?.value(forHTTPHeaderField: "Authorization"),
            "Bearer test-token"
        )

        let request = try XCTUnwrap(capturedRequest)
        let body = try requestBody(from: request)
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: body) as? [String: Any]
        )
        XCTAssertEqual(json["conversationId"] as? String, "conv-123")
        XCTAssertEqual(json["sourceChannel"] as? String, "vellum")
        XCTAssertEqual(json["signalType"] as? String, "macos_conversation_opened")
        XCTAssertEqual(json["confidence"] as? String, "explicit")
        XCTAssertEqual(json["source"] as? String, "ui-navigation")
        XCTAssertEqual(
            json["evidenceText"] as? String,
            "User selected Mark as unread"
        )
    }

    func testAwaitedUnreadSignalThrowsDecodedRuntimeError() async throws {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 422,
                httpVersion: nil,
                headerFields: nil
            )!
            return (
                response,
                Data(#"{"error":{"code":"UNPROCESSABLE_ENTITY","message":"Conversation has no assistant message to mark unread"}}"#.utf8)
            )
        }

        let transport = HTTPTransport(
            baseURL: "https://example.com",
            bearerToken: "test-token",
            conversationKey: "conv-local"
        )

        do {
            try await transport.sendConversationUnread(
                ConversationUnreadSignal(
                    conversationId: "conv-123",
                    sourceChannel: "vellum",
                    signalType: "macos_conversation_opened",
                    confidence: "explicit",
                    source: "ui-navigation"
                )
            )
            XCTFail("Expected sendConversationUnread to throw")
        } catch let error as HTTPTransport.HTTPTransportError {
            XCTAssertEqual(
                error.errorDescription,
                "Conversation has no assistant message to mark unread"
            )
        } catch {
            XCTFail("Expected HTTPTransportError, got \(error)")
        }
    }

    func testPlatformProxyUnreadSignalPostsExpectedRequest() async throws {
        let requestExpectation = expectation(description: "platform unread request")
        var capturedRequest: URLRequest?

        MockURLProtocol.requestHandler = { request in
            capturedRequest = request
            requestExpectation.fulfill()
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(#"{"ok":true}"#.utf8))
        }

        let transport = HTTPTransport(
            baseURL: "https://platform.example.com",
            bearerToken: "test-token",
            conversationKey: "conv-local",
            transportMetadata: TransportMetadata(
                routeMode: .platformAssistantProxy,
                authMode: .bearerToken,
                platformAssistantId: "assistant-123"
            )
        )

        try transport.send(
            ConversationUnreadSignal(
                conversationId: "conv-456",
                sourceChannel: "vellum",
                signalType: "macos_conversation_opened",
                confidence: "explicit",
                source: "ui-navigation"
            )
        )

        await fulfillment(of: [requestExpectation], timeout: 1.0)

        XCTAssertEqual(
            capturedRequest?.url?.absoluteString,
            "https://platform.example.com/v1/assistants/assistant-123/conversations/unread/"
        )
        XCTAssertEqual(capturedRequest?.httpMethod, "POST")
        XCTAssertEqual(
            capturedRequest?.value(forHTTPHeaderField: "Authorization"),
            "Bearer test-token"
        )

        let request = try XCTUnwrap(capturedRequest)
        let body = try requestBody(from: request)
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: body) as? [String: Any]
        )
        XCTAssertEqual(json["conversationId"] as? String, "conv-456")
        XCTAssertEqual(json["signalType"] as? String, "macos_conversation_opened")
    }

    func testUnreadSignalSerializesMetadataIntoJSONBody() async throws {
        let requestExpectation = expectation(description: "unread metadata request")
        var capturedRequest: URLRequest?

        MockURLProtocol.requestHandler = { request in
            capturedRequest = request
            requestExpectation.fulfill()
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(#"{"ok":true}"#.utf8))
        }

        let transport = HTTPTransport(
            baseURL: "https://example.com",
            bearerToken: "test-token",
            conversationKey: "conv-local"
        )

        try transport.send(
            ConversationUnreadSignal(
                conversationId: "conv-789",
                sourceChannel: "vellum",
                signalType: "macos_conversation_opened",
                confidence: "explicit",
                source: "ui-navigation",
                metadata: [
                    "threadOrigin": AnyCodable("inbox"),
                    "badgeCount": AnyCodable(3),
                    "userInitiated": AnyCodable(true),
                ]
            )
        )

        await fulfillment(of: [requestExpectation], timeout: 1.0)

        let request = try XCTUnwrap(capturedRequest)
        let body = try requestBody(from: request)
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: body) as? [String: Any]
        )
        let metadata = try XCTUnwrap(json["metadata"] as? [String: Any])

        XCTAssertEqual(metadata["threadOrigin"] as? String, "inbox")
        XCTAssertEqual(metadata["badgeCount"] as? Int, 3)
        XCTAssertEqual(metadata["userInitiated"] as? Bool, true)
    }

    func testSeenSignalSerializesMetadataIntoJSONBody() async throws {
        let requestExpectation = expectation(description: "seen metadata request")
        var capturedRequest: URLRequest?

        MockURLProtocol.requestHandler = { request in
            capturedRequest = request
            requestExpectation.fulfill()
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(#"{"ok":true}"#.utf8))
        }

        let transport = HTTPTransport(
            baseURL: "https://example.com",
            bearerToken: "test-token",
            conversationKey: "conv-local"
        )

        try transport.send(
            ConversationSeenSignal(
                conversationId: "conv-321",
                sourceChannel: "vellum",
                signalType: "macos_conversation_seen",
                confidence: "explicit",
                source: "thread-selection",
                metadata: [
                    "view": AnyCodable("inbox"),
                    "attempt": AnyCodable(1),
                ]
            )
        )

        await fulfillment(of: [requestExpectation], timeout: 1.0)

        let request = try XCTUnwrap(capturedRequest)
        let body = try requestBody(from: request)
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: body) as? [String: Any]
        )
        let metadata = try XCTUnwrap(json["metadata"] as? [String: Any])

        XCTAssertEqual(metadata["view"] as? String, "inbox")
        XCTAssertEqual(metadata["attempt"] as? Int, 1)
    }

    func testSessionListResponsePreservesPinMetadataFromHTTPTransport() async throws {
        let responseExpectation = expectation(description: "session list response")
        var capturedResponse: ConversationListResponseMessage?

        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            let body = """
            {
              "sessions": [
                {
                  "id": "session-123",
                  "title": "Pinned thread",
                  "createdAt": 1000,
                  "updatedAt": 2000,
                  "displayOrder": 7,
                  "isPinned": true
                }
              ],
              "hasMore": false
            }
            """
            return (response, Data(body.utf8))
        }

        let transport = HTTPTransport(
            baseURL: "https://example.com",
            bearerToken: "test-token",
            conversationKey: "conv-local"
        )
        transport.onMessage = { message in
            if case let .conversationListResponse(response) = message {
                capturedResponse = response
                responseExpectation.fulfill()
            }
        }

        try transport.send(ConversationListRequestMessage(offset: 0, limit: 50))

        await fulfillment(of: [responseExpectation], timeout: 1.0)

        let session = try XCTUnwrap(capturedResponse?.sessions.first)
        XCTAssertEqual(session.displayOrder, 7)
        XCTAssertEqual(session.isPinned, true)
    }
}
