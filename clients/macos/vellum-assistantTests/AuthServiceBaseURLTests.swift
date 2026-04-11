import XCTest
@testable import VellumAssistantShared

@MainActor
final class AuthServiceBaseURLTests: XCTestCase {
    /// VELLUM_PLATFORM_URL takes highest priority, overriding both UserDefaults and VELLUM_ENVIRONMENT.
    func testResolveBaseURLPrefersVellumPlatformURLOverride() {
        withUserDefaultsSuite { defaults in
            // GIVEN a UserDefaults override and a VELLUM_PLATFORM_URL env var are both set
            defaults.set("https://defaults.example.com/", forKey: "authServiceBaseURL")
            let environment = [
                "VELLUM_PLATFORM_URL": "https://env.example.com/",
                "VELLUM_ENVIRONMENT": "local",
            ]

            // WHEN resolving the base URL
            let resolved = AuthService.resolveBaseURL(
                environment: environment,
                userDefaults: defaults
            )

            // THEN the explicit VELLUM_PLATFORM_URL wins (trailing slash stripped)
            XCTAssertEqual(resolved, "https://env.example.com")
        }
    }

    /// With no VELLUM_ENVIRONMENT set, defaults to production.
    func testResolveBaseURLDefaultsToProductionWhenNoEnvironmentSet() {
        withUserDefaultsSuite { defaults in
            // GIVEN an empty environment dictionary
            // WHEN resolving the base URL
            let resolved = AuthService.resolveBaseURL(
                environment: [:],
                userDefaults: defaults
            )

            // THEN falls back to the production platform URL
            XCTAssertEqual(resolved, "https://platform.vellum.ai")
        }
    }

    /// VELLUM_ENVIRONMENT=local resolves to localhost for auth flows.
    func testResolveBaseURLUsesLocalhostForLocalEnvironment() {
        withUserDefaultsSuite { defaults in
            // GIVEN VELLUM_ENVIRONMENT is set to "local"
            // WHEN resolving the base URL
            let resolved = AuthService.resolveBaseURL(
                environment: ["VELLUM_ENVIRONMENT": "local"],
                userDefaults: defaults
            )

            // THEN auth targets localhost
            XCTAssertEqual(resolved, "http://localhost:8000")
        }
    }

    /// VELLUM_ENVIRONMENT=dev resolves to the dev platform.
    func testResolveBaseURLUsesDevPlatformForDevEnvironment() {
        withUserDefaultsSuite { defaults in
            // GIVEN VELLUM_ENVIRONMENT is set to "dev"
            // WHEN resolving the base URL
            let resolved = AuthService.resolveBaseURL(
                environment: ["VELLUM_ENVIRONMENT": "dev"],
                userDefaults: defaults
            )

            // THEN auth targets the dev platform
            XCTAssertEqual(resolved, "https://dev-platform.vellum.ai")
        }
    }

    /// VELLUM_ENVIRONMENT=staging resolves to the staging platform.
    func testResolveBaseURLUsesStagingPlatformForStagingEnvironment() {
        withUserDefaultsSuite { defaults in
            // GIVEN VELLUM_ENVIRONMENT is set to "staging"
            // WHEN resolving the base URL
            let resolved = AuthService.resolveBaseURL(
                environment: ["VELLUM_ENVIRONMENT": "staging"],
                userDefaults: defaults
            )

            // THEN auth targets the staging platform
            XCTAssertEqual(resolved, "https://staging-platform.vellum.ai")
        }
    }

    /// VELLUM_ENVIRONMENT=test resolves to the test platform.
    func testResolveBaseURLUsesTestPlatformForTestEnvironment() {
        withUserDefaultsSuite { defaults in
            // GIVEN VELLUM_ENVIRONMENT is set to "test"
            // WHEN resolving the base URL
            let resolved = AuthService.resolveBaseURL(
                environment: ["VELLUM_ENVIRONMENT": "test"],
                userDefaults: defaults
            )

            // THEN auth targets the test platform
            XCTAssertEqual(resolved, "https://test-platform.vellum.ai")
        }
    }

    private func withUserDefaultsSuite(_ body: (UserDefaults) -> Void) {
        let suiteName = "AuthServiceBaseURLTests.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            XCTFail("Failed to create isolated UserDefaults suite")
            return
        }

        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }
        body(defaults)
    }
}
