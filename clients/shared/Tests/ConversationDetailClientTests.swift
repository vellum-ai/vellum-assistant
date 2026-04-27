import Foundation
import XCTest

@testable import VellumAssistantShared

private final class MockConversationDetailURLProtocol: URLProtocol {
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
final class ConversationDetailClientTests: XCTestCase {
    private let assistantId = "assistant-detail-test"
    private let gatewayPort = 7832
    private var originalPrimaryLockfileData: Data?
    private var primaryLockfileExisted = false

    override func setUpWithError() throws {
        try super.setUpWithError()
        MockConversationDetailURLProtocol.requestHandler = nil
        URLProtocol.registerClass(MockConversationDetailURLProtocol.self)

        let primaryLockfileURL = LockfilePaths.primary
        primaryLockfileExisted = FileManager.default.fileExists(atPath: primaryLockfileURL.path)
        if primaryLockfileExisted {
            originalPrimaryLockfileData = try Data(contentsOf: primaryLockfileURL)
        }

        try installLockfileFixture()
    }

    override func tearDownWithError() throws {
        URLProtocol.unregisterClass(MockConversationDetailURLProtocol.self)
        MockConversationDetailURLProtocol.requestHandler = nil

        if primaryLockfileExisted {
            try originalPrimaryLockfileData?.write(to: LockfilePaths.primary, options: .atomic)
        } else {
            try? FileManager.default.removeItem(at: LockfilePaths.primary)
        }

        try super.tearDownWithError()
    }

    func testFetchConversationBuildsExpectedPathAndDecodesResponse() async throws {
        let requestExpectation = expectation(description: "conversation detail request")
        var capturedRequest: URLRequest?

        MockConversationDetailURLProtocol.requestHandler = { request in
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
                    "id": "conv-parent",
                    "title": "Original thread",
                    "createdAt": 1700000000,
                    "updatedAt": 1700000100,
                    "forkParent": {
                      "conversationId": "conv-root",
                      "messageId": "msg-root",
                      "title": "Root thread"
                    }
                  }
                }
                """#.utf8
            )
            return (response, data)
        }

        let client = ConversationDetailClient()
        let conversation = await client.fetchConversation(conversationId: "conv-parent")

        await fulfillment(of: [requestExpectation], timeout: 1.0)

        XCTAssertEqual(
            capturedRequest?.url?.absoluteString,
            "http://127.0.0.1:7832/v1/assistants/assistant-detail-test/conversations/conv-parent/"
        )
        XCTAssertEqual(capturedRequest?.httpMethod, "GET")
        XCTAssertEqual(conversation?.id, "conv-parent")
        XCTAssertEqual(conversation?.title, "Original thread")
        XCTAssertEqual(conversation?.forkParent?.conversationId, "conv-root")
        XCTAssertEqual(conversation?.forkParent?.messageId, "msg-root")
    }

    func testFetchConversationReturnsNilForNonSuccessStatus() async {
        MockConversationDetailURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 404,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(#"{"error":{"message":"not found"}}"#.utf8))
        }

        let client = ConversationDetailClient()
        let conversation = await client.fetchConversation(conversationId: "conv-missing")

        XCTAssertNil(conversation)
    }

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
}
