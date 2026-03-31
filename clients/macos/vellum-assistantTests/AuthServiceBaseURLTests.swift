import XCTest
@testable import VellumAssistantShared

@MainActor
final class AuthServiceBaseURLTests: XCTestCase {
    func testResolveBaseURLPrefersEnvironmentOverride() {
        withUserDefaultsSuite { defaults in
            defaults.set("https://defaults.example.com/", forKey: "authServiceBaseURL")

            let resolved = AuthService.resolveBaseURL(
                environment: ["VELLUM_PLATFORM_URL": "https://env.example.com/"],
                userDefaults: defaults
            )

            XCTAssertEqual(resolved, "https://env.example.com")
        }
    }

    func testResolveBaseURLFallsBackToDefault() {
        withUserDefaultsSuite { defaults in
            let resolved = AuthService.resolveBaseURL(
                environment: [:],
                userDefaults: defaults
            )

            #if DEBUG
            XCTAssertEqual(resolved, "http://localhost:8000")
            #else
            XCTAssertEqual(resolved, "https://platform.vellum.ai")
            #endif
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
