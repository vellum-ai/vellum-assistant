import XCTest
@testable import VellumAssistantShared

@MainActor
final class AuthServiceBaseURLTests: XCTestCase {
    func testResolveBaseURLPrefersEnvironmentOverride() {
        withUserDefaultsSuite { defaults in
            defaults.set("https://defaults.example.com/", forKey: "authServiceBaseURL")

            let resolved = AuthService.resolveBaseURL(
                configuredBaseURL: "https://configured.example.com/",
                environment: ["VELLUM_PLATFORM_URL": "https://env.example.com/"],
                userDefaults: defaults
            )

            XCTAssertEqual(resolved, "https://env.example.com")
        }
    }

    func testResolveBaseURLFallsBackToConfiguredValue() {
        withUserDefaultsSuite { defaults in
            let resolved = AuthService.resolveBaseURL(
                configuredBaseURL: "https://configured.example.com/",
                environment: [:],
                userDefaults: defaults
            )

            XCTAssertEqual(resolved, "https://configured.example.com")
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
