import XCTest
@testable import VellumAssistantShared

@MainActor
final class AuthServiceBaseURLTests: XCTestCase {
    /// VELLUM_PLATFORM_URL takes highest priority, overriding VELLUM_ENVIRONMENT.
    func testResolvePlatformURLPrefersVellumPlatformURLOverride() {
        // GIVEN both VELLUM_PLATFORM_URL and VELLUM_ENVIRONMENT are set
        let environment = [
            "VELLUM_PLATFORM_URL": "https://env.example.com/",
            "VELLUM_ENVIRONMENT": "local",
        ]

        // WHEN resolving the platform URL
        let resolved = VellumEnvironment.resolvePlatformURL(from: environment)

        // THEN the explicit VELLUM_PLATFORM_URL wins (trailing slash stripped)
        XCTAssertEqual(resolved, "https://env.example.com")
    }

    /// With no VELLUM_ENVIRONMENT set, defaults to production.
    func testResolvePlatformURLDefaultsToProductionWhenNoEnvironmentSet() {
        // GIVEN an empty environment dictionary
        // WHEN resolving the platform URL
        let resolved = VellumEnvironment.resolvePlatformURL(from: [:])

        // THEN falls back to the production platform URL
        XCTAssertEqual(resolved, "https://platform.vellum.ai")
    }

    /// VELLUM_ENVIRONMENT=local resolves to localhost.
    func testResolvePlatformURLUsesLocalhostForLocalEnvironment() {
        // GIVEN VELLUM_ENVIRONMENT is set to "local"
        // WHEN resolving the platform URL
        let resolved = VellumEnvironment.resolvePlatformURL(from: ["VELLUM_ENVIRONMENT": "local"])

        // THEN targets localhost
        XCTAssertEqual(resolved, "http://localhost:8000")
    }

    /// VELLUM_ENVIRONMENT=dev resolves to the dev platform.
    func testResolvePlatformURLUsesDevPlatformForDevEnvironment() {
        // GIVEN VELLUM_ENVIRONMENT is set to "dev"
        // WHEN resolving the platform URL
        let resolved = VellumEnvironment.resolvePlatformURL(from: ["VELLUM_ENVIRONMENT": "dev"])

        // THEN targets the dev platform
        XCTAssertEqual(resolved, "https://dev-platform.vellum.ai")
    }

    /// VELLUM_ENVIRONMENT=staging resolves to the staging platform.
    func testResolvePlatformURLUsesStagingPlatformForStagingEnvironment() {
        // GIVEN VELLUM_ENVIRONMENT is set to "staging"
        // WHEN resolving the platform URL
        let resolved = VellumEnvironment.resolvePlatformURL(from: ["VELLUM_ENVIRONMENT": "staging"])

        // THEN targets the staging platform
        XCTAssertEqual(resolved, "https://staging-platform.vellum.ai")
    }

    /// VELLUM_ENVIRONMENT=test resolves to the test platform.
    func testResolvePlatformURLUsesTestPlatformForTestEnvironment() {
        // GIVEN VELLUM_ENVIRONMENT is set to "test"
        // WHEN resolving the platform URL
        let resolved = VellumEnvironment.resolvePlatformURL(from: ["VELLUM_ENVIRONMENT": "test"])

        // THEN targets the test platform
        XCTAssertEqual(resolved, "https://test-platform.vellum.ai")
    }
}
