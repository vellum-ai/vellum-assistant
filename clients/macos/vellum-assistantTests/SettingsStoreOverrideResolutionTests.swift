import XCTest
@testable import VellumAssistantLib

@MainActor
final class SettingsStoreOverrideResolutionTests: XCTestCase {

    // Each test manipulates UserDefaults keys that the override resolution
    // reads. Clean up after each test to avoid cross-contamination.
    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: "iosPairingUseOverride")
        UserDefaults.standard.removeObject(forKey: "iosPairingGatewayOverride")
        UserDefaults.standard.removeObject(forKey: "iosPairingTokenOverride")
        UserDefaults.standard.removeObject(forKey: "ingressUseOverride")
        UserDefaults.standard.removeObject(forKey: "ingressGatewayOverride")
        super.tearDown()
    }

    // MARK: - iOS Gateway URL

    func testIosGatewayReturnsGlobalWhenOverrideOff() {
        UserDefaults.standard.set(false, forKey: "iosPairingUseOverride")
        UserDefaults.standard.set("https://custom.example.com", forKey: "iosPairingGatewayOverride")

        let store = SettingsStore()
        // Simulate global URL being set via IPC response
        store.ingressPublicBaseUrl = "https://global.example.com"

        XCTAssertEqual(store.resolvedIosGatewayUrl, "https://global.example.com")
    }

    func testIosGatewayReturnsOverrideWhenOverrideOn() {
        UserDefaults.standard.set(true, forKey: "iosPairingUseOverride")
        UserDefaults.standard.set("https://custom.example.com", forKey: "iosPairingGatewayOverride")

        let store = SettingsStore()
        store.ingressPublicBaseUrl = "https://global.example.com"

        XCTAssertEqual(store.resolvedIosGatewayUrl, "https://custom.example.com")
    }

    func testIosGatewayFallsBackToGlobalWhenOverrideOnButEmpty() {
        UserDefaults.standard.set(true, forKey: "iosPairingUseOverride")
        UserDefaults.standard.set("", forKey: "iosPairingGatewayOverride")

        let store = SettingsStore()
        store.ingressPublicBaseUrl = "https://global.example.com"

        XCTAssertEqual(store.resolvedIosGatewayUrl, "https://global.example.com")
    }

    func testIosGatewayFallsBackToGlobalWhenOverrideOnAndWhitespaceOnly() {
        UserDefaults.standard.set(true, forKey: "iosPairingUseOverride")
        UserDefaults.standard.set("   ", forKey: "iosPairingGatewayOverride")

        let store = SettingsStore()
        store.ingressPublicBaseUrl = "https://global.example.com"

        XCTAssertEqual(store.resolvedIosGatewayUrl, "https://global.example.com")
    }

    // MARK: - Ingress Gateway URL

    func testIngressGatewayReturnsGlobalWhenOverrideOff() {
        UserDefaults.standard.set(false, forKey: "ingressUseOverride")
        UserDefaults.standard.set("https://custom-ingress.example.com", forKey: "ingressGatewayOverride")

        let store = SettingsStore()
        store.ingressPublicBaseUrl = "https://global.example.com"

        XCTAssertEqual(store.resolvedIngressGatewayUrl, "https://global.example.com")
    }

    func testIngressGatewayReturnsOverrideWhenOverrideOn() {
        UserDefaults.standard.set(true, forKey: "ingressUseOverride")
        UserDefaults.standard.set("https://custom-ingress.example.com", forKey: "ingressGatewayOverride")

        let store = SettingsStore()
        store.ingressPublicBaseUrl = "https://global.example.com"

        XCTAssertEqual(store.resolvedIngressGatewayUrl, "https://custom-ingress.example.com")
    }

    func testIngressGatewayFallsBackToGlobalWhenOverrideOnButEmpty() {
        UserDefaults.standard.set(true, forKey: "ingressUseOverride")
        UserDefaults.standard.set("", forKey: "ingressGatewayOverride")

        let store = SettingsStore()
        store.ingressPublicBaseUrl = "https://global.example.com"

        XCTAssertEqual(store.resolvedIngressGatewayUrl, "https://global.example.com")
    }
}
