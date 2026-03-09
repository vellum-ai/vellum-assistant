import XCTest
@testable import VellumAssistantShared

/// Mock URLSession that returns pre-configured responses for testing.
private final class MockURLSession: URLSessionProtocol, @unchecked Sendable {
    var responseData: Data = Data()
    var responseStatusCode: Int = 200
    var responseError: Error?
    var capturedRequests: [URLRequest] = []

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        capturedRequests.append(request)

        if let error = responseError {
            throw error
        }

        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: responseStatusCode,
            httpVersion: "HTTP/1.1",
            headerFields: nil
        )!

        return (responseData, response)
    }
}

final class PlatformTwitterOAuthServiceTests: XCTestCase {

    private var mockSession: MockURLSession!
    private var service: PlatformTwitterOAuthService!

    private let testBaseURL = "https://platform.example.com"
    private let testPlatformAssistantId = "asst-uuid-1234"
    private let testOrganizationId = "org-uuid-5678"
    private let testSessionToken = "test-session-token"

    override func setUp() {
        super.setUp()
        mockSession = MockURLSession()
        service = PlatformTwitterOAuthService(
            baseURL: testBaseURL,
            session: mockSession,
            sessionTokenProvider: { [testSessionToken] in testSessionToken }
        )
    }

    // MARK: - listConnections

    func testListConnectionsSendsCorrectRequest() async throws {
        let connections = [
            TwitterOAuthConnection(id: "conn-1", provider: "twitter", accountInfo: "@testuser")
        ]
        let responseBody = ListTwitterOAuthConnectionsResponse(connections: connections)
        mockSession.responseData = try JSONEncoder().encode(responseBody)

        _ = try await service.listConnections(
            platformAssistantId: testPlatformAssistantId,
            organizationId: testOrganizationId
        )

        XCTAssertEqual(mockSession.capturedRequests.count, 1)
        let request = mockSession.capturedRequests[0]

        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(
            request.url?.absoluteString,
            "\(testBaseURL)/v1/assistants/\(testPlatformAssistantId)/twitter/connections/"
        )
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Session-Token"), testSessionToken)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Vellum-Organization-Id"), testOrganizationId)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
    }

    func testListConnectionsDecodesResponse() async throws {
        let connections = [
            TwitterOAuthConnection(id: "conn-1", provider: "twitter", accountInfo: "@user1"),
            TwitterOAuthConnection(id: "conn-2", provider: "twitter", accountInfo: "@user2"),
        ]
        let responseBody = ListTwitterOAuthConnectionsResponse(connections: connections)
        mockSession.responseData = try JSONEncoder().encode(responseBody)

        let result = try await service.listConnections(
            platformAssistantId: testPlatformAssistantId,
            organizationId: testOrganizationId
        )

        XCTAssertEqual(result.connections.count, 2)
        XCTAssertEqual(result.connections[0].id, "conn-1")
        XCTAssertEqual(result.connections[0].accountInfo, "@user1")
        XCTAssertEqual(result.connections[1].id, "conn-2")
    }

    func testListConnectionsReturnsEmptyList() async throws {
        let responseBody = ListTwitterOAuthConnectionsResponse(connections: [])
        mockSession.responseData = try JSONEncoder().encode(responseBody)

        let result = try await service.listConnections(
            platformAssistantId: testPlatformAssistantId,
            organizationId: testOrganizationId
        )

        XCTAssertTrue(result.connections.isEmpty)
    }

    func testListConnectionsThrowsOnAuthError() async throws {
        mockSession.responseStatusCode = 401

        do {
            _ = try await service.listConnections(
                platformAssistantId: testPlatformAssistantId,
                organizationId: testOrganizationId
            )
            XCTFail("Expected authenticationRequired error")
        } catch let error as PlatformAPIError {
            if case .authenticationRequired = error {
                // Expected
            } else {
                XCTFail("Expected authenticationRequired, got \(error)")
            }
        }
    }

    func testListConnectionsThrowsOnServerError() async throws {
        mockSession.responseStatusCode = 500
        mockSession.responseData = Data("Internal Server Error".utf8)

        do {
            _ = try await service.listConnections(
                platformAssistantId: testPlatformAssistantId,
                organizationId: testOrganizationId
            )
            XCTFail("Expected serverError")
        } catch let error as PlatformAPIError {
            if case .serverError(let statusCode, _) = error {
                XCTAssertEqual(statusCode, 500)
            } else {
                XCTFail("Expected serverError, got \(error)")
            }
        }
    }

    // MARK: - startTwitterConnect

    func testStartConnectSendsCorrectRequest() async throws {
        let responseBody = StartTwitterConnectResponse(authorizationUrl: "https://twitter.com/oauth/authorize?token=abc")
        mockSession.responseData = try JSONEncoder().encode(responseBody)

        _ = try await service.startTwitterConnect(
            platformAssistantId: testPlatformAssistantId,
            organizationId: testOrganizationId
        )

        XCTAssertEqual(mockSession.capturedRequests.count, 1)
        let request = mockSession.capturedRequests[0]

        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(
            request.url?.absoluteString,
            "\(testBaseURL)/v1/assistants/\(testPlatformAssistantId)/twitter/connect/"
        )
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Session-Token"), testSessionToken)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Vellum-Organization-Id"), testOrganizationId)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
    }

    func testStartConnectSendsRequestedScopes() async throws {
        let responseBody = StartTwitterConnectResponse(authorizationUrl: "https://twitter.com/oauth/authorize")
        mockSession.responseData = try JSONEncoder().encode(responseBody)

        _ = try await service.startTwitterConnect(
            platformAssistantId: testPlatformAssistantId,
            organizationId: testOrganizationId
        )

        let request = mockSession.capturedRequests[0]
        let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]

        let scopes = body["requested_scopes"] as? [String]
        XCTAssertEqual(scopes, ["tweet.read", "tweet.write", "users.read", "offline.access"])
    }

    func testStartConnectSendsRedirectAfterConnect() async throws {
        let responseBody = StartTwitterConnectResponse(authorizationUrl: "https://twitter.com/oauth/authorize")
        mockSession.responseData = try JSONEncoder().encode(responseBody)

        _ = try await service.startTwitterConnect(
            platformAssistantId: testPlatformAssistantId,
            organizationId: testOrganizationId
        )

        let request = mockSession.capturedRequests[0]
        let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]

        let redirect = body["redirect_after_connect"] as? String
        XCTAssertEqual(redirect, "vellum://oauth/twitter/complete")
    }

    func testStartConnectDecodesAuthorizationUrl() async throws {
        let expectedUrl = "https://twitter.com/i/oauth2/authorize?client_id=abc&scope=tweet.read"
        let responseBody = StartTwitterConnectResponse(authorizationUrl: expectedUrl)
        mockSession.responseData = try JSONEncoder().encode(responseBody)

        let result = try await service.startTwitterConnect(
            platformAssistantId: testPlatformAssistantId,
            organizationId: testOrganizationId
        )

        XCTAssertEqual(result.authorizationUrl, expectedUrl)
    }

    func testStartConnectThrowsOn403() async throws {
        mockSession.responseStatusCode = 403

        do {
            _ = try await service.startTwitterConnect(
                platformAssistantId: testPlatformAssistantId,
                organizationId: testOrganizationId
            )
            XCTFail("Expected authenticationRequired error")
        } catch let error as PlatformAPIError {
            if case .authenticationRequired = error {
                // Expected
            } else {
                XCTFail("Expected authenticationRequired, got \(error)")
            }
        }
    }

    // MARK: - disconnectTwitter

    func testDisconnectSendsCorrectRequest() async throws {
        let responseBody = DisconnectTwitterResponse(success: true)
        mockSession.responseData = try JSONEncoder().encode(responseBody)

        _ = try await service.disconnectTwitter(
            platformAssistantId: testPlatformAssistantId,
            organizationId: testOrganizationId
        )

        XCTAssertEqual(mockSession.capturedRequests.count, 1)
        let request = mockSession.capturedRequests[0]

        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(
            request.url?.absoluteString,
            "\(testBaseURL)/v1/assistants/\(testPlatformAssistantId)/twitter/disconnect/"
        )
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Session-Token"), testSessionToken)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Vellum-Organization-Id"), testOrganizationId)
    }

    func testDisconnectDecodesSuccessResponse() async throws {
        let responseBody = DisconnectTwitterResponse(success: true)
        mockSession.responseData = try JSONEncoder().encode(responseBody)

        let result = try await service.disconnectTwitter(
            platformAssistantId: testPlatformAssistantId,
            organizationId: testOrganizationId
        )

        XCTAssertTrue(result.success)
    }

    func testDisconnectThrowsOnServerError() async throws {
        mockSession.responseStatusCode = 502
        mockSession.responseData = Data("Bad Gateway".utf8)

        do {
            _ = try await service.disconnectTwitter(
                platformAssistantId: testPlatformAssistantId,
                organizationId: testOrganizationId
            )
            XCTFail("Expected serverError")
        } catch let error as PlatformAPIError {
            if case .serverError(let statusCode, _) = error {
                XCTAssertEqual(statusCode, 502)
            } else {
                XCTFail("Expected serverError, got \(error)")
            }
        }
    }

    // MARK: - Authentication

    func testThrowsWhenNoSessionToken() async throws {
        let unauthService = PlatformTwitterOAuthService(
            baseURL: testBaseURL,
            session: mockSession,
            sessionTokenProvider: { nil }
        )

        do {
            _ = try await unauthService.listConnections(
                platformAssistantId: testPlatformAssistantId,
                organizationId: testOrganizationId
            )
            XCTFail("Expected authenticationRequired error")
        } catch let error as PlatformAPIError {
            if case .authenticationRequired = error {
                // Expected — no request should have been sent
                XCTAssertTrue(mockSession.capturedRequests.isEmpty)
            } else {
                XCTFail("Expected authenticationRequired, got \(error)")
            }
        }
    }

    // MARK: - Network errors

    func testNetworkErrorWrappedAsPlatformAPIError() async throws {
        let networkError = URLError(.notConnectedToInternet)
        mockSession.responseError = networkError

        do {
            _ = try await service.listConnections(
                platformAssistantId: testPlatformAssistantId,
                organizationId: testOrganizationId
            )
            XCTFail("Expected networkError")
        } catch let error as PlatformAPIError {
            if case .networkError = error {
                // Expected
            } else {
                XCTFail("Expected networkError, got \(error)")
            }
        }
    }

    // MARK: - Static properties

    func testRequestedScopesContainsExpectedValues() {
        let scopes = PlatformTwitterOAuthService.requestedScopes
        XCTAssertEqual(scopes, ["tweet.read", "tweet.write", "users.read", "offline.access"])
    }

    func testRedirectAfterConnectIsDesktopScheme() {
        let redirect = PlatformTwitterOAuthService.redirectAfterConnect
        XCTAssertTrue(redirect.hasPrefix("vellum://"))
    }
}
