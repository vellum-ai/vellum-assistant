import XCTest

@testable import VellumAssistantLib
@testable import VellumAssistantShared

// SharedAppsLoader now delegates to AppsClient (gateway-backed).
// Integration-level tests for the gateway path live in AppsClient tests.
// This file is kept as a placeholder for any future SharedAppsLoader-specific
// logic that may be added on top of the raw client call.

@MainActor
final class SharedAppsLoaderTests: XCTestCase {
    func testLoaderTypeExists() {
        // Smoke test: SharedAppsLoader is still accessible from the macOS target.
        _ = SharedAppsLoader.self
    }
}
