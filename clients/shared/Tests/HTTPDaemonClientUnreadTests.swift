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
                source: "conversation-selection",
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

    func testConversationListResponsePreservesPinMetadataFromHTTPTransport() async throws {
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
              "conversations": [
                {
                  "id": "session-123",
                  "title": "Pinned conversation",
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

        let conversation = try XCTUnwrap(capturedResponse?.conversations.first)
        XCTAssertEqual(conversation.displayOrder, 7)
        XCTAssertEqual(conversation.isPinned, true)
    }
}
