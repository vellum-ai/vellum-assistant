import XCTest

@testable import VellumAssistantShared

private final class MockURLProtocol: URLProtocol {
    /// Ordered list of handlers — each request pops the first handler.
    /// Allows different responses for sequential requests (e.g. upload then send).
    nonisolated(unsafe) static var handlers: [((URLRequest) throws -> (HTTPURLResponse, Data))] = []

    /// All requests received, in order.
    nonisolated(unsafe) static var capturedRequests: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        Self.capturedRequests.append(request)

        guard !Self.handlers.isEmpty else {
            XCTFail("MockURLProtocol: no handler for request \(request.url?.absoluteString ?? "nil")")
            return
        }

        let handler = Self.handlers.removeFirst()

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
final class HTTPDaemonClientAttachmentSendTests: XCTestCase {

    override func setUp() {
        super.setUp()
        MockURLProtocol.handlers = []
        MockURLProtocol.capturedRequests = []
        URLProtocol.registerClass(MockURLProtocol.self)
    }

    override func tearDown() {
        URLProtocol.unregisterClass(MockURLProtocol.self)
        MockURLProtocol.handlers = []
        MockURLProtocol.capturedRequests = []
        super.tearDown()
    }

    private func requestBody(from request: URLRequest) throws -> Data {
        if let body = request.httpBody {
            return body
        }

        let stream = try XCTUnwrap(request.httpBodyStream)
        stream.open()
        defer { stream.close() }

        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)

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

    // MARK: - Tests

    func testAttachmentUploadPrecedesMessageSend() async throws {
        // Enqueue: first request = attachment upload, second = message send.
        MockURLProtocol.handlers = [
            // Attachment upload response
            { request in
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 201,
                    httpVersion: nil,
                    headerFields: nil
                )!
                return (response, Data(#"{"id":"att-001"}"#.utf8))
            },
            // Message send response
            { request in
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 202,
                    httpVersion: nil,
                    headerFields: nil
                )!
                return (response, Data(#"{"conversationId":"conv-server-1"}"#.utf8))
            },
        ]

        let transport = HTTPTransport(
            baseURL: "https://example.com",
            bearerToken: "test-token",
            conversationKey: "conv-local"
        )

        let attachment = UserMessageAttachment(
            filename: "photo.png",
            mimeType: "image/png",
            data: "base64data"
        )

        await transport.sendMessage(
            content: "Check this image",
            conversationId: "conv-local",
            attachments: [attachment]
        )

        // Verify exactly two requests were made
        XCTAssertEqual(MockURLProtocol.capturedRequests.count, 2)

        // First request should be the attachment upload
        let uploadRequest = MockURLProtocol.capturedRequests[0]
        XCTAssertTrue(
            uploadRequest.url?.path.hasSuffix("/v1/attachments") == true,
            "First request should be to /v1/attachments, got \(uploadRequest.url?.path ?? "nil")"
        )
        XCTAssertEqual(uploadRequest.httpMethod, "POST")

        // Second request should be the message send
        let sendRequest = MockURLProtocol.capturedRequests[1]
        XCTAssertTrue(
            sendRequest.url?.path.hasSuffix("/v1/messages") == true,
            "Second request should be to /v1/messages, got \(sendRequest.url?.path ?? "nil")"
        )
        XCTAssertEqual(sendRequest.httpMethod, "POST")
    }

    func testMessageBodyContainsUploadedAttachmentIds() async throws {
        // Enqueue: two attachment uploads then the message send.
        MockURLProtocol.handlers = [
            // First attachment upload
            { request in
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 201,
                    httpVersion: nil,
                    headerFields: nil
                )!
                return (response, Data(#"{"id":"att-001"}"#.utf8))
            },
            // Second attachment upload
            { request in
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 201,
                    httpVersion: nil,
                    headerFields: nil
                )!
                return (response, Data(#"{"id":"att-002"}"#.utf8))
            },
            // Message send
            { request in
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 202,
                    httpVersion: nil,
                    headerFields: nil
                )!
                return (response, Data(#"{"conversationId":"conv-server-1"}"#.utf8))
            },
        ]

        let transport = HTTPTransport(
            baseURL: "https://example.com",
            bearerToken: "test-token",
            conversationKey: "conv-local"
        )

        let attachments = [
            UserMessageAttachment(filename: "a.png", mimeType: "image/png", data: "data1"),
            UserMessageAttachment(filename: "b.jpg", mimeType: "image/jpeg", data: "data2"),
        ]

        await transport.sendMessage(
            content: "Two images",
            conversationId: "conv-local",
            attachments: attachments
        )

        // The last captured request is the message send
        XCTAssertEqual(MockURLProtocol.capturedRequests.count, 3)

        let sendRequest = MockURLProtocol.capturedRequests[2]
        let body = try requestBody(from: sendRequest)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])

        let attachmentIds = try XCTUnwrap(json["attachmentIds"] as? [String])
        XCTAssertEqual(attachmentIds, ["att-001", "att-002"])
    }

    func testRetryReusesUploadedAttachmentIds() async throws {
        // First call: upload succeeds, send returns 401.
        // Second call (retry): send succeeds — no new upload request.
        MockURLProtocol.handlers = [
            // Attachment upload (first attempt)
            { request in
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 201,
                    httpVersion: nil,
                    headerFields: nil
                )!
                return (response, Data(#"{"id":"att-reuse"}"#.utf8))
            },
            // Message send (first attempt — 401)
            { request in
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 401,
                    httpVersion: nil,
                    headerFields: nil
                )!
                return (response, Data(#"{"error":{"code":"UNAUTHORIZED","message":"expired"}}"#.utf8))
            },
            // Token refresh (triggered by 401 recovery)
            { request in
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 401,
                    httpVersion: nil,
                    headerFields: nil
                )!
                // Refresh fails transiently — sendMessage emits conversationError
                return (response, Data(#"{"error":{"code":"UNAUTHORIZED","message":"refresh failed"}}"#.utf8))
            },
        ]

        var receivedError: ConversationErrorMessage?
        let transport = HTTPTransport(
            baseURL: "https://example.com",
            bearerToken: "test-token",
            conversationKey: "conv-local"
        )
        transport.onMessage = { message in
            if case .conversationError(let err) = message {
                receivedError = err
            }
        }

        let attachment = UserMessageAttachment(
            filename: "photo.png",
            mimeType: "image/png",
            data: "base64data"
        )

        await transport.sendMessage(
            content: "Retry test",
            conversationId: "conv-local",
            attachments: [attachment]
        )

        // The upload should only happen once (the first request).
        // No second upload request should be made on retry.
        let uploadRequests = MockURLProtocol.capturedRequests.filter {
            $0.url?.path.hasSuffix("/v1/attachments") == true
        }
        XCTAssertEqual(uploadRequests.count, 1, "Attachment should only be uploaded once, not re-uploaded on retry")
    }

    func testSendWithNoAttachmentsSkipsUpload() async throws {
        MockURLProtocol.handlers = [
            // Message send only — no upload expected
            { request in
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 202,
                    httpVersion: nil,
                    headerFields: nil
                )!
                return (response, Data(#"{"conversationId":"conv-server-1"}"#.utf8))
            },
        ]

        let transport = HTTPTransport(
            baseURL: "https://example.com",
            bearerToken: "test-token",
            conversationKey: "conv-local"
        )

        await transport.sendMessage(
            content: "No attachments",
            conversationId: "conv-local"
        )

        // Only one request — the message send
        XCTAssertEqual(MockURLProtocol.capturedRequests.count, 1)

        let sendRequest = MockURLProtocol.capturedRequests[0]
        XCTAssertTrue(
            sendRequest.url?.path.hasSuffix("/v1/messages") == true,
            "Only request should be to /v1/messages"
        )

        // No attachmentIds in body
        let body = try requestBody(from: sendRequest)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertNil(json["attachmentIds"], "attachmentIds should not be present when no attachments are sent")
    }
}
