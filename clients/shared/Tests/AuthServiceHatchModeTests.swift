import Foundation
import XCTest

@testable import VellumAssistantShared

private final class HatchModeURLProtocol: URLProtocol {
    static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let handler = Self.requestHandler else {
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

@MainActor
final class AuthServiceHatchModeTests: XCTestCase {
    private var previousToken: String?

    override func setUp() {
        super.setUp()
        HatchModeURLProtocol.requestHandler = nil
        URLProtocol.registerClass(HatchModeURLProtocol.self)
        previousToken = SessionTokenManager.getToken()
        SessionTokenManager.setToken("test-session-token")
    }

    override func tearDown() {
        URLProtocol.unregisterClass(HatchModeURLProtocol.self)
        HatchModeURLProtocol.requestHandler = nil
        if let previousToken {
            SessionTokenManager.setToken(previousToken)
        } else {
            SessionTokenManager.deleteToken()
        }
        previousToken = nil
        super.tearDown()
    }

    func testCreateModeAppendsModeCreateQuery() async throws {
        var sawRequest = false
        HatchModeURLProtocol.requestHandler = { request in
            sawRequest = true
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/assistants/hatch")
            XCTAssertEqual(queryValue("mode", in: request), "create")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Vellum-Organization-Id"), "org-123")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Session-Token"), "test-session-token")
            return makeResponse(
                for: request,
                statusCode: 201,
                body: """
                {
                  "id": "asst-created",
                  "name": "Example Assistant",
                  "created_at": "2026-05-01T12:00:00Z",
                  "status": "initializing"
                }
                """
            )
        }

        let result = try await AuthService.shared.hatchAssistant(
            organizationId: "org-123",
            name: "Example Assistant",
            mode: .create
        )

        guard case .createdNew(let assistant) = result else {
            XCTFail("Expected createdNew, got \(result)")
            return
        }
        XCTAssertTrue(sawRequest)
        XCTAssertEqual(assistant.id, "asst-created")
    }

    func testDefaultHatchModeOmitsModeQueryAndReusesExistingAssistant() async throws {
        var sawRequest = false
        HatchModeURLProtocol.requestHandler = { request in
            sawRequest = true
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/assistants/hatch")
            XCTAssertNil(request.url?.query)
            return makeResponse(
                for: request,
                statusCode: 200,
                body: """
                {
                  "id": "asst-existing",
                  "name": "Existing Assistant",
                  "created_at": "2026-05-01T12:00:00Z",
                  "status": "active"
                }
                """
            )
        }

        let result = try await AuthService.shared.hatchAssistant(organizationId: "org-123")

        guard case .reusedExisting(let assistant) = result else {
            XCTFail("Expected reusedExisting, got \(result)")
            return
        }
        XCTAssertTrue(sawRequest)
        XCTAssertEqual(assistant.id, "asst-existing")
    }
}

private func queryValue(_ name: String, in request: URLRequest) -> String? {
    guard let url = request.url,
          let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
        return nil
    }
    return components.queryItems?.first { $0.name == name }?.value
}

private func makeResponse(
    for request: URLRequest,
    statusCode: Int,
    body: String
) -> (HTTPURLResponse, Data) {
    let response = HTTPURLResponse(
        url: request.url!,
        statusCode: statusCode,
        httpVersion: nil,
        headerFields: ["Content-Type": "application/json"]
    )!
    return (response, Data(body.utf8))
}
