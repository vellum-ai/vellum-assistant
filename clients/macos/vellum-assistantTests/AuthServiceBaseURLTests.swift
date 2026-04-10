import XCTest
@testable import VellumAssistantShared

@MainActor
final class AuthServiceBaseURLTests: XCTestCase {
    func testResolveBaseURLPrefersVellumPlatformURLOverride() {
        withUserDefaultsSuite { defaults in
            defaults.set("https://defaults.example.com/", forKey: "authServiceBaseURL")

            let resolved = AuthService.resolveBaseURL(
                environment: [
                    "VELLUM_PLATFORM_URL": "https://env.example.com/",
                    "VELLUM_ENVIRONMENT": "local",
                ],
                userDefaults: defaults
            )

            XCTAssertEqual(resolved, "https://env.example.com")
        }
    }

    func testResolveBaseURLDefaultsToProductionWhenNoEnvironmentSet() {
        withUserDefaultsSuite { defaults in
            let resolved = AuthService.resolveBaseURL(
                environment: [:],
                userDefaults: defaults
            )

            XCTAssertEqual(resolved, "https://platform.vellum.ai")
        }
    }

    func testResolveBaseURLUsesLocalhostForLocalEnvironment() {
        withUserDefaultsSuite { defaults in
            let resolved = AuthService.resolveBaseURL(
                environment: ["VELLUM_ENVIRONMENT": "local"],
                userDefaults: defaults
            )

            XCTAssertEqual(resolved, "http://localhost:8000")
        }
    }

    func testResolveBaseURLUsesDevPlatformForDevEnvironment() {
        withUserDefaultsSuite { defaults in
            let resolved = AuthService.resolveBaseURL(
                environment: ["VELLUM_ENVIRONMENT": "dev"],
                userDefaults: defaults
            )

            XCTAssertEqual(resolved, "https://dev-platform.vellum.ai")
        }
    }

    func testResolveBaseURLUsesStagingPlatformForStagingEnvironment() {
        withUserDefaultsSuite { defaults in
            let resolved = AuthService.resolveBaseURL(
                environment: ["VELLUM_ENVIRONMENT": "staging"],
                userDefaults: defaults
            )

            XCTAssertEqual(resolved, "https://staging-platform.vellum.ai")
        }
    }

    func testResolveBaseURLUsesTestPlatformForTestEnvironment() {
        withUserDefaultsSuite { defaults in
            let resolved = AuthService.resolveBaseURL(
                environment: ["VELLUM_ENVIRONMENT": "test"],
                userDefaults: defaults
            )

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
