import XCTest

@testable import VellumAssistantShared

// MARK: - URLProtocol stub for recovery-mode network calls

private final class RecoveryModeURLProtocol: URLProtocol {
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

// MARK: - Tests

@MainActor
final class PlatformAssistantRecoveryDecodingTests: XCTestCase {
    private let decoder = JSONDecoder()
    private var previousToken: String?

    override func setUp() {
        super.setUp()
        RecoveryModeURLProtocol.requestHandler = nil
        URLProtocol.registerClass(RecoveryModeURLProtocol.self)
        // Save any existing token so we can restore it in tearDown, preventing
        // a test-abort from leaving a bogus token in the real credential store.
        previousToken = SessionTokenManager.getToken()
        // Provide a token so network-path tests reach the stub handler rather than
        // short-circuiting with authenticationRequired before any request is made.
        SessionTokenManager.setToken("test-session-token")
    }

    override func tearDown() {
        URLProtocol.unregisterClass(RecoveryModeURLProtocol.self)
        RecoveryModeURLProtocol.requestHandler = nil
        // Restore the credential store to its pre-test state.
        if let token = previousToken {
            SessionTokenManager.setToken(token)
        } else {
            SessionTokenManager.deleteToken()
        }
        previousToken = nil
        super.tearDown()
    }

    // MARK: - PlatformAssistant decoding with recovery_mode (maintenance_mode JSON key)

    func testDecodesAssistantWithRecoveryModeEnabled() throws {
        let data = Data(
            """
            {
              "id": "asst-123",
              "name": "My Assistant",
              "status": "running",
              "maintenance_mode": {
                "enabled": true,
                "entered_at": "2026-03-30T12:00:00Z",
                "debug_pod_name": "debug-asst-123-abc"
              }
            }
            """.utf8
        )

        let assistant = try decoder.decode(PlatformAssistant.self, from: data)
        let maintenance = try XCTUnwrap(assistant.recovery_mode)

        XCTAssertEqual(assistant.id, "asst-123")
        XCTAssertTrue(maintenance.enabled)
        XCTAssertEqual(maintenance.entered_at, "2026-03-30T12:00:00Z")
        XCTAssertEqual(maintenance.debug_pod_name, "debug-asst-123-abc")
    }

    func testDecodesAssistantWithRecoveryModeDisabled() throws {
        let data = Data(
            """
            {
              "id": "asst-456",
              "name": "Another Assistant",
              "status": "running",
              "maintenance_mode": {
                "enabled": false,
                "entered_at": null,
                "debug_pod_name": null
              }
            }
            """.utf8
        )

        let assistant = try decoder.decode(PlatformAssistant.self, from: data)
        let maintenance = try XCTUnwrap(assistant.recovery_mode)

        XCTAssertFalse(maintenance.enabled)
        XCTAssertNil(maintenance.entered_at)
        XCTAssertNil(maintenance.debug_pod_name)
    }

    func testDecodesAssistantWithRecoveryModeAbsent() throws {
        let data = Data(
            """
            {
              "id": "asst-789",
              "name": "Legacy Assistant",
              "status": "running"
            }
            """.utf8
        )

        let assistant = try decoder.decode(PlatformAssistant.self, from: data)

        XCTAssertEqual(assistant.id, "asst-789")
        XCTAssertNil(assistant.recovery_mode)
    }

    func testDecodesAssistantPreservesExistingFieldsWithRecoveryMode() throws {
        let data = Data(
            """
            {
              "id": "asst-full",
              "name": "Full Assistant",
              "description": "A complete assistant payload",
              "created_at": "2025-01-15T09:00:00Z",
              "status": "provisioned",
              "maintenance_mode": {
                "enabled": true,
                "entered_at": "2026-03-30T08:30:00Z",
                "debug_pod_name": "debug-asst-full-xyz"
              }
            }
            """.utf8
        )

        let assistant = try decoder.decode(PlatformAssistant.self, from: data)

        XCTAssertEqual(assistant.id, "asst-full")
        XCTAssertEqual(assistant.name, "Full Assistant")
        XCTAssertEqual(assistant.description, "A complete assistant payload")
        XCTAssertEqual(assistant.created_at, "2025-01-15T09:00:00Z")
        XCTAssertEqual(assistant.status, "provisioned")
        let maintenance = try XCTUnwrap(assistant.recovery_mode)
        XCTAssertTrue(maintenance.enabled)
        XCTAssertEqual(maintenance.debug_pod_name, "debug-asst-full-xyz")
    }

    // MARK: - PlatformAssistantRecoveryMode standalone decoding

    func testDecodeRecoveryModeWithOnlyRequiredField() throws {
        let data = Data(
            """
            {
              "enabled": false
            }
            """.utf8
        )

        let mode = try decoder.decode(PlatformAssistantRecoveryMode.self, from: data)
        XCTAssertFalse(mode.enabled)
        XCTAssertNil(mode.entered_at)
        XCTAssertNil(mode.debug_pod_name)
    }

    // MARK: - AuthService error mapping for enter/exit routes

    func testEnterRecoveryModeNon2xxMapsToServerError() async {
        RecoveryModeURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 409,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data("{\"detail\": \"Already in recovery mode\"}".utf8))
        }

        do {
            _ = try await AuthService.shared.enterRecoveryMode(
                assistantId: "asst-123",
                organizationId: "org-1"
            )
            XCTFail("Expected serverError to be thrown")
        } catch let error as PlatformAPIError {
            if case .serverError(let statusCode, _) = error {
                XCTAssertEqual(statusCode, 409)
            } else {
                XCTFail("Expected .serverError, got \(error)")
            }
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func testExitRecoveryModeNon2xxMapsToServerError() async {
        RecoveryModeURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 409,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data("{\"detail\": \"Not in recovery mode\"}".utf8))
        }

        do {
            _ = try await AuthService.shared.exitRecoveryMode(
                assistantId: "asst-123",
                organizationId: "org-1"
            )
            XCTFail("Expected serverError to be thrown")
        } catch let error as PlatformAPIError {
            if case .serverError(let statusCode, _) = error {
                XCTAssertEqual(statusCode, 409)
            } else {
                XCTFail("Expected .serverError, got \(error)")
            }
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func testEnterRecoveryModeUnauthenticatedMapsToAuthRequired() async {
        RecoveryModeURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 401,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data("{\"detail\": \"Not authenticated\"}".utf8))
        }

        do {
            _ = try await AuthService.shared.enterRecoveryMode(
                assistantId: "asst-123",
                organizationId: "org-1"
            )
            XCTFail("Expected authenticationRequired to be thrown")
        } catch let error as PlatformAPIError {
            if case .authenticationRequired = error {
                // expected
            } else {
                XCTFail("Expected .authenticationRequired, got \(error)")
            }
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func testExitRecoveryModeForbiddenMapsToAuthRequired() async {
        RecoveryModeURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 403,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data("{\"detail\": \"Forbidden\"}".utf8))
        }

        do {
            _ = try await AuthService.shared.exitRecoveryMode(
                assistantId: "asst-789",
                organizationId: "org-2"
            )
            XCTFail("Expected authenticationRequired to be thrown")
        } catch let error as PlatformAPIError {
            if case .authenticationRequired = error {
                // expected
            } else {
                XCTFail("Expected .authenticationRequired, got \(error)")
            }
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }
}
