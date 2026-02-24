import XCTest
@testable import VellumAssistantLib

@MainActor
final class SettingsStoreOverrideResolutionTests: XCTestCase {

    // Each test manipulates UserDefaults keys that the override resolution
    // reads. Clean up after each test to avoid cross-contamination.
    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: "iosPairingGatewayOverride")
        UserDefaults.standard.removeObject(forKey: "iosPairingTokenOverride")
        super.tearDown()
    }

    // MARK: - iOS Gateway URL

    func testIosGatewayReturnsOverrideWhenNonEmpty() {
        UserDefaults.standard.set("https://custom.example.com", forKey: "iosPairingGatewayOverride")

        let store = SettingsStore()
        store.ingressPublicBaseUrl = "https://global.example.com"

        XCTAssertEqual(store.resolvedIosGatewayUrl, "https://custom.example.com")
    }

    func testIosGatewayFallsBackToGlobalWhenOverrideEmpty() {
        UserDefaults.standard.set("", forKey: "iosPairingGatewayOverride")

        let store = SettingsStore()
        store.ingressPublicBaseUrl = "https://global.example.com"

        XCTAssertEqual(store.resolvedIosGatewayUrl, "https://global.example.com")
    }

    func testIosGatewayFallsBackToGlobalWhenOverrideWhitespaceOnly() {
        UserDefaults.standard.set("   ", forKey: "iosPairingGatewayOverride")

        let store = SettingsStore()
        store.ingressPublicBaseUrl = "https://global.example.com"

        XCTAssertEqual(store.resolvedIosGatewayUrl, "https://global.example.com")
    }

    func testIosGatewayFallsBackToGlobalWhenOverrideAbsent() {
        // No override key set at all
        let store = SettingsStore()
        store.ingressPublicBaseUrl = "https://global.example.com"

        XCTAssertEqual(store.resolvedIosGatewayUrl, "https://global.example.com")
    }
}
