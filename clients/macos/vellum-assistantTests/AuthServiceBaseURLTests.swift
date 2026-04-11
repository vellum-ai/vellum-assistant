import XCTest
@testable import VellumAssistantShared

@MainActor
final class AuthServiceBaseURLTests: XCTestCase {
    /// VELLUM_ENVIRONMENT=local resolves to localhost.
    func testResolvePlatformURLUsesLocalhostForLocalEnvironment() {
        let resolved = VellumEnvironment.resolve(from: ["VELLUM_ENVIRONMENT": "local"]).platformURL
        XCTAssertEqual(resolved, "http://localhost:8000")
    }

    /// With no VELLUM_ENVIRONMENT set, defaults to production.
    func testResolvePlatformURLDefaultsToProductionWhenNoEnvironmentSet() {
        let resolved = VellumEnvironment.resolve(from: [:]).platformURL
        XCTAssertEqual(resolved, "https://platform.vellum.ai")
    }

    /// VELLUM_ENVIRONMENT=dev resolves to the dev platform.
    func testResolvePlatformURLUsesDevPlatformForDevEnvironment() {
        let resolved = VellumEnvironment.resolve(from: ["VELLUM_ENVIRONMENT": "dev"]).platformURL
        XCTAssertEqual(resolved, "https://dev-platform.vellum.ai")
    }

    /// VELLUM_ENVIRONMENT=staging resolves to the staging platform.
    func testResolvePlatformURLUsesStagingPlatformForStagingEnvironment() {
        let resolved = VellumEnvironment.resolve(from: ["VELLUM_ENVIRONMENT": "staging"]).platformURL
        XCTAssertEqual(resolved, "https://staging-platform.vellum.ai")
    }

    /// VELLUM_ENVIRONMENT=test resolves to the test platform.
    func testResolvePlatformURLUsesTestPlatformForTestEnvironment() {
        let resolved = VellumEnvironment.resolve(from: ["VELLUM_ENVIRONMENT": "test"]).platformURL
        XCTAssertEqual(resolved, "https://test-platform.vellum.ai")
    }
}
