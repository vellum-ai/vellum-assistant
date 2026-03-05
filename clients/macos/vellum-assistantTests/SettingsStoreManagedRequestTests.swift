import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class SettingsStoreManagedRequestTests: XCTestCase {
    func testBuildManagedAssistantProxyRequestReturnsNilWithoutSessionToken() {
        let request = SettingsStore.buildManagedAssistantProxyRequest(
            baseURL: "https://platform.vellum.ai",
            assistantId: "ast_123",
            path: "v1/secrets",
            method: "DELETE",
            sessionToken: nil,
            organizationId: "org_456"
        )

        XCTAssertNil(request)
    }

    func testBuildManagedAssistantProxyRequestStripsV1PrefixAndSetsHeaders() {
        let request = SettingsStore.buildManagedAssistantProxyRequest(
            baseURL: "https://platform.vellum.ai",
            assistantId: "ast_123",
            path: "v1/secrets",
            method: "POST",
            sessionToken: "session-token",
            organizationId: "org_456"
        )

        XCTAssertEqual(
            request?.url?.absoluteString,
            "https://platform.vellum.ai/v1/assistants/ast_123/secrets/"
        )
        XCTAssertEqual(request?.httpMethod, "POST")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "X-Session-Token"), "session-token")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Vellum-Organization-Id"), "org_456")
    }
}
