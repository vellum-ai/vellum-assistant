import XCTest

@testable import VellumAssistantShared

private final class MockAppsURLProtocol: URLProtocol {
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
final class HTTPTransportAppsListResponseTests: XCTestCase {
    override func setUp() {
        super.setUp()
        MockAppsURLProtocol.requestHandler = nil
        URLProtocol.registerClass(MockAppsURLProtocol.self)
    }

    override func tearDown() {
        URLProtocol.unregisterClass(MockAppsURLProtocol.self)
        MockAppsURLProtocol.requestHandler = nil
        super.tearDown()
    }

    func testAppsListResponseWrapsRawHTTPPayloadIntoMessage() async throws {
        let responseExpectation = expectation(description: "apps list response")

        MockAppsURLProtocol.requestHandler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://example.com/v1/apps")
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            let data = Data(
                #"""
                {"apps":[{"id":"app-1","name":"Things","description":"A task app","icon":"📱","preview":"preview-data","createdAt":123,"version":"1.0.0","contentId":"cid-1"}]}
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
            guard case .appsListResponse(let response) = message else { return }
            XCTAssertEqual(response.type, "apps_list_response")
            XCTAssertEqual(response.apps.count, 1)
            XCTAssertEqual(response.apps[0].id, "app-1")
            XCTAssertEqual(response.apps[0].name, "Things")
            XCTAssertEqual(response.apps[0].version, "1.0.0")
            responseExpectation.fulfill()
        }

        try transport.send(AppsListRequestMessage())

        await fulfillment(of: [responseExpectation], timeout: 1.0)
    }

    func testSharedAppsListResponseWrapsRawHTTPPayloadIntoMessage() async throws {
        let responseExpectation = expectation(description: "shared apps list response")

        MockAppsURLProtocol.requestHandler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://example.com/v1/apps/shared")
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            let data = Data(
                #"""
                {"apps":[{"uuid":"shared-1","name":"Shared Things","description":"Shared app","icon":"📱","preview":"preview-data","entry":"index.html","trustTier":"trusted","signerDisplayName":"Aaron","bundleSizeBytes":2048,"installedAt":"2026-03-09T00:00:00Z","version":"2.0.0","contentId":"cid-2","updateAvailable":true}]}
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
            guard case .sharedAppsListResponse(let response) = message else { return }
            XCTAssertEqual(response.type, "shared_apps_list_response")
            XCTAssertEqual(response.apps.count, 1)
            XCTAssertEqual(response.apps[0].uuid, "shared-1")
            XCTAssertEqual(response.apps[0].name, "Shared Things")
            XCTAssertEqual(response.apps[0].updateAvailable, true)
            responseExpectation.fulfill()
        }

        try transport.send(SharedAppsListRequestMessage())

        await fulfillment(of: [responseExpectation], timeout: 1.0)
    }

    func testSharedAppsList404ReturnsEmptyResponseForOlderAssistants() async throws {
        let responseExpectation = expectation(description: "shared apps list fallback response")

        MockAppsURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 404,
                httpVersion: nil,
                headerFields: nil
            )!
            let data = Data(#"{"error":{"code":"NOT_FOUND","message":"Not found"}}"#.utf8)
            return (response, data)
        }

        let transport = HTTPTransport(
            baseURL: "https://example.com",
            bearerToken: "test-token",
            conversationKey: "conv-local"
        )

        transport.onMessage = { message in
            guard case .sharedAppsListResponse(let response) = message else { return }
            XCTAssertEqual(response.type, "shared_apps_list_response")
            XCTAssertTrue(response.apps.isEmpty)
            responseExpectation.fulfill()
        }

        try transport.send(SharedAppsListRequestMessage())

        await fulfillment(of: [responseExpectation], timeout: 1.0)
    }
}
