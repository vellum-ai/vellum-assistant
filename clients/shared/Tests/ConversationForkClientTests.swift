import Foundation
import XCTest

@testable import VellumAssistantShared

private final class MockConversationForkURLProtocol: URLProtocol {
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
final class ConversationForkClientTests: XCTestCase {
    private let assistantId = "assistant-fork-test"
    private let gatewayPort = 7831
    private var originalConnectedAssistantId: Any?
    private var originalPrimaryLockfileData: Data?
    private var primaryLockfileExisted = false

    override func setUpWithError() throws {
        try super.setUpWithError()
        MockConversationForkURLProtocol.requestHandler = nil
        URLProtocol.registerClass(MockConversationForkURLProtocol.self)

        originalConnectedAssistantId = UserDefaults.standard.object(forKey: "connectedAssistantId")

        let primaryLockfileURL = LockfilePaths.primary
        primaryLockfileExisted = FileManager.default.fileExists(atPath: primaryLockfileURL.path)
        if primaryLockfileExisted {
            originalPrimaryLockfileData = try Data(contentsOf: primaryLockfileURL)
        }

        try installLockfileFixture()
    }

    override func tearDownWithError() throws {
        URLProtocol.unregisterClass(MockConversationForkURLProtocol.self)
        MockConversationForkURLProtocol.requestHandler = nil

        if primaryLockfileExisted {
            try originalPrimaryLockfileData?.write(to: LockfilePaths.primary, options: .atomic)
        } else {
            try? FileManager.default.removeItem(at: LockfilePaths.primary)
        }

        if let originalConnectedAssistantId {
            UserDefaults.standard.set(originalConnectedAssistantId, forKey: "connectedAssistantId")
        } else {
            UserDefaults.standard.removeObject(forKey: "connectedAssistantId")
        }

        try super.tearDownWithError()
    }

    func testForkConversationPostsExpectedPathAndBodyAndDecodesResponse() async throws {
        let requestExpectation = expectation(description: "fork conversation request")
        var capturedRequest: URLRequest?

        MockConversationForkURLProtocol.requestHandler = { request in
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
                  "conversation": {
                    "id": "conv-forked",
                    "title": "Forked thread",
                    "createdAt": 1700000200,
                    "updatedAt": 1700000300,
                    "forkParent": {
                      "conversationId": "conv-parent",
                      "messageId": "msg-parent",
                      "title": "Original thread"
                    }
                  }
                }
                """#.utf8
            )
            return (response, data)
        }

        let client = ConversationForkClient()
        let conversation = await client.forkConversation(
            conversationId: "conv-parent",
            throughMessageId: "msg-parent"
        )

        await fulfillment(of: [requestExpectation], timeout: 1.0)

        XCTAssertEqual(
            capturedRequest?.url?.absoluteString,
            "http://127.0.0.1:7831/v1/assistants/assistant-fork-test/conversations/fork/"
        )
        XCTAssertEqual(capturedRequest?.httpMethod, "POST")

        let body = try requestJSONBody(from: try XCTUnwrap(capturedRequest))
        XCTAssertEqual(body["conversationId"] as? String, "conv-parent")
        XCTAssertEqual(body["throughMessageId"] as? String, "msg-parent")

        XCTAssertEqual(conversation?.id, "conv-forked")
        XCTAssertEqual(conversation?.title, "Forked thread")
        XCTAssertEqual(conversation?.forkParent?.conversationId, "conv-parent")
        XCTAssertEqual(conversation?.forkParent?.messageId, "msg-parent")
    }

    func testForkConversationOmitsThroughMessageIdWhenNil() async throws {
        let requestExpectation = expectation(description: "fork conversation request without throughMessageId")
        var capturedRequest: URLRequest?

        MockConversationForkURLProtocol.requestHandler = { request in
            capturedRequest = request
            requestExpectation.fulfill()

            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(#"{"conversation":{"id":"conv-forked","title":"Forked thread","updatedAt":1700000300}}"#.utf8))
        }

        let client = ConversationForkClient()
        _ = await client.forkConversation(conversationId: "conv-parent", throughMessageId: nil)

        await fulfillment(of: [requestExpectation], timeout: 1.0)

        let body = try requestJSONBody(from: try XCTUnwrap(capturedRequest))
        XCTAssertEqual(body["conversationId"] as? String, "conv-parent")
        XCTAssertNil(body["throughMessageId"])
    }

    func testForkConversationReturnsNilForNonSuccessStatus() async {
        MockConversationForkURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 500,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(#"{"error":{"message":"boom"}}"#.utf8))
        }

        let client = ConversationForkClient()
        let conversation = await client.forkConversation(
            conversationId: "conv-parent",
            throughMessageId: "msg-parent"
        )

        XCTAssertNil(conversation)
    }

    private func installLockfileFixture() throws {
        let lockfile: [String: Any] = [
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
        UserDefaults.standard.set(assistantId, forKey: "connectedAssistantId")
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
