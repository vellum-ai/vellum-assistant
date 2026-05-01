import Foundation
import XCTest

@testable import VellumAssistantShared

private final class SettingsClientCallSiteCatalogURLProtocol: URLProtocol {
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
final class SettingsClientCallSiteCatalogTests: XCTestCase {
    private let assistantId = "00000000-0000-4000-8000-000000000001"
    private var originalPrimaryLockfileData: Data?
    private var primaryLockfileExisted = false
    private var previousToken: String?

    override func setUpWithError() throws {
        try super.setUpWithError()
        SettingsClientCallSiteCatalogURLProtocol.requestHandler = nil
        URLProtocol.registerClass(SettingsClientCallSiteCatalogURLProtocol.self)

        let primaryLockfileURL = LockfilePaths.primary
        primaryLockfileExisted = FileManager.default.fileExists(atPath: primaryLockfileURL.path)
        if primaryLockfileExisted {
            originalPrimaryLockfileData = try Data(contentsOf: primaryLockfileURL)
        }

        try installManagedLockfileFixture()
        previousToken = SessionTokenManager.getToken()
        SessionTokenManager.setToken("stub-session-token")
    }

    override func tearDownWithError() throws {
        URLProtocol.unregisterClass(SettingsClientCallSiteCatalogURLProtocol.self)
        SettingsClientCallSiteCatalogURLProtocol.requestHandler = nil

        if let token = previousToken {
            SessionTokenManager.setToken(token)
        } else {
            SessionTokenManager.deleteToken()
        }
        previousToken = nil

        if primaryLockfileExisted {
            try originalPrimaryLockfileData?.write(to: LockfilePaths.primary, options: .atomic)
        } else {
            try? FileManager.default.removeItem(at: LockfilePaths.primary)
        }

        try super.tearDownWithError()
    }

    func testFetchCallSiteCatalogUsesAssistantScopedManagedPathAndDecodesResponse() async throws {
        let requestExpectation = expectation(description: "call-site catalog request")
        var capturedRequest: URLRequest?

        SettingsClientCallSiteCatalogURLProtocol.requestHandler = { request in
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
                  "domains": [
                    {
                      "id": "agentLoop",
                      "displayName": "Agent Loop"
                    }
                  ],
                  "callSites": [
                    {
                      "id": "mainAgent",
                      "displayName": "Main Agent",
                      "description": "The primary conversation agent.",
                      "domain": "agentLoop"
                    }
                  ]
                }
                """#.utf8
            )
            return (response, data)
        }

        let catalog = await SettingsClient().fetchCallSiteCatalog()

        await fulfillment(of: [requestExpectation], timeout: 1.0)

        XCTAssertEqual(
            capturedRequest?.url?.absoluteString,
            "https://platform.vellum.ai/v1/assistants/\(assistantId)/config/llm/call-sites/"
        )
        XCTAssertEqual(capturedRequest?.httpMethod, "GET")
        XCTAssertEqual(catalog?.domains.count, 1)
        XCTAssertEqual(catalog?.domains.first?.id, "agentLoop")
        XCTAssertEqual(catalog?.domains.first?.displayName, "Agent Loop")
        XCTAssertEqual(catalog?.callSites.count, 1)
        XCTAssertEqual(catalog?.callSites.first?.id, "mainAgent")
        XCTAssertEqual(catalog?.callSites.first?.displayName, "Main Agent")
        XCTAssertEqual(catalog?.callSites.first?.domain, "agentLoop")
    }

    private func installManagedLockfileFixture() throws {
        let lockfile: [String: Any] = [
            "activeAssistant": assistantId,
            "assistants": [
                [
                    "assistantId": assistantId,
                    "name": "Example Assistant",
                    "cloud": "vellum",
                    "runtimeUrl": "https://platform.vellum.ai",
                    "hatchedAt": "2026-01-01T00:00:00Z",
                ],
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: lockfile, options: [.sortedKeys])
        let primaryLockfileURL = LockfilePaths.primary
        try FileManager.default.createDirectory(
            at: primaryLockfileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: primaryLockfileURL, options: .atomic)
    }
}
