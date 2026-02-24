import XCTest
@testable import VellumAssistantShared

private final class TokenBox {
    var value: String?

    init(_ value: String? = nil) {
        self.value = value
    }
}

@MainActor
final class AuthFlowTests: XCTestCase {
    func testGetConfigOmitsSessionTokenHeader() async throws {
        let tokenBox = TokenBox("stale-token")
        var capturedRequest: URLRequest?

        let service = AuthService(
            baseURLOverride: "https://auth.test",
            requestExecutor: { request in
                capturedRequest = request
                return (
                    #"{"status":200,"data":{"socialaccount":{"providers":[]}}}"#.data(using: .utf8)!,
                    Self.makeHTTPResponse(for: request.url!, statusCode: 200)
                )
            },
            getSessionToken: { tokenBox.value },
            setSessionToken: { tokenBox.value = $0 },
            invalidateSessionToken: { tokenBox.value = nil }
        )

        _ = try await service.getConfig()

        XCTAssertEqual(capturedRequest?.url?.path, "/_allauth/app/v1/config")
        XCTAssertNil(capturedRequest?.value(forHTTPHeaderField: "X-Session-Token"))
    }

    func testGetSessionIncludesSessionTokenHeader() async throws {
        let tokenBox = TokenBox("session-123")
        var capturedRequest: URLRequest?

        let service = AuthService(
            baseURLOverride: "https://auth.test",
            requestExecutor: { request in
                capturedRequest = request
                return (
                    #"{"status":200,"data":{"user":{"id":1,"email":"test@example.com"}}}"#.data(using: .utf8)!,
                    Self.makeHTTPResponse(for: request.url!, statusCode: 200)
                )
            },
            getSessionToken: { tokenBox.value },
            setSessionToken: { tokenBox.value = $0 },
            invalidateSessionToken: { tokenBox.value = nil }
        )

        _ = try await service.getSession()

        XCTAssertEqual(capturedRequest?.url?.path, "/_allauth/app/v1/auth/session")
        XCTAssertEqual(capturedRequest?.value(forHTTPHeaderField: "X-Session-Token"), "session-123")
    }

    func testGetSession410ClearsTokenAndThrowsInvalidSession() async throws {
        let tokenBox = TokenBox("stale-token")

        let service = AuthService(
            baseURLOverride: "https://auth.test",
            requestExecutor: { request in
                (
                    #"{"status":410}"#.data(using: .utf8)!,
                    Self.makeHTTPResponse(for: request.url!, statusCode: 410)
                )
            },
            getSessionToken: { tokenBox.value },
            setSessionToken: { tokenBox.value = $0 },
            invalidateSessionToken: { tokenBox.value = nil }
        )

        do {
            _ = try await service.getSession()
            XCTFail("Expected invalidSessionToken error")
        } catch AuthServiceError.invalidSessionToken {
            XCTAssertNil(tokenBox.value)
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    func testAuthManagerCheckSessionSurfacesReauthPromptAfter410() async {
        let tokenBox = TokenBox("stale-token")

        let service = AuthService(
            baseURLOverride: "https://auth.test",
            requestExecutor: { request in
                (
                    #"{"status":410}"#.data(using: .utf8)!,
                    Self.makeHTTPResponse(for: request.url!, statusCode: 410)
                )
            },
            getSessionToken: { tokenBox.value },
            setSessionToken: { tokenBox.value = $0 },
            invalidateSessionToken: { tokenBox.value = nil }
        )

        let manager = AuthManager(authService: service)
        await manager.checkSession()

        Self.assertUnauthenticated(manager.state)
        XCTAssertEqual(manager.errorMessage, "Session expired. Please sign in again.")
        XCTAssertNil(tokenBox.value)
    }

    func testAuthManagerLogoutClearsTokenWhenRemoteLogoutFails() async {
        let tokenBox = TokenBox("live-token")

        let service = AuthService(
            baseURLOverride: "https://auth.test",
            requestExecutor: { _ in
                throw URLError(.notConnectedToInternet)
            },
            getSessionToken: { tokenBox.value },
            setSessionToken: { tokenBox.value = $0 },
            invalidateSessionToken: { tokenBox.value = nil }
        )

        let manager = AuthManager(authService: service)
        await manager.logout()

        Self.assertUnauthenticated(manager.state)
        XCTAssertNil(tokenBox.value)
        XCTAssertNil(manager.errorMessage)
    }

    private static func makeHTTPResponse(for url: URL, statusCode: Int) -> HTTPURLResponse {
        HTTPURLResponse(
            url: url,
            statusCode: statusCode,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
    }

    private static func assertUnauthenticated(
        _ state: AuthState,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        if case .unauthenticated = state {
            return
        }
        XCTFail("Expected .unauthenticated state", file: file, line: line)
    }
}
