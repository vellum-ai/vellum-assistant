import XCTest

@testable import VellumAssistantShared

// MARK: - URLProtocol stub for maintenance-mode network calls

private final class MaintenanceModeURLProtocol: URLProtocol {
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
final class PlatformAssistantMaintenanceDecodingTests: XCTestCase {
    private let decoder = JSONDecoder()

    override func setUp() {
        super.setUp()
        MaintenanceModeURLProtocol.requestHandler = nil
        URLProtocol.registerClass(MaintenanceModeURLProtocol.self)
        // Provide a token so network-path tests reach the stub handler rather than
        // short-circuiting with authenticationRequired before any request is made.
        SessionTokenManager.setToken("test-session-token")
    }

    override func tearDown() {
        URLProtocol.unregisterClass(MaintenanceModeURLProtocol.self)
        MaintenanceModeURLProtocol.requestHandler = nil
        SessionTokenManager.deleteToken()
        super.tearDown()
    }

    // MARK: - PlatformAssistant decoding with maintenance_mode present

    func testDecodesAssistantWithMaintenanceModeEnabled() throws {
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
        let maintenance = try XCTUnwrap(assistant.maintenance_mode)

        XCTAssertEqual(assistant.id, "asst-123")
        XCTAssertTrue(maintenance.enabled)
        XCTAssertEqual(maintenance.entered_at, "2026-03-30T12:00:00Z")
        XCTAssertEqual(maintenance.debug_pod_name, "debug-asst-123-abc")
    }

    func testDecodesAssistantWithMaintenanceModeDisabled() throws {
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
        let maintenance = try XCTUnwrap(assistant.maintenance_mode)

        XCTAssertFalse(maintenance.enabled)
        XCTAssertNil(maintenance.entered_at)
        XCTAssertNil(maintenance.debug_pod_name)
    }

    func testDecodesAssistantWithMaintenanceModeAbsent() throws {
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
        XCTAssertNil(assistant.maintenance_mode)
    }

    func testDecodesAssistantPreservesExistingFieldsWithMaintenanceMode() throws {
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
        let maintenance = try XCTUnwrap(assistant.maintenance_mode)
        XCTAssertTrue(maintenance.enabled)
        XCTAssertEqual(maintenance.debug_pod_name, "debug-asst-full-xyz")
    }

    // MARK: - PlatformAssistantMaintenanceMode standalone decoding

    func testDecodeMaintenanceModeWithOnlyRequiredField() throws {
        let data = Data(
            """
            {
              "enabled": false
            }
            """.utf8
        )

        let mode = try decoder.decode(PlatformAssistantMaintenanceMode.self, from: data)
        XCTAssertFalse(mode.enabled)
        XCTAssertNil(mode.entered_at)
        XCTAssertNil(mode.debug_pod_name)
    }

    // MARK: - AuthService error mapping for enter/exit routes

    func testEnterMaintenanceModeNon2xxMapsToServerError() async {
        MaintenanceModeURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 409,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data("{\"detail\": \"Already in maintenance mode\"}".utf8))
        }

        do {
            _ = try await AuthService.shared.enterMaintenanceMode(
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

    func testExitMaintenanceModeNon2xxMapsToServerError() async {
        MaintenanceModeURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 409,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data("{\"detail\": \"Not in maintenance mode\"}".utf8))
        }

        do {
            _ = try await AuthService.shared.exitMaintenanceMode(
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

    func testEnterMaintenanceModeUnauthenticatedMapsToAuthRequired() async {
        MaintenanceModeURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 401,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data("{\"detail\": \"Not authenticated\"}".utf8))
        }

        do {
            _ = try await AuthService.shared.enterMaintenanceMode(
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

    func testExitMaintenanceModeForbiddenMapsToAuthRequired() async {
        MaintenanceModeURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 403,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data("{\"detail\": \"Forbidden\"}".utf8))
        }

        do {
            _ = try await AuthService.shared.exitMaintenanceMode(
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
