import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

// MARK: - Mock URLProtocol

private class MockURLProtocol: URLProtocol {
    static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = MockURLProtocol.requestHandler else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown))
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

// MARK: - Tests

@MainActor
final class ImageMIMEProbeTests: XCTestCase {

    private var probe: ImageMIMEProbe!
    private var mockSession: URLSession!

    override func setUp() {
        super.setUp()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        mockSession = URLSession(configuration: config)
        probe = ImageMIMEProbe(session: mockSession)
    }

    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        probe = nil
        mockSession = nil
        super.tearDown()
    }

    // MARK: - Content-Type classification

    func testImageContentTypeReturnsImage() async {
        MockURLProtocol.requestHandler = { request in
            XCTAssertEqual(request.httpMethod, "HEAD")
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "image/png"]
            )!
            return (response, Data())
        }

        let url = URL(string: "https://example.com/photo")!
        let result = await probe.probe(url)
        XCTAssertEqual(result, .image)
    }

    func testImageJPEGContentTypeReturnsImage() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "image/jpeg; charset=utf-8"]
            )!
            return (response, Data())
        }

        let url = URL(string: "https://example.com/photo")!
        let result = await probe.probe(url)
        XCTAssertEqual(result, .image)
    }

    func testNonImageContentTypeReturnsNotImage() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "text/html"]
            )!
            return (response, Data())
        }

        let url = URL(string: "https://example.com/page")!
        let result = await probe.probe(url)
        XCTAssertEqual(result, .notImage)
    }

    func testApplicationJSONReturnsNotImage() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, Data())
        }

        let url = URL(string: "https://example.com/api/data")!
        let result = await probe.probe(url)
        XCTAssertEqual(result, .notImage)
    }

    // MARK: - Error handling

    func testNetworkErrorReturnsUnknown() async {
        MockURLProtocol.requestHandler = { _ in
            throw URLError(.notConnectedToInternet)
        }

        let url = URL(string: "https://example.com/photo")!
        let result = await probe.probe(url)
        XCTAssertEqual(result, .unknown)
    }

    func testTimeoutReturnsUnknown() async {
        MockURLProtocol.requestHandler = { _ in
            throw URLError(.timedOut)
        }

        let url = URL(string: "https://example.com/slow")!
        let result = await probe.probe(url)
        XCTAssertEqual(result, .unknown)
    }

    func testMissingContentTypeReturnsUnknown() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: [:]
            )!
            return (response, Data())
        }

        let url = URL(string: "https://example.com/mystery")!
        let result = await probe.probe(url)
        XCTAssertEqual(result, .unknown)
    }

    // MARK: - Caching

    func testCacheHitSkipsNetwork() async {
        var callCount = 0
        MockURLProtocol.requestHandler = { request in
            callCount += 1
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "image/png"]
            )!
            return (response, Data())
        }

        let url = URL(string: "https://example.com/cached")!
        let first = await probe.probe(url)
        let second = await probe.probe(url)

        XCTAssertEqual(first, .image)
        XCTAssertEqual(second, .image)
        XCTAssertEqual(callCount, 1, "Second probe should use cache, not make a network call")
    }

    func testClearCacheResetsCache() async {
        var callCount = 0
        MockURLProtocol.requestHandler = { request in
            callCount += 1
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "image/webp"]
            )!
            return (response, Data())
        }

        let url = URL(string: "https://example.com/cleared")!
        _ = await probe.probe(url)
        XCTAssertEqual(callCount, 1)

        probe.clearCache()

        _ = await probe.probe(url)
        XCTAssertEqual(callCount, 2, "After clearing cache, probe should make a new network call")
    }

    // MARK: - Scheme enforcement

    func testNonHTTPSReturnsNotImageWithoutProbing() async {
        var wasCalled = false
        MockURLProtocol.requestHandler = { _ in
            wasCalled = true
            let response = HTTPURLResponse(
                url: URL(string: "http://example.com")!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "image/png"]
            )!
            return (response, Data())
        }

        let url = URL(string: "http://example.com/photo.png")!
        let result = await probe.probe(url)

        XCTAssertEqual(result, .notImage)
        XCTAssertFalse(wasCalled, "HTTP URL should be rejected without making a network request")
    }

    func testFTPSchemeReturnsNotImageWithoutProbing() async {
        var wasCalled = false
        MockURLProtocol.requestHandler = { _ in
            wasCalled = true
            let response = HTTPURLResponse(
                url: URL(string: "https://example.com")!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "image/png"]
            )!
            return (response, Data())
        }

        let url = URL(string: "ftp://example.com/photo.png")!
        let result = await probe.probe(url)

        XCTAssertEqual(result, .notImage)
        XCTAssertFalse(wasCalled, "FTP URL should be rejected without making a network request")
    }
}
