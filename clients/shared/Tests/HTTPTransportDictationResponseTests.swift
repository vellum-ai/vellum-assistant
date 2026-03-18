import XCTest

@testable import VellumAssistantShared

private final class MockDictationURLProtocol: URLProtocol {
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
final class HTTPTransportDictationResponseTests: XCTestCase {
    override func setUp() {
        super.setUp()
        MockDictationURLProtocol.requestHandler = nil
        URLProtocol.registerClass(MockDictationURLProtocol.self)
    }

    override func tearDown() {
        URLProtocol.unregisterClass(MockDictationURLProtocol.self)
        MockDictationURLProtocol.requestHandler = nil
        super.tearDown()
    }

    func testDictationResponseWrapsRawHTTPPayloadIntoMessage() async throws {
        let responseExpectation = expectation(description: "dictation response")

        MockDictationURLProtocol.requestHandler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://example.com/v1/dictation")
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            let data = Data(
                #"""
                {"text":"hello there","mode":"dictation","resolvedProfileId":"default","profileSource":"bundle"}
                """#.utf8
            )
            return (response, data)
        }

        let transport = HTTPTransport(
            baseURL: "https://example.com",
            bearerToken: "test-token",
            conversationKey: "conv-local"
        )

        transport.onMessage = { message in
            guard case .dictationResponse(let response) = message else { return }
            XCTAssertEqual(response.type, "dictation_response")
            XCTAssertEqual(response.text, "hello there")
            XCTAssertEqual(response.mode, "dictation")
            XCTAssertEqual(response.resolvedProfileId, "default")
            XCTAssertEqual(response.profileSource, "bundle")
            responseExpectation.fulfill()
        }

        try transport.send(
            DictationRequest(
                transcription: "hello there",
                context: .create(
                    bundleIdentifier: "com.apple.TextEdit",
                    appName: "TextEdit",
                    windowTitle: "Untitled",
                    selectedText: nil,
                    cursorInTextField: true
                )
            )
        )

        await fulfillment(of: [responseExpectation], timeout: 1.0)
    }

    func testDictationFailureFallsBackToRawTranscriptionResponse() async throws {
        let responseExpectation = expectation(description: "dictation fallback response")

        MockDictationURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 500,
                httpVersion: nil,
                headerFields: nil
            )!
            let data = Data(
                #"""
                {"error":{"code":"INTERNAL_ERROR","message":"Dictation backend unavailable"}}
                """#.utf8
            )
            return (response, data)
        }

        let transport = HTTPTransport(
            baseURL: "https://example.com",
            bearerToken: "test-token",
            conversationKey: "conv-local"
        )

        transport.onMessage = { message in
            guard case .dictationResponse(let response) = message else { return }
            XCTAssertEqual(response.type, "dictation_response")
            XCTAssertEqual(response.text, "fallback me")
            XCTAssertEqual(response.mode, "dictation")
            responseExpectation.fulfill()
        }

        try transport.send(
            DictationRequest(
                transcription: "fallback me",
                context: .create(
                    bundleIdentifier: "com.apple.TextEdit",
                    appName: "TextEdit",
                    windowTitle: "Untitled",
                    selectedText: nil,
                    cursorInTextField: true
                )
            )
        )

        await fulfillment(of: [responseExpectation], timeout: 1.0)
    }

    func testDictationCommandFailurePreservesSelectedText() async throws {
        let responseExpectation = expectation(description: "dictation command fallback response")

        MockDictationURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 500,
                httpVersion: nil,
                headerFields: nil
            )!
            let data = Data(
                #"""
                {"error":{"code":"INTERNAL_ERROR","message":"Command transform unavailable"}}
                """#.utf8
            )
            return (response, data)
        }

        let transport = HTTPTransport(
            baseURL: "https://example.com",
            bearerToken: "test-token",
            conversationKey: "conv-local"
        )

        transport.onMessage = { message in
            guard case .dictationResponse(let response) = message else { return }
            XCTAssertEqual(response.type, "dictation_response")
            XCTAssertEqual(response.text, "Original selected text")
            XCTAssertEqual(response.mode, "command")
            responseExpectation.fulfill()
        }

        try transport.send(
            DictationRequest(
                transcription: "make this shorter",
                context: .create(
                    bundleIdentifier: "com.apple.TextEdit",
                    appName: "TextEdit",
                    windowTitle: "Untitled",
                    selectedText: "Original selected text",
                    cursorInTextField: true
                )
            )
        )

        await fulfillment(of: [responseExpectation], timeout: 1.0)
    }
}
