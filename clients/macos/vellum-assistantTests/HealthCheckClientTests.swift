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
final class HealthCheckClientTests: XCTestCase {

    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    // MARK: - Helpers

    private func makeMockSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: config)
    }

    private func makeLocalAssistant(gatewayPort: Int? = nil) -> LockfileAssistant {
        LockfileAssistant(
            assistantId: "local-test",
            runtimeUrl: nil,
            bearerToken: nil,
            cloud: "local",
            project: nil,
            region: nil,
            zone: nil,
            instanceId: nil,
            hatchedAt: nil,
            baseDataDir: nil,

            gatewayPort: gatewayPort,
            instanceDir: nil
        )
    }

    // MARK: - URL construction tests

    func testLocalHealthCheckURLUsesGatewayPort() {
        let assistant = makeLocalAssistant(gatewayPort: 7831)
        let url = HealthCheckClient.localHealthCheckURL(for: assistant)
        XCTAssertEqual(url?.absoluteString, "http://127.0.0.1:7831/readyz")
    }

    func testLocalHealthCheckURLReturnsNilWhenGatewayPortMissing() {
        let assistant = makeLocalAssistant(gatewayPort: nil)
        let url = HealthCheckClient.localHealthCheckURL(for: assistant)
        XCTAssertNil(url)
    }

    func testLocalHealthCheckURLUsesCorrectPortPerAssistant() {
        let assistant1 = makeLocalAssistant(gatewayPort: 7831)
        let assistant2 = makeLocalAssistant(gatewayPort: 7832)

        let url1 = HealthCheckClient.localHealthCheckURL(for: assistant1)
        let url2 = HealthCheckClient.localHealthCheckURL(for: assistant2)

        XCTAssertEqual(url1?.absoluteString, "http://127.0.0.1:7831/readyz")
        XCTAssertEqual(url2?.absoluteString, "http://127.0.0.1:7832/readyz")
        XCTAssertNotEqual(url1, url2)
    }

    // MARK: - Route selection tests

    func testLocalAssistantHitsOwnGatewayReadyz() async {
        let assistant = makeLocalAssistant(gatewayPort: 7831)
        var capturedURL: URL?

        MockURLProtocol.requestHandler = { request in
            capturedURL = request.url
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data())
        }

        let result = await HealthCheckClient.isReachable(for: assistant, timeout: 1, session: makeMockSession())

        XCTAssertTrue(result)
        XCTAssertEqual(capturedURL?.absoluteString, "http://127.0.0.1:7831/readyz")
    }

    func testLocalAssistantReturnsFalseOn503() async {
        let assistant = makeLocalAssistant(gatewayPort: 7831)

        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 503,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data())
        }

        let result = await HealthCheckClient.isReachable(for: assistant, timeout: 1, session: makeMockSession())

        XCTAssertFalse(result)
    }

    func testLocalAssistantReturnsFalseWhenGatewayPortNil() async {
        let assistant = makeLocalAssistant(gatewayPort: nil)
        var handlerInvoked = false

        MockURLProtocol.requestHandler = { _ in
            handlerInvoked = true
            let response = HTTPURLResponse(
                url: URL(string: "http://127.0.0.1/readyz")!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data())
        }

        let result = await HealthCheckClient.isReachable(for: assistant, timeout: 1, session: makeMockSession())

        XCTAssertFalse(result)
        XCTAssertFalse(handlerInvoked, "No network request should be made when gatewayPort is nil")
    }

    func testLocalAssistantSendsNoAuthHeaders() async {
        let assistant = makeLocalAssistant(gatewayPort: 7831)
        var capturedRequest: URLRequest?

        MockURLProtocol.requestHandler = { request in
            capturedRequest = request
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data())
        }

        _ = await HealthCheckClient.isReachable(for: assistant, timeout: 1, session: makeMockSession())

        XCTAssertNotNil(capturedRequest)
        XCTAssertNil(capturedRequest?.value(forHTTPHeaderField: "Authorization"),
                     "/readyz is unauthenticated — no Authorization header should be sent")
    }

    // MARK: - Branching guard tests

    func testLocalAssistantRunsLocally() {
        let assistant = LockfileAssistant(
            assistantId: "test-id",
            runtimeUrl: nil,
            bearerToken: nil,
            cloud: "local",
            project: nil,
            region: nil,
            zone: nil,
            instanceId: nil,
            hatchedAt: nil,
            baseDataDir: nil,

            gatewayPort: nil,
            instanceDir: nil
        )
        XCTAssertTrue(assistant.runsLocally)
    }

    func testManagedAssistantDoesNotRunLocally() {
        let assistant = LockfileAssistant(
            assistantId: "test-id",
            runtimeUrl: "https://platform.vellum.ai",
            bearerToken: nil,
            cloud: "vellum",
            project: nil,
            region: nil,
            zone: nil,
            instanceId: nil,
            hatchedAt: nil,
            baseDataDir: nil,

            gatewayPort: nil,
            instanceDir: nil
        )
        XCTAssertFalse(assistant.runsLocally)
    }

    func testGcpAssistantDoesNotRunLocally() {
        let assistant = LockfileAssistant(
            assistantId: "test-id",
            runtimeUrl: nil,
            bearerToken: nil,
            cloud: "gcp",
            project: nil,
            region: nil,
            zone: nil,
            instanceId: nil,
            hatchedAt: nil,
            baseDataDir: nil,

            gatewayPort: nil,
            instanceDir: nil
        )
        XCTAssertFalse(assistant.runsLocally)
    }
}
